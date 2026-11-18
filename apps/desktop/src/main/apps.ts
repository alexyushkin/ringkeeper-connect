// Connecting the user's AI apps: first-run setup, moving newly found
// connections in, and Restore. Talks to the apps' files only through
// @ringkeeper/hostconfig, which does the careful editing.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { runtimesPresent, type BundledRuntimes, type ClientStore, type Logger } from "@ringkeeper/gateway";
import {
  HOST_LABELS,
  HostManager,
  Ledger,
  SOURCE_LABELS,
  isHostId,
  mapEntry,
  readHostConfig,
  systemRoots,
  type Candidate,
  type HostEvent,
  type HostId,
  type LaunchCommand,
  type Roots,
  appForClientName,
  appStatus,
} from "@ringkeeper/hostconfig";
import { readJson, writeJsonAtomic } from "@ringkeeper/gateway";
import { catalog, findService } from "@ringkeeper/catalog";
import { temporaryHost, type ClientView, type ConnectionInput } from "@ringkeeper/gateway";
import { AppStartWatcher } from "./app-processes.js";
import { ensureBridgeCopy } from "./bridge-copy.js";
import type { HostView } from "../shared/api.js";
import type { Cipher } from "@ringkeeper/gateway";
import type { FoundConnection, ImportScan, SetupOutcome, SetupRequest } from "../shared/api.js";

export class AppsError extends Error {}

/**
 * How AI apps start the bridge. A packaged build ships its own Node (M4);
 * a development run uses the Node on this computer.
 */
/**
 * The Node and uv shipped with the app: resources/runtimes in a packaged
 * build, apps/desktop/runtimes/<platform>-<arch> in development (fetched by
 * scripts/fetch-runtimes.mjs). Missing folders are simply left out.
 */
export function bundledRuntimes(opts: { packaged: boolean; resourcesPath: string; appDir: string }): BundledRuntimes {
  const base = opts.packaged ? join(opts.resourcesPath, "runtimes") : join(opts.appDir, "runtimes", `${process.platform}-${process.arch}`);
  const rt: BundledRuntimes = { nodeDir: join(base, "node"), uvDir: join(base, "uv") };
  const present = runtimesPresent(rt);
  return { nodeDir: present.node ? rt.nodeDir : undefined, uvDir: present.uv ? rt.uvDir : undefined };
}

export function bridgeLaunch(opts: {
  packaged: boolean;
  resourcesPath: string;
  distDir: string;
  dataDirOverride?: string;
  runtimes?: BundledRuntimes;
  /** Run the bridge from a copy in this folder, outside the install folder (see bridge-copy.ts). */
  copyTo?: string;
  warn?: (msg: string) => void;
}): LaunchCommand {
  const env = opts.dataDirOverride ? { RINGKEEPER_DATA_DIR: opts.dataDirOverride } : undefined;
  const bridge = opts.packaged ? join(opts.resourcesPath, "bridge.mjs") : join(opts.distDir, "bridge.mjs");
  if (opts.runtimes?.nodeDir) {
    const node = process.platform === "win32" ? join(opts.runtimes.nodeDir, "node.exe") : join(opts.runtimes.nodeDir, "bin", "node");
    if (opts.copyTo) {
      try {
        const copy = ensureBridgeCopy({ node, bridge }, opts.copyTo);
        return { command: copy.node, args: [copy.bridge], env };
      } catch (err) {
        // Still works from the install folder; only updates will interrupt it.
        opts.warn?.(`bridge copy failed: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
      }
    }
    return { command: node, args: [bridge], env };
  }
  if (opts.packaged) {
    throw new AppsError("Ringkeeper Connect is missing a part it needs to connect your AI apps. Reinstall Ringkeeper Connect.");
  }
  let node = "";
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["node"], { encoding: "utf8" });
    node = out.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  } catch {
    node = "";
  }
  if (!node || !fs.existsSync(node)) {
    throw new AppsError("Ringkeeper Connect couldn't find the program it needs to connect your AI apps. Reinstall Ringkeeper Connect.");
  }
  return { command: node, args: [join(opts.distDir, "bridge.mjs")], env };
}

/**
 * The real user folders, or (development only) a fake one, so the setup can
 * be tried without touching the developer's own AI apps.
 */
function rootsForThisRun(): Roots {
  const fake = process.env.RINGKEEPER_FAKE_HOME;
  if (!fake) return systemRoots();
  return { platform: process.platform, home: fake, appData: join(fake, "AppData", "Roaming"), localAppData: join(fake, "AppData", "Local") };
}

const RESTART_HINT: Record<HostId, string> = {
  "claude-desktop": "Claude Desktop: quit it from its icon near the clock (or the menu bar on a Mac), then open it again.",
  cursor: "Cursor: if it's open, close and reopen it.",
  "claude-code": "Claude Code: select any session, new or existing, in the Claude app's Code tab. In a terminal, start claude again.",
  vscode: "VS Code: reload the window (Ctrl+Shift+P, then Developer: Reload Window) or restart it. Copilot CLI picks it up in a new session.",
  kiro: "Kiro: it picks up the change by itself; if not, restart Kiro.",
  antigravity: "Antigravity: restart it (in the command-line tool, type /mcp to reload).",
  codex: "Codex / ChatGPT: restart the ChatGPT desktop app or the Codex extension, or start a new Codex session. ChatGPT uses Ringkeeper Connect only in Codex, not in regular chats.",
};

/** Plain steps to check that an AI app really uses Ringkeeper. */
export const HOW_TO_CHECK: Record<HostId, string[]> = {
  "claude-desktop": [
    "Quit Claude Desktop completely: right-click its icon near the clock (on a Mac, the menu bar) and choose Quit. Closing the window isn't enough.",
    "Open Claude Desktop again and wait a few seconds. This page turns to Connected when it contacts Ringkeeper Connect.",
    "Still not connected? In Claude Desktop, open Settings > Desktop app > Extensions > Edit config. The file that opens should mention \"ringkeeper-connect\". If it doesn't, choose Fix here and restart Claude Desktop again.",
  ],
  cursor: [
    "Quit Cursor completely and open it again.",
    "In Cursor, open Settings > MCP (Tools & Integrations). \"ringkeeper-connect\" should be listed and switched on.",
    "If it's switched off, switch it on. This page turns to Connected within a few seconds.",
  ],
  "claude-code": [
    "In the Claude app's Code tab, select any session, new or existing. In a terminal, start claude again (a session already open there keeps its old settings).",
    "Type /mcp. \"ringkeeper-connect\" should be listed as connected.",
    "This page turns to Connected as soon as a session uses it.",
  ],
  vscode: [
    "Reload VS Code: press Ctrl+Shift+P (Cmd+Shift+P on a Mac), type Reload Window, and press Enter.",
    "Open Copilot Chat in Agent mode and click the tools icon. \"ringkeeper-connect\" should be listed; start it if asked.",
    "This page turns to Connected once VS Code uses it.",
  ],
  kiro: [
    "In Kiro, open the Kiro panel and look under MCP Servers. \"ringkeeper-connect\" should be listed and running.",
    "If it isn't, restart Kiro.",
    "This page turns to Connected once Kiro uses it.",
  ],
  antigravity: [
    "Restart Antigravity. In the command-line tool, type /mcp to reload instead.",
    "Open Antigravity's MCP servers list: \"ringkeeper-connect\" should be there.",
    "This page turns to Connected once Antigravity uses it.",
  ],
  codex: [
    "ChatGPT uses Ringkeeper Connect only in Codex, not in regular chats.",
    "Restart the ChatGPT desktop app (or the Codex extension in your editor), then open Codex. In the command-line tool, start a new session.",
    "In Codex, type /mcp: \"ringkeeper-connect\" should be listed. This page turns to Connected once Codex uses it.",
  ],
};

/**
 * What to tell the user about something that happened to an app's settings,
 * or null to say nothing. Every event is logged either way.
 */
export function hostEventMessage(e: HostEvent): { title: string; body: string } | null {
  const app = HOST_LABELS[e.host];
  switch (e.kind) {
    case "found":
      return { title: `New connection found in ${app}`, body: `"${e.name}" was added to ${app}. Open Ringkeeper Connect to choose which client it belongs to.` };
    case "reconnected":
      // Already fixed, nothing for the user to do. Typically Claude Desktop, open since before the
      // setup, saving its settings from its old copy; the app's status says if a restart is still needed.
      return null;
    case "moved":
      return {
        title: `${app} now uses the right settings`,
        body: `${app} reads its settings from a different place than before, so Ringkeeper Connect moved its entry there and undid its changes in the old one. Restart ${app} to finish.`,
      };
    case "lost":
      // Usually the app was open during the setup and keeps saving its old settings. For apps whose
      // closing Ringkeeper can see, it puts the entry back as soon as the app is closed.
      return WATCHED_APPS.includes(e.host as WatchedApp)
        ? {
            title: `Restart ${app} to finish`,
            body: `${app} keeps saving its old settings, which leaves out Ringkeeper Connect. Quit ${app} completely and open it again: Ringkeeper Connect puts itself back as soon as ${app} is closed.`,
          }
        : {
            title: `${app} keeps disconnecting`,
            body: `${app} keeps removing Ringkeeper Connect from its settings. Quit ${app} completely, then choose Connect next to it in Ringkeeper Connect and open ${app} again.`,
          };
  }
}

/** Apps whose running and closing Ringkeeper can see (see app-processes.ts). */
const WATCHED_APPS = ["claude-desktop", "cursor"] as const;
type WatchedApp = (typeof WATCHED_APPS)[number];
/** How often to look at running apps: normally, and while waiting for an app Ringkeeper gave up on to close. */
const NORMAL_CHECK_MS = 20_000;
const GIVEN_UP_CHECK_MS = 3_000;

export class AppsService {
  readonly manager: HostManager;
  private readonly ledger: Ledger;
  private found: FoundConnection[] = [];
  /** Last time each app's bridge contacted us (ms). Kept across restarts. */
  private contacts: Partial<Record<HostId, number>>;
  private readonly contactsFile: string;
  private readonly starts: AppStartWatcher;
  /** Candidates from the last scan, so setup uses exactly what the user saw. */
  private lastScan = new Map<string, Candidate>();

  constructor(
    private readonly opts: {
      dataDir: string;
      cipher: Cipher;
      store: ClientStore;
      launch: () => LaunchCommand;
      onChange: () => void;
      notify: (title: string, body: string) => void;
      log?: Logger;
    },
  ) {
    this.ledger = new Ledger(opts.dataDir, opts.cipher);
    this.contactsFile = join(opts.dataDir, "app-contacts.json");
    this.contacts = readJson<Partial<Record<HostId, number>>>(this.contactsFile) ?? {};
    this.starts = new AppStartWatcher(() => {
      this.afterAppsStartedOrClosed();
      opts.onChange();
    });
    this.manager = new HostManager({
      roots: rootsForThisRun(),
      ledger: this.ledger,
      launch: opts.launch,
      ctx: { env: process.env, home: homedir(), pathSeparator: sep },
      onEvent: (e) => this.onEvent(e),
    });
  }

  start(): void {
    // An app may read a different file than the one we set up (e.g. Claude
    // Desktop's newer Claude-Data folder): move our entry there first.
    this.manager.migrateMoved();
    this.refreshEntries();
    this.manager.watch();
    this.starts.start();
  }

  /**
   * Keep each set-up app's Ringkeeper entry pointing at this copy of the app
   * (it may have been moved or updated). Only writes when the entry differs.
   */
  private refreshEntries(): void {
    const present = this.manager.views().filter((h) => h.status === "entry_present").map((h) => h.id);
    for (const r of this.manager.connect(present, [])) {
      if (!r.ok) console.warn(r.error);
    }
  }

  stop(): void {
    this.manager.stop();
    this.starts.stop();
  }

  /** The bridge of some app contacted us: remember it, by app. */
  recordContact(contact: { app?: string; hostName?: string; at: number }): void {
    // The app's own name wins: VS Code may start Ringkeeper from Claude Desktop's settings.
    const id = appForClientName(contact.hostName) ?? (contact.app && isHostId(contact.app) ? contact.app : undefined);
    if (!id) return;
    this.contacts[id] = contact.at;
    try {
      writeJsonAtomic(this.contactsFile, this.contacts, 0o644);
    } catch {
      // Only affects the status shown; never fatal.
    }
    // Statuses depend on contact: refresh the window and tray.
    this.opts.onChange();
  }

  /** Each app with whether it really uses Ringkeeper (see appStatus). */
  hosts(): HostView[] {
    const now = Date.now();
    const starts = this.starts.times;
    return this.manager.views().map((v) => ({
      id: v.id,
      label: v.label,
      status: appStatus(v, this.contacts[v.id], v.id === "claude-desktop" || v.id === "cursor" ? starts[v.id] : undefined, now),
      problem: v.problem,
      note: v.note,
      configPath: v.configPath,
      otherConnections: v.otherConnections,
      lastContactAt: this.contacts[v.id],
      howToCheck: HOW_TO_CHECK[v.id],
      optIn: v.optIn,
      ...(v.via ? { viaLabel: HOST_LABELS[v.via] } : {}),
    }));
  }

  /** Put our entry back after the app removed it (with a backup, like every change). */
  fixApp(host: HostId): void {
    const r = this.manager.connect([host], [])[0];
    if (!r || !r.ok) throw new AppsError(r?.error ?? `${HOST_LABELS[host]} isn't installed.`);
    this.opts.onChange();
  }

  configPathOf(host: HostId): string {
    return this.manager.locations().find((l) => l.id === host)!.configPath;
  }

  pendingFound(): FoundConnection[] {
    return [...this.found];
  }

  private onEvent(e: HostEvent): void {
    if (e.kind === "found" && !this.found.some((f) => f.host === e.host && f.name === e.name)) {
      this.found.push({ host: e.host, hostLabel: HOST_LABELS[e.host], name: e.name });
    }
    this.opts.log?.({ ev: "host_event", ...e });
    const message = hostEventMessage(e);
    if (message) this.opts.notify(message.title, message.body);
    // Gave up on an app: look often, so a quick restart of it isn't missed.
    if (e.kind === "lost") this.starts.setPace(GIVEN_UP_CHECK_MS);
    this.opts.onChange();
  }

  /** Watched apps seen running at the last look. */
  private wasRunning: Partial<Record<WatchedApp, number>> = {};

  /**
   * An app Ringkeeper gave up on was just closed: put its entry back now, when
   * the app can't overwrite it, so it's there when the app opens again. Only on
   * a seen close (running, then not), never just because no app was found.
   */
  private afterAppsStartedOrClosed(): void {
    const now = this.starts.times;
    for (const id of WATCHED_APPS) {
      if (this.wasRunning[id] !== undefined && now[id] === undefined && this.manager.givenUp().includes(id)) {
        this.manager.restoreWhileClosed(id);
      }
    }
    this.wasRunning = { ...now };
    if (!this.manager.givenUp().some((id) => (WATCHED_APPS as readonly string[]).includes(id))) this.starts.setPace(NORMAL_CHECK_MS);
  }

  scan(): ImportScan {
    const { candidates, seen } = this.manager.scan();
    this.lastScan = new Map(candidates.map((c) => [c.key, c]));
    const clients = this.opts.store.list();
    return {
      hosts: this.hosts(),
      candidates: candidates.map((c) => {
        const inClients = whereAlready(c.input, c.name, clients);
        return {
          key: c.key,
          name: c.name,
          from: [...new Set(c.sources.map((s) => SOURCE_LABELS[s.host]))],
          service: c.service?.label,
          problem: c.problem,
          warnings: [
            ...c.warnings,
            ...(c.sources.every((s) => !isHostId(s.host))
              ? [`It will stay in ${[...new Set(c.sources.map((s) => SOURCE_LABELS[s.host]))].join(" and ")} too: Ringkeeper Connect only reads that app's settings.`]
              : []),
            ...addressWarnings(c.input),
          ],
          inClients,
        };
      }),
      clientTools: Object.fromEntries(clients.map((cl) => [cl.id, catalogToolsIn(cl)])),
      sources: seen.map((s) => ({ label: s.label, count: s.count, problems: s.problems })),
      extensions: this.manager.desktopExtensions().map((e) => {
        const tool = e.service ? findService(e.service.id) : undefined;
        return { name: e.name, ...(tool ? { toolId: tool.id, toolName: tool.name } : {}) };
      }),
    };
  }

  /**
   * First-run setup: add the chosen connections to a client, then point every
   * installed app at Ringkeeper and take those connections out of the apps.
   * If an app can't be changed, the connections that came only from it are
   * removed from the client again, so nothing shows up twice.
   */
  setup(req: SetupRequest): SetupOutcome {
    const store = this.opts.store;
    const clientId = "id" in req.client ? req.client.id : store.addClient(req.client.newName).id;
    const chosen = req.take.map((k) => this.lastScan.get(k)).filter((c): c is Candidate => !!c && !!c.input);

    const added: Array<{ cand: Candidate; connId: string }> = [];
    const problems: string[] = [];
    for (const cand of chosen) {
      try {
        added.push({ cand, connId: store.addConnection(clientId, withSignIn(cand.input!)).id });
      } catch (err) {
        problems.push(`${cand.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Only the apps the user ticked (the newer ones are opt-in), and only if they can be read.
    const wanted = new Set(req.hosts ?? []);
    const installed = this.manager
      .views()
      .filter((h) => wanted.has(h.id) && h.status !== "not_installed" && h.status !== "unreadable")
      .map((h) => h.id);
    // Connections from apps we only read from are copied, never taken out of them.
    const take = added.flatMap((a) => a.cand.sources).filter((s) => isHostId(s.host));
    const results = this.manager.connect(installed, take);
    const failedHosts = new Set(results.filter((r) => !r.ok).map((r) => r.host));
    for (const r of results) if (!r.ok && r.error) problems.push(r.error);

    for (const a of added) {
      if (a.cand.sources.every((s) => isHostId(s.host) && failedHosts.has(s.host))) store.removeConnection(clientId, a.connId);
    }
    // Remember what the user chose to leave in the apps, so the watcher doesn't ask about it.
    const takenKeys = new Set(added.map((a) => a.cand.key));
    for (const cand of this.lastScan.values()) {
      if (!takenKeys.has(cand.key)) for (const s of cand.sources) if (isHostId(s.host)) this.manager.ignore(s.host, s.name);
    }

    // Tools picked from Claude Desktop extensions or web connectors: added next, with a sign-in or key.
    const pickedTools = [...new Set(req.tools ?? [])].filter((t) => findService(t));
    const pending = (store.settings.pendingTools ?? []).filter((p) => !(p.clientId === clientId && pickedTools.includes(p.toolId)));
    store.updateSettings({ setupDone: true, pendingTools: [...pending, ...pickedTools.map((toolId) => ({ clientId, toolId }))] });
    const connected = results.filter((r) => r.ok).map((r) => r.host);
    this.opts.onChange();
    return {
      imported: added.filter((a) => !a.cand.sources.every((s) => isHostId(s.host) && failedHosts.has(s.host))).map((a) => a.cand.name),
      problems,
      restart: connected.map((h) => RESTART_HINT[h]),
      overlaps: this.overlapWarnings(added.map((a) => a.cand)),
      clientId,
      pendingTools: pickedTools,
    };
  }

  /** Warn about built-in connectors or extensions for the same services as the client's. */
  private overlapWarnings(cands: Candidate[]): string[] {
    const services = new Map<string, string>();
    for (const c of cands) if (c.service) services.set(c.service.id, c.service.label);
    if (!services.size) return [];
    const warnings: string[] = [];
    for (const ext of this.manager.desktopExtensions()) {
      if (ext.service && services.has(ext.service.id)) {
        warnings.push(
          `You also have the "${ext.name}" extension in Claude Desktop. Claude might use it, and your own ${ext.service.label} account, instead of your client's. Turn it off in Claude Desktop under Settings > Extensions, or keep it only for your own work.`,
        );
      }
    }
    const list = [...services.values()].join(", ");
    warnings.push(
      `If you've also connected ${list} directly in Claude (Settings > Connectors) or in Cursor, the AI might use your own account instead of your client's. Turn those off, or keep them only for your own work.`,
    );
    return warnings;
  }

  skipSetup(): void {
    this.opts.store.updateSettings({ setupDone: true });
  }

  connectApp(host: HostId): string[] {
    const r = this.manager.connect([host], [])[0];
    if (!r || !r.ok) throw new AppsError(r?.error ?? `${HOST_LABELS[host]} isn't installed.`);
    this.opts.onChange();
    return [RESTART_HINT[host]];
  }

  /** Move a connection found in an app into a client. */
  moveFound(host: HostId, name: string, clientId: string): void {
    const loc = this.manager.locations().find((l) => l.id === host)!;
    const r = readHostConfig(loc.configPath, loc.format);
    const value = r.status === "ok" ? r.servers[name] : undefined;
    if (value === undefined) {
      this.dropFound(host, name);
      throw new AppsError(`"${name}" isn't in ${HOST_LABELS[host]} anymore.`);
    }
    const mapped = mapEntry(name, value, host, { env: process.env, home: homedir(), pathSeparator: sep });
    if (!mapped.input) throw new AppsError(mapped.problem ?? `"${name}" can't be brought in.`);
    const conn = this.opts.store.addConnection(clientId, withSignIn(mapped.input));
    const res = this.manager.moveIn(host, name);
    if (!res.ok) {
      this.opts.store.removeConnection(clientId, conn.id);
      throw new AppsError(res.error ?? `Couldn't change ${HOST_LABELS[host]}'s settings.`);
    }
    this.dropFound(host, name);
  }

  leaveFound(host: HostId, name: string): void {
    this.manager.ignore(host, name);
    this.dropFound(host, name);
  }

  private dropFound(host: HostId, name: string): void {
    this.found = this.found.filter((f) => !(f.host === host && f.name === name));
    this.opts.onChange();
  }

  restore(): { restored: string[]; problems: string[] } {
    const results = this.manager.restoreAll();
    this.found = [];
    this.opts.onChange();
    return {
      restored: results.filter((r) => r.ok).map((r) => HOST_LABELS[r.host]),
      problems: results.filter((r) => !r.ok).map((r) => r.error!),
    };
  }
}

/**
 * A web connection brought in from another app with no key: that app signed in
 * to it itself, and the sign-in can't be copied. When the address is a catalog
 * tool that uses sign-in (Linear, Notion...), mark it so Ringkeeper offers
 * "Sign in" instead of saying the key was refused. Others are left as they are.
 */
export function withSignIn(input: ConnectionInput): ConnectionInput {
  if (input.kind !== "remote" || input.auth || input.fields.length) return input;
  let origin: string;
  try {
    origin = new URL(input.url).origin;
  } catch {
    return input;
  }
  const signsIn = catalog.services.some((s) =>
    s.options.some((o) => {
      if (o.kind !== "remote" || o.auth !== "oauth" || o.url.includes("{{")) return false;
      try {
        return new URL(o.url).origin === origin;
      } catch {
        return false;
      }
    }),
  );
  return signsIn ? { ...input, auth: "oauth" } : input;
}

function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Which clients already have a connection found in an AI app: one with the
 * same name, or set up the same way (same address, or same program). `same`
 * says whether it's set up the same way. Exported for tests.
 */
export function whereAlready(input: ConnectionInput | undefined, name: string, clients: ClientView[]): Array<{ clientId: string; clientName: string; same: boolean }> {
  const out: Array<{ clientId: string; clientName: string; same: boolean }> = [];
  for (const cl of clients) {
    let found = false;
    let same = false;
    for (const conn of cl.connections) {
      const sameSetup =
        !!input &&
        input.kind === conn.kind &&
        (input.kind === "remote"
          ? conn.kind === "remote" && sameUrl(input.url, conn.url)
          : conn.kind === "local" && input.command === conn.command && JSON.stringify(input.args) === JSON.stringify(conn.args));
      if (sameSetup) same = true;
      if (sameSetup || conn.name.toLowerCase() === name.toLowerCase()) found = true;
    }
    if (found) out.push({ clientId: cl.id, clientName: cl.name, same });
  }
  return out;
}

/** Warnings about a found connection's web address. Exported for tests. */
export function addressWarnings(input: ConnectionInput | undefined): string[] {
  if (input?.kind !== "remote") return [];
  const host = temporaryHost(input.url);
  return host ? [`Its web address (${host}) is temporary and may have changed since. If it doesn't work, ask whoever runs it for the current address.`] : [];
}

/** The catalog tools a client already has, by name or by the tool's own address. Exported for tests. */
export function catalogToolsIn(client: ClientView): string[] {
  const hostOf = (u: string) => {
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      return "";
    }
  };
  return catalog.services
    .filter((s) =>
      client.connections.some(
        (conn) =>
          conn.name.toLowerCase() === s.name.toLowerCase() ||
          s.options.some((o) => {
            if (o.kind === "remote") return conn.kind === "remote" && !o.url.includes("{{") && hostOf(o.url) === hostOf(conn.url);
            const pkg = o.args.find((a) => !a.startsWith("-") && !a.includes("{{") && !a.includes("${"));
            return conn.kind === "local" && !!pkg && conn.args.includes(pkg);
          }),
      ),
    )
    .map((s) => s.id);
}
