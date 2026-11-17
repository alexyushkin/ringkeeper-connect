// Connects AI apps to Ringkeeper Connect, moves connections in, watches for
// new ones, and puts everything back on Restore.
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parse } from "jsonc-parser";
import { editHostConfig, readHostConfig, writeAtomic, HostConfigError, type Change, type ServerMap } from "./config-file.js";
import { HOST_LABELS, locateHosts, type HostId, type HostLocation, type Roots } from "./hosts.js";
import { RINGKEEPER_ENTRY, buildCandidates, type Candidate, type FoundEntry, type MapContext } from "./import.js";
import type { Ledger } from "./ledger.js";

/** How AI apps start the bridge. */
export interface LaunchCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * What the app's settings file says. Whether the app actually uses us is
 * decided by the desktop app, from contact with the bridge.
 * - entry_present: our entry is in the file
 * - entry_missing: we set the app up before, but our entry is gone (the app rewrote its file)
 * - not_connected: never set up
 */
export type HostStatus = "not_installed" | "not_connected" | "entry_present" | "entry_missing" | "unreadable";

export interface HostView {
  id: HostId;
  label: string;
  status: HostStatus;
  /** Plain-language reason when unreadable. */
  problem?: string;
  /** Connections still set up directly in the app (not through Ringkeeper). */
  otherConnections: string[];
  /** The settings file in use. */
  configPath: string;
  /** Plain-language note about which file was chosen, when there was a choice. */
  note?: string;
  /** When our entry was last added or changed meaningfully (ms), if known. */
  entryWrittenAt?: number;
}

export type HostMove = { host: HostId; from: string; to: string; ok: boolean; error?: string };

/** What makes the app start a different program: a change here needs the app to restart. */
function entryEssence(entry: unknown): string {
  const e = (entry ?? {}) as { command?: unknown; args?: unknown };
  return JSON.stringify([e.command ?? null, e.args ?? null]);
}

export type HostEvent =
  | { kind: "found"; host: HostId; name: string }
  | { kind: "reconnected"; host: HostId }
  | { kind: "lost"; host: HostId }
  | { kind: "moved"; host: HostId; from: string; to: string };

export interface HostResult {
  host: HostId;
  ok: boolean;
  error?: string;
  taken: FoundEntry[];
}

const REPAIR_WINDOW_MS = 2 * 60_000;
const MAX_REPAIRS_IN_WINDOW = 3;

export class HostManager {
  private known = new Map<HostId, Set<string>>();
  private repairs = new Map<HostId, number[]>();
  private gaveUp = new Set<HostId>();
  private watched: string[] = [];

  constructor(
    private readonly opts: {
      roots: Roots;
      ledger: Ledger;
      launch: () => LaunchCommand;
      ctx: MapContext;
      onEvent?: (e: HostEvent) => void;
    },
  ) {}

  locations(): HostLocation[] {
    return locateHosts(this.opts.roots);
  }

  private location(id: HostId): HostLocation {
    return this.locations().find((l) => l.id === id)!;
  }

  /** The entry an app needs to reach Ringkeeper Connect. */
  entryFor(loc: HostLocation): Record<string, unknown> {
    const l = this.opts.launch();
    // RINGKEEPER_APP tells the bridge which app launched it, so Ringkeeper
    // knows that app really uses it (not just that its settings mention it).
    return {
      ...(loc.entryStyle === "typed" ? { type: "stdio" } : {}),
      command: l.command,
      args: l.args,
      env: { ...(l.env ?? {}), RINGKEEPER_APP: loc.id },
    };
  }

  views(): HostView[] {
    return this.locations().map((loc) => {
      const ledger = this.opts.ledger.host(loc.id);
      const base = {
        id: loc.id,
        label: loc.label,
        configPath: loc.configPath,
        ...(loc.note ? { note: loc.note } : {}),
        ...(ledger?.entryWrittenAt ? { entryWrittenAt: ledger.entryWrittenAt } : {}),
      };
      if (!loc.installed && !loc.exists) return { ...base, status: "not_installed" as const, otherConnections: [] };
      const r = readHostConfig(loc.configPath);
      if (r.status === "unreadable") {
        return { ...base, status: "unreadable" as const, problem: `Ringkeeper Connect can't read ${loc.label}'s settings: ${r.reason}.`, otherConnections: [] };
      }
      const servers = r.status === "ok" ? r.servers : {};
      const others = Object.keys(servers).filter((n) => n !== RINGKEEPER_ENTRY);
      const status = RINGKEEPER_ENTRY in servers ? "entry_present" : ledger ? "entry_missing" : "not_connected";
      return { ...base, status: status as HostStatus, otherConnections: others };
    });
  }

  /** Everything the wizard could bring in, merged across apps. */
  scan(): { candidates: Candidate[]; unreadable: HostView[] } {
    const found: FoundEntry[] = [];
    const unreadable: HostView[] = [];
    for (const v of this.views()) {
      if (v.status === "unreadable") unreadable.push(v);
      if (v.status === "not_installed" || v.status === "unreadable") continue;
      const r = readHostConfig(this.location(v.id).configPath);
      if (r.status !== "ok") continue;
      for (const [name, value] of Object.entries(r.servers)) {
        if (name !== RINGKEEPER_ENTRY) found.push({ host: v.id, name, value });
      }
    }
    return { candidates: buildCandidates(found, this.opts.ctx), unreadable };
  }

  /** Edit one app's file with backups and a ledger record. */
  private edit(loc: HostLocation, plan: (servers: ServerMap) => Change[], taken: (servers: ServerMap) => FoundEntry[]): HostResult {
    let lastTaken: FoundEntry[] = [];
    let entryChanged = false;
    try {
      const res = editHostConfig(
        loc.configPath,
        (servers) => {
          lastTaken = taken(servers);
          const changes = plan(servers);
          const ours = changes.find((c) => c.op === "set" && c.name === RINGKEEPER_ENTRY);
          entryChanged = !!ours && ours.op === "set" && entryEssence(servers[RINGKEEPER_ENTRY]) !== entryEssence(ours.value);
          return changes;
        },
        { createIfMissing: true, onBeforeWrite: (before) => this.opts.ledger.beforeWrite(loc.id, loc.configPath, before) },
      );
      if (res.changed) {
        this.opts.ledger.afterWrite(loc.id, res.after, lastTaken.map((t) => ({ name: t.name, value: t.value })), entryChanged);
      }
      this.known.set(loc.id, new Set(Object.keys(readServers(loc.configPath))));
      return { host: loc.id, ok: true, taken: lastTaken };
    } catch (err) {
      const msg = err instanceof HostConfigError ? err.message : `Couldn't save ${loc.label}'s settings. Nothing was changed.`;
      return { host: loc.id, ok: false, error: `${loc.label}: ${msg}`, taken: [] };
    }
  }

  /**
   * Point apps at Ringkeeper Connect, taking the chosen connections out of
   * them (the caller adds those to a client).
   */
  connect(hosts: HostId[], take: Array<{ host: HostId; name: string }>): HostResult[] {
    const results: HostResult[] = [];
    for (const id of hosts) {
      const loc = this.location(id);
      if (!loc.installed && !loc.exists) continue;
      const mine = new Set(take.filter((t) => t.host === id).map((t) => t.name));
      const entry = this.entryFor(loc);
      results.push(
        this.edit(
          loc,
          (servers) => {
            const changes: Change[] = [...mine].filter((n) => n in servers).map((name) => ({ op: "remove" as const, name }));
            if (!isDeepStrictEqual(servers[RINGKEEPER_ENTRY], entry)) changes.push({ op: "set", name: RINGKEEPER_ENTRY, value: entry });
            return changes;
          },
          (servers) => [...mine].filter((n) => n in servers).map((name) => ({ host: id, name, value: servers[name] })),
        ),
      );
      this.gaveUp.delete(id);
    }
    return results;
  }

  /** Move one connection out of an app (after the user picked a client for it). */
  moveIn(host: HostId, name: string): HostResult {
    return this.connect([host], [{ host, name }])[0] ?? { host, ok: false, error: "That app isn't installed.", taken: [] };
  }

  /** Leave a connection in the app and stop asking about it. */
  ignore(host: HostId, name: string): void {
    this.opts.ledger.ignore(host, name);
  }

  /**
   * If Ringkeeper set an app up in a file the app doesn't actually read (for
   * example the classic Claude Desktop file, when a newer build reads its
   * Claude-Data copy), undo our changes there (with a backup) and add our
   * entry to the file the app does read.
   */
  migrateMoved(): HostMove[] {
    const moves: HostMove[] = [];
    for (const id of this.opts.ledger.hosts()) {
      const h = this.opts.ledger.host(id)!;
      const loc = this.location(id);
      if (h.path === loc.configPath || !loc.installed) continue;
      // Never leave the app with no entry at all: check the new file first.
      if (readHostConfig(loc.configPath).status === "unreadable") {
        moves.push({
          host: id,
          from: h.path,
          to: loc.configPath,
          ok: false,
          error:
            `${HOST_LABELS[id]}: its settings file can't be read, so Ringkeeper Connect didn't change anything. ` +
            (id === "claude-desktop"
              ? "Open it from Claude Desktop (Settings > Desktop app > Extensions > Edit config), fix it, then restart Ringkeeper Connect."
              : "Fix it, then restart Ringkeeper Connect."),
        });
        continue;
      }
      const undo = this.restore(id);
      if (!undo.ok) {
        moves.push({ host: id, from: h.path, to: loc.configPath, ok: false, error: undo.error });
        continue;
      }
      const done = this.connect([id], [])[0];
      const ok = !!done?.ok;
      moves.push({ host: id, from: h.path, to: loc.configPath, ok, ...(ok ? {} : { error: done?.error }) });
      if (ok) this.opts.onEvent?.({ kind: "moved", host: id, from: h.path, to: loc.configPath });
    }
    return moves;
  }

  /** Put every app's settings back the way they were before Ringkeeper Connect. */
  restoreAll(): Array<{ host: HostId; ok: boolean; error?: string }> {
    return this.opts.ledger.hosts().map((id) => this.restore(id));
  }

  restore(id: HostId): { host: HostId; ok: boolean; error?: string } {
    const h = this.opts.ledger.host(id);
    if (!h) return { host: id, ok: true };
    const label = HOST_LABELS[id];
    try {
      const current = readHostConfig(h.path);
      const currentText = current.status === "ok" ? current.text : null;
      const originalServers = h.originalText === null ? {} : parseServers(h.originalText);
      const everythingTakenWasThere = h.taken.every((t) => isDeepStrictEqual(originalServers[t.name], t.value));

      if ((currentText !== null && currentText === h.lastWrittenText && everythingTakenWasThere) || current.status === "unreadable") {
        // Untouched since our last change (or broken by the app): put the exact original bytes back.
        this.opts.ledger.beforeWrite(id, h.path, currentText);
        if (h.originalText === null) fs.rmSync(h.path, { force: true });
        else writeAtomic(h.path, h.originalText);
      } else if (current.status === "missing" && h.originalText !== null) {
        writeAtomic(h.path, h.originalText);
      } else if (current.status === "ok") {
        // The app changed other things since: undo only what we did.
        editHostConfig(
          h.path,
          (servers) => {
            const changes: Change[] = [];
            if (RINGKEEPER_ENTRY in servers) changes.push({ op: "remove", name: RINGKEEPER_ENTRY });
            for (const t of h.taken) if (!(t.name in servers)) changes.push({ op: "set", name: t.name, value: t.value });
            return changes;
          },
          { onBeforeWrite: (before) => this.opts.ledger.beforeWrite(id, h.path, before) },
        );
      }
      this.opts.ledger.forgetHost(id);
      this.known.delete(id);
      return { host: id, ok: true };
    } catch (err) {
      const msg = err instanceof HostConfigError ? err.message : "Couldn't save its settings.";
      return { host: id, ok: false, error: `${label}: ${msg} Your backup is still kept, so you can try again.` };
    }
  }

  // ---------- watching ----------

  watch(intervalMs = 1500): void {
    this.stop();
    for (const loc of this.locations()) {
      this.known.set(loc.id, new Set(Object.keys(readServers(loc.configPath))));
      fs.watchFile(loc.configPath, { interval: intervalMs }, () => this.check(loc.id));
      this.watched.push(loc.configPath);
    }
  }

  stop(): void {
    for (const p of this.watched) fs.unwatchFile(p);
    this.watched = [];
  }

  /** Look at an app's file after it changed. Public for tests. */
  check(id: HostId, now = Date.now()): void {
    const loc = this.location(id);
    const r = readHostConfig(loc.configPath);
    if (r.status === "unreadable") return; // the app may be mid-write; look again next time
    const ledgerHost = this.opts.ledger.host(id);
    if (r.status === "ok" && ledgerHost && r.text === ledgerHost.lastWrittenText) return; // our own write
    const servers = r.status === "ok" ? r.servers : {};

    // The app dropped us (some Claude Desktop versions rewrite the whole file): put us back, but don't fight it forever.
    if (ledgerHost && !(RINGKEEPER_ENTRY in servers) && !this.gaveUp.has(id)) {
      const recent = (this.repairs.get(id) ?? []).filter((t) => now - t < REPAIR_WINDOW_MS);
      if (recent.length >= MAX_REPAIRS_IN_WINDOW) {
        this.gaveUp.add(id);
        this.opts.onEvent?.({ kind: "lost", host: id });
      } else {
        recent.push(now);
        this.repairs.set(id, recent);
        const res = this.connect([id], []);
        if (res[0]?.ok) this.opts.onEvent?.({ kind: "reconnected", host: id });
      }
    }

    const before = this.known.get(id) ?? new Set<string>();
    const nowNames = new Set(Object.keys(readServers(loc.configPath)));
    for (const name of nowNames) {
      if (name === RINGKEEPER_ENTRY || before.has(name) || this.opts.ledger.isIgnored(id, name)) continue;
      // Only ask about apps Ringkeeper is connected to; otherwise the user hasn't set us up there.
      if (ledgerHost) this.opts.onEvent?.({ kind: "found", host: id, name });
    }
    this.known.set(id, nowNames);
  }
}

function readServers(path: string): ServerMap {
  const r = readHostConfig(path);
  return r.status === "ok" ? r.servers : {};
}

/** Servers in a file's text; tolerant of comments, like the apps themselves (Cursor allows them). */
function parseServers(text: string): ServerMap {
  const parsed = parse(text.replace(/^﻿/, ""), [], { allowTrailingComma: true, disallowComments: false }) as { mcpServers?: ServerMap } | undefined;
  return parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers ? parsed.mcpServers : {};
}
