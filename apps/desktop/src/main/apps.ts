// Connecting the user's AI apps: first-run setup, moving newly found
// connections in, and Restore. Talks to the apps' files only through
// @ringkeeper/hostconfig, which does the careful editing.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { runtimesPresent, type BundledRuntimes, type ClientStore } from "@ringkeeper/gateway";
import {
  HOST_LABELS,
  HostManager,
  Ledger,
  listDesktopExtensions,
  mapEntry,
  readHostConfig,
  systemRoots,
  type Candidate,
  type HostEvent,
  type HostId,
  type LaunchCommand,
  type Roots,
} from "@ringkeeper/hostconfig";
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
}): LaunchCommand {
  const env = opts.dataDirOverride ? { RINGKEEPER_DATA_DIR: opts.dataDirOverride } : undefined;
  const bridge = opts.packaged ? join(opts.resourcesPath, "bridge.mjs") : join(opts.distDir, "bridge.mjs");
  if (opts.runtimes?.nodeDir) {
    const node = process.platform === "win32" ? join(opts.runtimes.nodeDir, "node.exe") : join(opts.runtimes.nodeDir, "bin", "node");
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
  "claude-code": "Claude Code: new sessions pick it up automatically.",
};

export class AppsService {
  readonly manager: HostManager;
  private readonly ledger: Ledger;
  private found: FoundConnection[] = [];
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
    },
  ) {
    this.ledger = new Ledger(opts.dataDir, opts.cipher);
    this.manager = new HostManager({
      roots: rootsForThisRun(),
      ledger: this.ledger,
      launch: opts.launch,
      ctx: { env: process.env, home: homedir(), pathSeparator: sep },
      onEvent: (e) => this.onEvent(e),
    });
  }

  start(): void {
    this.refreshEntries();
    this.manager.watch();
  }

  /**
   * Keep each connected app's Ringkeeper entry pointing at this copy of the
   * app (it may have been moved, or updated to a new place). Only writes when
   * the entry actually differs.
   */
  private refreshEntries(): void {
    const connected = this.hosts().filter((h) => h.status === "connected").map((h) => h.id);
    for (const r of this.manager.connect(connected, [])) {
      if (!r.ok) console.warn(r.error);
    }
  }

  stop(): void {
    this.manager.stop();
  }

  hosts() {
    return this.manager.views();
  }

  pendingFound(): FoundConnection[] {
    return [...this.found];
  }

  private onEvent(e: HostEvent): void {
    const app = HOST_LABELS[e.host];
    if (e.kind === "found") {
      if (!this.found.some((f) => f.host === e.host && f.name === e.name)) {
        this.found.push({ host: e.host, hostLabel: app, name: e.name });
      }
      this.opts.notify(`New connection found in ${app}`, `"${e.name}" was added to ${app}. Open Ringkeeper Connect to choose which client it belongs to.`);
    } else if (e.kind === "reconnected") {
      this.opts.notify(
        `${app} was reconnected`,
        `${app} removed Ringkeeper Connect from its settings, so it was put back. If your clients' tools are missing, restart ${app}.`,
      );
    } else {
      this.opts.notify(
        `${app} keeps disconnecting`,
        `${app} keeps removing Ringkeeper Connect from its settings. Open Ringkeeper Connect and choose Connect next to ${app}.`,
      );
    }
    this.opts.onChange();
  }

  scan(): ImportScan {
    const { candidates } = this.manager.scan();
    this.lastScan = new Map(candidates.map((c) => [c.key, c]));
    return {
      hosts: this.hosts(),
      candidates: candidates.map((c) => ({
        key: c.key,
        name: c.name,
        from: [...new Set(c.sources.map((s) => HOST_LABELS[s.host]))],
        service: c.service?.label,
        problem: c.problem,
        warnings: c.warnings,
      })),
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
        added.push({ cand, connId: store.addConnection(clientId, cand.input!).id });
      } catch (err) {
        problems.push(`${cand.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const installed = this.hosts().filter((h) => h.status === "connected" || h.status === "not_connected").map((h) => h.id);
    const take = added.flatMap((a) => a.cand.sources);
    const results = this.manager.connect(installed, take);
    const failedHosts = new Set(results.filter((r) => !r.ok).map((r) => r.host));
    for (const r of results) if (!r.ok && r.error) problems.push(r.error);

    for (const a of added) {
      if (a.cand.sources.every((s) => failedHosts.has(s.host))) store.removeConnection(clientId, a.connId);
    }
    // Remember what the user chose to leave in the apps, so the watcher doesn't ask about it.
    const takenKeys = new Set(added.map((a) => a.cand.key));
    for (const cand of this.lastScan.values()) {
      if (!takenKeys.has(cand.key)) for (const s of cand.sources) this.manager.ignore(s.host, s.name);
    }

    store.updateSettings({ setupDone: true });
    const connected = results.filter((r) => r.ok).map((r) => r.host);
    this.opts.onChange();
    return {
      imported: added.filter((a) => !a.cand.sources.every((s) => failedHosts.has(s.host))).map((a) => a.cand.name),
      problems,
      restart: connected.map((h) => RESTART_HINT[h]),
      overlaps: this.overlapWarnings(added.map((a) => a.cand)),
    };
  }

  /** Warn about built-in connectors or extensions for the same services as the client's. */
  private overlapWarnings(cands: Candidate[]): string[] {
    const services = new Map<string, string>();
    for (const c of cands) if (c.service) services.set(c.service.id, c.service.label);
    if (!services.size) return [];
    const warnings: string[] = [];
    const desktop = this.manager.locations().find((l) => l.id === "claude-desktop");
    for (const ext of desktop ? listDesktopExtensions(desktop.configPath) : []) {
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
    const r = readHostConfig(loc.configPath);
    const value = r.status === "ok" ? r.servers[name] : undefined;
    if (value === undefined) {
      this.dropFound(host, name);
      throw new AppsError(`"${name}" isn't in ${HOST_LABELS[host]} anymore.`);
    }
    const mapped = mapEntry(name, value, host, { env: process.env, home: homedir(), pathSeparator: sep });
    if (!mapped.input) throw new AppsError(mapped.problem ?? `"${name}" can't be brought in.`);
    const conn = this.opts.store.addConnection(clientId, mapped.input);
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
