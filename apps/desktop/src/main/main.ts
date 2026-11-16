// Ringkeeper Connect's main process: owns the clients and keys, runs the
// gateway that AI apps connect to, and keeps a tray menu for switching clients.
import fs from "node:fs";
import { join } from "node:path";
import { BrowserWindow, Menu, Notification, Tray, app, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, shell } from "electron";
import {
  ClientStore,
  Gateway,
  SecretStorageUnavailableError,
  SecretStore,
  StoreError,
  secretOAuthStore,
  dataFiles,
  fileLogger,
  loadOrCreateInstallSettings,
  readRuntimeInfo,
  resolveDataDir,
  writeJsonAtomic,
  type Cipher,
  type LaunchInfo,
  type RuntimeInfo,
  type SwitchSource,
} from "@ringkeeper/gateway";
import { HostConfigError } from "@ringkeeper/hostconfig";
import { IPC, type ApiMethod, type AppState, type Result } from "../shared/api.js";
import { AppsError, AppsService, bridgeLaunch, bundledRuntimes } from "./apps.js";
import { CatalogActionError, CatalogActions } from "./catalog.js";
import { Updates } from "./updates.js";

const dataDir = resolveDataDir();
const files = dataFiles(dataDir);
// Keep Electron's own files (including the key safeStorage depends on) in a
// fixed place, so saved keys stay readable across versions.
app.setPath("userData", join(dataDir, "electron"));
// Windows only shows notifications for a registered app id; an unpackaged dev
// run is registered under its executable path.
app.setAppUserModelId(app.isPackaged ? "com.ringkeeper.connect" : process.execPath);

const startedInBackground = process.argv.includes("--background");
// The window follows the system theme. For screenshots and testing, RINGKEEPER_THEME=light|dark overrides it.
if (process.env.RINGKEEPER_THEME === "light" || process.env.RINGKEEPER_THEME === "dark") nativeTheme.themeSource = process.env.RINGKEEPER_THEME;
const log = fileLogger(files.log);

let store: ClientStore;
let apps: AppsService;
let catalogActions: CatalogActions;
let updates: Updates | undefined;
let gateway: Gateway;
let tray: Tray | undefined;
let window: BrowserWindow | undefined;
let quitting = false;

const cipher: Cipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b),
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    // The uninstaller asks the running app to restore the AI apps' settings.
    if (argv.includes("--restore")) {
      const r = apps?.restore();
      log({ ev: "restore_requested", restored: r?.restored, problems: r?.problems?.length });
      return;
    }
    if (!argv.includes("--background")) showWindow();
  });
  app.whenReady().then(start).catch((err) => fatal(err));
}

function fatal(err: unknown): void {
  const message = err instanceof StoreError ? err.message : `Ringkeeper Connect couldn't start: ${err instanceof Error ? err.message : String(err)}`;
  log({ ev: "fatal", error: String(err) });
  dialog.showErrorBox("Ringkeeper Connect", message);
  app.exit(1);
}

function notify(title: string, body: string): void {
  const note = new Notification({ title, body });
  note.on("click", () => showWindow());
  if (Notification.isSupported()) note.show();
}

async function start(): Promise<void> {
  const secrets = new SecretStore(files.secrets, cipher);
  store = new ClientStore(files.clients, secrets);
  const runtimes = bundledRuntimes({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appDir: join(__dirname, "..") });
  const oauthStore = secretOAuthStore(secrets);
  catalogActions = new CatalogActions({
    store,
    gateway: () => gateway,
    oauthStore,
    openExternal: (url) => void shell.openExternal(url),
    showSignInLink: (url) => window?.webContents.send(IPC.signInLink, url),
    onChange: () => scheduleRefresh(),
  });
  apps = new AppsService({
    dataDir,
    cipher,
    store,
    launch: () =>
      bridgeLaunch({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        distDir: __dirname,
        dataDirOverride: process.env.RINGKEEPER_DATA_DIR,
        runtimes,
      }),
    onChange: () => scheduleRefresh(),
    notify,
  });

  // Run by the uninstaller (M5): put the AI apps back and exit.
  if (process.argv.includes("--restore")) {
    const r = apps.restore();
    log({ ev: "restore_on_uninstall", restored: r.restored, problems: r.problems });
    app.exit(r.problems.length ? 1 : 0);
    return;
  }
  const install = loadOrCreateInstallSettings(dataDir);

  gateway = new Gateway({
    config: store.toGatewayConfig(),
    activeClientId: store.activeClientId,
    token: install.token,
    port: install.port,
    log,
    onActiveClientChanged: onSwitched,
    onStatusChanged: () => scheduleRefresh(),
    upstreamEnv: { runtimes, oauthStore },
  });
  log({ ev: "runtimes", node: !!runtimes.nodeDir, uv: !!runtimes.uvDir });
  const port = await gateway.start();

  writeJsonAtomic(files.runtime, {
    version: 1,
    port,
    token: install.token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  } satisfies RuntimeInfo);
  // Tell the bridge how to start us when an AI app opens and we're not running.
  writeJsonAtomic(files.launcher, {
    command: process.execPath,
    args: app.isPackaged ? ["--background"] : [app.getAppPath(), "--background"],
  } satisfies LaunchInfo);

  store.onChange(() => {
    gateway.applyConfig(store.toGatewayConfig(), store.activeClientId);
    applyLoginItem();
    scheduleRefresh();
  });

  registerIpc();
  createTray();
  apps.start();
  applyLoginItem();
  if (app.isPackaged) {
    updates = new Updates({ log, notify, onChange: () => scheduleRefresh() });
    updates.start();
  }
  if (!startedInBackground || !store.settings.setupDone) showWindow();
  log({ ev: "app_started", port, background: startedInBackground });
}

/**
 * Start with the computer (in the background, tray only), so AI apps can
 * reach Ringkeeper right away. Only for installed builds: a development run
 * would register the bare Electron program.
 */
function applyLoginItem(): void {
  // Test runs use their own data folder (RINGKEEPER_DATA_DIR) and must never register at login.
  if (!app.isPackaged || process.env.RINGKEEPER_DATA_DIR) return;
  const openAtLogin = store.settings.startAtLogin;
  if (app.getLoginItemSettings({ args: ["--background"] }).openAtLogin !== openAtLogin) {
    app.setLoginItemSettings({ openAtLogin, args: ["--background"] });
  }
}

/** The gateway switched clients (an AI app asked, or a client was removed). */
function onSwitched(clientId: string, source: SwitchSource): void {
  if (store.activeClientId !== clientId) store.setActiveClient(clientId);
  if (source.by === "ai") {
    const name = store.list().find((c) => c.id === clientId)?.name ?? clientId;
    const note = new Notification({
      title: `Switched to ${name}`,
      body: `${source.host} switched the active client. Every chat in Claude, Cursor and Claude Code now uses ${name}.`,
      silent: false,
    });
    note.on("show", () => log({ ev: "notification_shown", client: clientId, host: source.host }));
    note.on("failed", (_e, error) => log({ ev: "notification_failed", error }));
    note.on("click", () => showWindow());
    if (Notification.isSupported()) note.show();
    else log({ ev: "notification_unsupported" });
  }
  scheduleRefresh();
}

// ---------- window ----------

function showWindow(): void {
  if (process.platform === "darwin") void app.dock?.show();
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    title: "Ringkeeper Connect",
    icon: nativeImage.createFromPath(join(__dirname, "..", "assets", "icon.png")),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
  window.once("ready-to-show", () => window?.show());
  // Closing the window keeps Ringkeeper running in the tray; AI apps still need it.
  window.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      window?.hide();
      if (process.platform === "darwin") app.dock?.hide();
    }
  });
  // Never navigate away or open new windows from the app.
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void window.loadFile(join(__dirname, "renderer", "index.html"));
}

// ---------- tray ----------

/**
 * The Ringkeeper keyring, 16 px with a sharp 32 px version for high-DPI
 * screens. On macOS a black "template" version, which the menu bar tints.
 */
function trayIcon(): Electron.NativeImage {
  if (process.platform === "darwin") {
    const t = nativeImage.createFromPath(join(__dirname, "..", "assets", "trayTemplate.png"));
    t.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(join(__dirname, "..", "assets", "trayTemplate@2x.png")).toPNG() });
    t.setTemplateImage(true);
    return t;
  }
  const big = nativeImage.createFromPath(join(__dirname, "..", "assets", "tray@2x.png"));
  const img = big.resize({ width: 16, height: 16, quality: "best" });
  img.addRepresentation({ scaleFactor: 2, buffer: big.toPNG() });
  return img;
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip("Ringkeeper Connect");
  tray.on("click", () => (process.platform === "darwin" ? tray?.popUpContextMenu() : showWindow()));
  refreshTray();
}

const STATUS_WORDS: Record<string, string> = {
  ready: "ready",
  idle: "starts when needed",
  starting: "starting…",
  needs_key: "needs a key",
  needs_signin: "needs sign-in",
  error: "not working",
  stopped: "stopped",
};

function refreshTray(): void {
  if (!tray) return;
  const clients = store.list();
  const active = clients.find((c) => c.active);
  const statuses = gateway.connectionStatuses();
  const items: Electron.MenuItemConstructorOptions[] = [];

  items.push({ label: active ? `Working on: ${active.name}` : "No clients yet", enabled: false });
  items.push({ type: "separator" });
  if (clients.length) {
    for (const c of clients) {
      items.push({ label: c.name, type: "radio", checked: c.active, click: () => store.setActiveClient(c.id) });
    }
    items.push({ type: "separator" });
  }
  if (active) {
    if (active.connections.length === 0) items.push({ label: `${active.name} has no connections yet`, enabled: false });
    for (const conn of active.connections) {
      const s = statuses.find((x) => x.clientId === active.id && x.connectionId === conn.id);
      items.push({ label: `${conn.name}: ${STATUS_WORDS[s?.status ?? "idle"]}`, enabled: false });
    }
    items.push({ type: "separator" });
  }
  const problems = active
    ? statuses.filter((s) => s.clientId === active.id && (s.status === "error" || s.status === "needs_key" || s.status === "needs_signin")).length
    : 0;
  if (problems) items.push({ label: `Fix ${problems === 1 ? "1 connection" : `${problems} connections`}…`, click: () => showWindow() });
  items.push({ label: "Manage clients…", click: () => showWindow() });
  items.push({ type: "separator" });
  if (updates?.ready) {
    items.push({ label: `Restart to update to ${updates.ready}`, click: () => updates?.restartToUpdate() });
  } else if (updates) {
    items.push({ label: "Check for updates", click: () => updates?.check() });
  }
  if (app.isPackaged) {
    items.push({
      label: "Start when I log in",
      type: "checkbox",
      checked: store.settings.startAtLogin,
      click: (item) => store.updateSettings({ startAtLogin: item.checked }),
    });
  }
  items.push({ label: `Version ${app.getVersion()}`, enabled: false });
  items.push({ type: "separator" });
  items.push({ label: "Quit Ringkeeper Connect", click: () => quit() });

  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(active ? `Ringkeeper Connect: ${active.name}` : "Ringkeeper Connect");
}

let refreshTimer: NodeJS.Timeout | undefined;
function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    refreshTray();
    if (window && !window.isDestroyed()) window.webContents.send(IPC.state, appState());
  }, 50);
}

// ---------- IPC ----------

function appState(): AppState {
  return {
    clients: store.list(),
    statuses: gateway.connectionStatuses(),
    settings: store.settings,
    hosts: apps.hosts(),
    found: apps.pendingFound(),
    version: app.getVersion(),
    updateReady: updates?.ready,
    packaged: app.isPackaged,
    setupDone: store.settings.setupDone,
  };
}

function registerIpc(): void {
  const handlers: { [K in ApiMethod]: (...args: never[]) => unknown } = {
    addClient: (name: string) => store.addClient(name),
    renameClient: (id: string, name: string) => store.renameClient(id, name),
    removeClient: (id: string) => store.removeClient(id),
    setActiveClient: (id: string) => store.setActiveClient(id),
    addConnection: (clientId: string, input) => store.addConnection(clientId, input),
    updateConnection: (clientId: string, connId: string, input) => store.updateConnection(clientId, connId, input),
    removeConnection: (clientId: string, connId: string) => store.removeConnection(clientId, connId),
    cloneConnection: (from: string, connId: string, to: string, keys: Record<string, string>) =>
      store.cloneConnection(from, connId, to, keys),
    updateSettings: (patch) => store.updateSettings(patch),
    scanApps: () => apps.scan(),
    runSetup: (req) => apps.setup(req),
    skipSetup: () => apps.skipSetup(),
    connectApp: (host) => apps.connectApp(host),
    moveFound: (host, name: string, clientId: string) => apps.moveFound(host, name, clientId),
    leaveFound: (host, name: string) => apps.leaveFound(host, name),
    restoreApps: () => apps.restore(),
    catalogServices: () => catalogActions.services(),
    addFromCatalog: (clientId: string, serviceId: string, optionId: string, answers: Record<string, string>, name?: string) =>
      catalogActions.add(clientId, serviceId, optionId, answers, name),
    signIn: (clientId: string, connectionId: string) => catalogActions.signIn(clientId, connectionId),
    cancelSignIn: () => catalogActions.cancelSignIn(),
    openLink: (url: string) => catalogActions.openLink(url),
    restartToUpdate: () => updates?.restartToUpdate(),
  };

  ipcMain.handle(IPC.state, () => appState());
  ipcMain.handle(IPC.call, async (_e, method: ApiMethod, args: unknown[]): Promise<Result<unknown>> => {
    const fn = handlers[method] as ((...a: unknown[]) => unknown) | undefined;
    if (!fn) return { ok: false, error: "Ringkeeper Connect didn't understand that request." };
    try {
      return { ok: true, value: (await fn(...args)) ?? undefined };
    } catch (err) {
      // Store and secret errors are already written for people; anything else gets a generic line.
      const plain =
        err instanceof StoreError ||
        err instanceof SecretStorageUnavailableError ||
        err instanceof AppsError ||
        err instanceof HostConfigError ||
        err instanceof CatalogActionError
          ? err.message
          : "Something went wrong saving that. Try again, and if it keeps happening, restart Ringkeeper Connect.";
      log({ ev: "ipc_error", method, error: String(err).slice(0, 300) });
      return { ok: false, error: plain };
    }
  });
}

// ---------- quit ----------

function quit(): void {
  quitting = true;
  app.quit();
}

app.on("before-quit", () => {
  quitting = true;
});

app.on("will-quit", (e) => {
  apps?.stop();
  if (!gateway) return;
  e.preventDefault();
  const current = readRuntimeInfo(dataDir);
  if (current?.pid === process.pid) fs.rmSync(files.runtime, { force: true });
  void gateway.stop().finally(() => {
    gateway = undefined as unknown as Gateway;
    app.exit(0);
  });
});

// Stay alive in the tray when the window closes.
app.on("window-all-closed", () => {});
