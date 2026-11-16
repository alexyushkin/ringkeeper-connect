// Config editing can break the user's other apps, so every path is tested
// here against files shaped like the real ones.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findNodeAtLocation, parseTree } from "jsonc-parser";
import type { Cipher } from "../packages/gateway/src/store/secrets.js";
import {
  HostConfigError,
  HostManager,
  Ledger,
  RINGKEEPER_ENTRY,
  buildCandidates,
  detectService,
  editHostConfig,
  listDesktopExtensions,
  locateHosts,
  mapEntry,
  readHostConfig,
  type HostEvent,
  type MapContext,
  type Roots,
} from "../packages/hostconfig/src/index.js";
import { claudeCode, claudeDesktop, claudeDesktopCrlfBom, cursorWithComments } from "./fixtures/host-configs.js";

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = fs.mkdtempSync(join(tmpdir(), "rk-hosts-"));
  dirs.push(d);
  return d;
}

/** A fake Windows user profile with the three apps' files. */
function machine(opts: { desktop?: string | null; cursor?: string | null; code?: string | null; cursorInstalled?: boolean } = {}) {
  const root = tempDir();
  const home = join(root, "home");
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
  fs.mkdirSync(join(appData, "Claude"), { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  const paths = {
    desktop: join(appData, "Claude", "claude_desktop_config.json"),
    cursor: join(home, ".cursor", "mcp.json"),
    code: join(home, ".claude.json"),
  };
  if (opts.desktop !== null) fs.writeFileSync(paths.desktop, opts.desktop ?? claudeDesktop);
  if (opts.cursorInstalled !== false) fs.mkdirSync(join(home, ".cursor"), { recursive: true });
  if (opts.cursor) fs.writeFileSync(paths.cursor, opts.cursor);
  if (opts.code !== null) fs.writeFileSync(paths.code, opts.code ?? claudeCode);
  const roots: Roots = { platform: "win32", home, appData, localAppData };
  const ctx: MapContext = { env: { NOTION_TOKEN: "secret_notion_123456789abcdef", GITHUB_PAT: "ghp_fake1234567890abcdefghij" }, home, pathSeparator: "\\" };
  const events: HostEvent[] = [];
  const ledger = new Ledger(join(root, "data"), cipher);
  const manager = new HostManager({
    roots,
    ledger,
    ctx,
    launch: () => ({ command: "C:\\Program Files\\Ringkeeper Connect\\node.exe", args: ["C:\\Program Files\\Ringkeeper Connect\\bridge.mjs"] }),
    onEvent: (e) => events.push(e),
  });
  const read = (p: string) => fs.readFileSync(p, "utf8");
  return { root, home, roots, ctx, paths, ledger, manager, events, read, dataDir: join(root, "data") };
}

/** Everything outside the top-level "mcpServers" must stay byte-for-byte the same. */
function outsideServers(text: string): string {
  const body = text.replace(/^﻿/, "");
  const node = findNodeAtLocation(parseTree(body)!, ["mcpServers"])!.parent!; // the "mcpServers": {...} property
  return body.slice(0, node.offset) + "<servers>" + body.slice(node.offset + node.length);
}

describe("finding the apps' settings", () => {
  it("uses the usual Claude Desktop file, Cursor's and Claude Code's", () => {
    const m = machine();
    const locs = locateHosts(m.roots);
    expect(locs.map((l) => [l.id, l.configPath, l.installed])).toEqual([
      ["claude-desktop", m.paths.desktop, true],
      ["cursor", m.paths.cursor, true],
      ["claude-code", m.paths.code, true],
    ]);
  });

  it("prefers the Windows Store copy of Claude Desktop's settings when it exists, because that's the one the app reads", () => {
    const m = machine();
    const store = join(m.home, "AppData", "Local", "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude");
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(join(store, "claude_desktop_config.json"), "{}");
    expect(locateHosts(m.roots)[0]!.configPath).toBe(join(store, "claude_desktop_config.json"));
  });

  it("follows CLAUDE_CONFIG_DIR for Claude Code", () => {
    const m = machine();
    expect(locateHosts({ ...m.roots, claudeConfigDir: join(m.home, "cc") })[2]!.configPath).toBe(join(m.home, "cc", ".claude.json"));
  });

  it("knows when an app isn't installed", () => {
    const m = machine({ cursorInstalled: false });
    expect(locateHosts(m.roots)[1]).toMatchObject({ id: "cursor", installed: false, exists: false });
  });
});

describe("editing a settings file", () => {
  it("changes only the connections and keeps every other byte, indent and the missing trailing newline", () => {
    const m = machine();
    editHostConfig(m.paths.code, () => [
      { op: "remove", name: "n8n" },
      { op: "set", name: RINGKEEPER_ENTRY, value: { type: "stdio", command: "node", args: ["bridge.mjs"] } },
    ]);
    const after = m.read(m.paths.code);
    expect(outsideServers(after)).toBe(outsideServers(claudeCode));
    expect(after.endsWith("}")).toBe(true);
    const parsed = JSON.parse(after);
    expect(Object.keys(parsed.mcpServers)).toEqual(["github", "legacy", "socket", RINGKEEPER_ENTRY]);
    expect(parsed.projects["C:/Users/pat/Documents/GitHub/site"].mcpServers["project-only"]).toBeDefined();
  });

  it("keeps Windows line endings and the byte-order mark", () => {
    const m = machine({ desktop: claudeDesktopCrlfBom });
    editHostConfig(m.paths.desktop, () => [{ op: "set", name: RINGKEEPER_ENTRY, value: { command: "node", args: [] } }]);
    const after = m.read(m.paths.desktop);
    expect(after.startsWith("\uFEFF")).toBe(true);
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("keeps comments in files that have them", () => {
    const m = machine({ cursor: cursorWithComments });
    editHostConfig(m.paths.cursor, () => [{ op: "remove", name: "airtable" }]);
    expect(m.read(m.paths.cursor)).toContain("// Pat's tools");
    expect(readHostConfig(m.paths.cursor)).toMatchObject({ status: "ok" });
  });

  it("leaves a broken file alone and says why", () => {
    const m = machine({ desktop: '{ "mcpServers": { "x": ' });
    expect(readHostConfig(m.paths.desktop)).toMatchObject({ status: "unreadable" });
    expect(() => editHostConfig(m.paths.desktop, () => [{ op: "remove", name: "x" }])).toThrow(HostConfigError);
    expect(m.read(m.paths.desktop)).toBe('{ "mcpServers": { "x": ');
  });

  it("leaves a file alone when its connections aren't a list of named entries", () => {
    const m = machine({ desktop: '{ "mcpServers": [1, 2] }' });
    expect(readHostConfig(m.paths.desktop)).toMatchObject({ status: "unreadable" });
    expect(() => editHostConfig(m.paths.desktop, () => [{ op: "set", name: "a", value: {} }])).toThrow(HostConfigError);
  });

  it("creates the file when the app is installed but has no settings yet", () => {
    const m = machine();
    editHostConfig(m.paths.cursor, () => [{ op: "set", name: RINGKEEPER_ENTRY, value: { type: "stdio", command: "node", args: [] } }], {
      createIfMissing: true,
    });
    expect(JSON.parse(m.read(m.paths.cursor))).toEqual({ mcpServers: { [RINGKEEPER_ENTRY]: { type: "stdio", command: "node", args: [] } } });
  });

  it("starts over on the app's new version if the app rewrites the file meanwhile", () => {
    const m = machine();
    let runs = 0;
    editHostConfig(m.paths.desktop, (servers) => {
      if (runs++ === 0) {
        // Claude Desktop saves a preference while we're working.
        fs.writeFileSync(m.paths.desktop, claudeDesktop.replace('"sidebarMode": "chat"', '"sidebarMode": "code"'));
      }
      return "playwright" in servers ? [{ op: "remove", name: "playwright" }] : [];
    });
    expect(runs).toBe(2);
    const after = JSON.parse(m.read(m.paths.desktop));
    expect(after.preferences.sidebarMode).toBe("code");
    expect(after.mcpServers.playwright).toBeUndefined();
  });
});

describe("bringing connections in", () => {
  it("turns an app's program entry into a connection, and recognises keys", () => {
    const m = machine();
    const r = mapEntry("n8n", JSON.parse(claudeDesktop).mcpServers.n8n, "claude-desktop", m.ctx);
    expect(r.input).toEqual({
      kind: "local",
      name: "n8n",
      command: "npx",
      args: ["-y", "n8n-mcp"],
      fields: [
        { name: "N8N_API_URL", value: "https://acme.app.n8n.cloud", secret: false },
        { name: "N8N_API_KEY", value: "n8n_api_fake1234567890abcdef", secret: true },
      ],
    });
    expect(r.service).toEqual({ id: "n8n", label: "n8n" });
  });

  it("fills in Cursor's ${env:…} values, and flags what can't be filled in", () => {
    const m = machine();
    const servers = { notion: { url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer ${env:NOTION_TOKEN}" } } };
    const ok = mapEntry("notion", servers.notion, "cursor", m.ctx);
    expect(ok.input).toMatchObject({ kind: "remote", url: "https://mcp.notion.com/mcp", fields: [{ name: "Authorization", value: "Bearer secret_notion_123456789abcdef", secret: true }] });
    const missing = mapEntry("notion", servers.notion, "cursor", { ...m.ctx, env: {} });
    expect(missing.input?.fields).toEqual([{ name: "Authorization", secret: true }]);
    expect(missing.warnings.join(" ")).toMatch(/needs Authorization/);
    const project = mapEntry("repo-tool", { command: "node", args: ["${workspaceFolder}/tools/server.js"] }, "cursor", m.ctx);
    expect(project.problem).toBe("repo-tool only works inside a project in Cursor, so it was left there.");
  });

  it("understands Claude Code's ${VAR:-default}, older SSE servers and unsupported kinds", () => {
    const m = machine();
    const servers = JSON.parse(claudeCode).mcpServers;
    expect(mapEntry("legacy", servers.legacy, "claude-code", m.ctx).input).toMatchObject({
      kind: "remote",
      url: "https://legacy.example.com/sse",
      transport: "sse",
    });
    expect(mapEntry("socket", servers.socket, "claude-code", m.ctx).problem).toMatch(/doesn't support yet/);
    expect(mapEntry("github", servers.github, "claude-code", m.ctx).input?.fields[0]).toEqual({
      name: "Authorization",
      value: "Bearer ghp_fake1234567890abcdefghij",
      secret: true,
    });
  });

  it("merges the same connection found in two apps, and keeps same-named different ones apart", () => {
    const m = machine();
    const desktop = JSON.parse(claudeDesktop).mcpServers;
    const code = JSON.parse(claudeCode).mcpServers;
    const cands = buildCandidates(
      [
        { host: "claude-desktop", name: "n8n", value: desktop.n8n },
        { host: "claude-code", name: "n8n", value: code.n8n },
        { host: "claude-code", name: "playwright", value: { command: "other" } },
        { host: "claude-desktop", name: "playwright", value: desktop.playwright },
        { host: "claude-code", name: RINGKEEPER_ENTRY, value: {} },
      ],
      m.ctx,
    );
    expect(cands.map((c) => [c.name, c.sources.map((s) => s.host)])).toEqual([
      ["n8n", ["claude-desktop", "claude-code"]],
      ["playwright", ["claude-code"]],
      ["playwright (Claude Desktop)", ["claude-desktop"]],
    ]);
  });

  it("recognises common services", () => {
    expect(detectService("my-tools", { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"] })?.id).toBe("notion");
    expect(detectService("crm", { url: "https://mcp.airtable.com/mcp" })?.id).toBe("airtable");
    expect(detectService("files", { command: "node" })).toBeUndefined();
  });
});

describe("connecting apps and restoring them", () => {
  it("swaps the chosen connections for Ringkeeper in each app, without touching anything else", () => {
    const m = machine({ cursor: cursorWithComments });
    const results = m.manager.connect(
      ["claude-desktop", "cursor", "claude-code"],
      [
        { host: "claude-desktop", name: "n8n" },
        { host: "cursor", name: "airtable" },
        { host: "claude-code", name: "n8n" },
      ],
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.find((r) => r.host === "claude-desktop")!.taken.map((t) => t.name)).toEqual(["n8n"]);

    const desktop = JSON.parse(m.read(m.paths.desktop));
    expect(Object.keys(desktop.mcpServers)).toEqual(["playwright", RINGKEEPER_ENTRY]);
    expect(desktop.mcpServers[RINGKEEPER_ENTRY]).toEqual({
      command: "C:\\Program Files\\Ringkeeper Connect\\node.exe",
      args: ["C:\\Program Files\\Ringkeeper Connect\\bridge.mjs"],
    });
    expect(outsideServers(m.read(m.paths.desktop))).toBe(outsideServers(claudeDesktop));
    // Cursor and Claude Code want the type spelled out.
    expect(JSON.parse(m.read(m.paths.code)).mcpServers[RINGKEEPER_ENTRY].type).toBe("stdio");
    expect(m.manager.views().map((v) => v.status)).toEqual(["connected", "connected", "connected"]);
  });

  it("keeps its records and backups encrypted, since they contain keys", () => {
    const m = machine();
    m.manager.connect(["claude-desktop"], [{ host: "claude-desktop", name: "n8n" }]);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d)) {
        const p = join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else files.push(fs.readFileSync(p, "latin1"));
      }
    };
    walk(m.dataDir);
    expect(files.length).toBeGreaterThanOrEqual(2); // the ledger and at least one backup
    expect(files.join("")).not.toContain("n8n_api_fake1234567890abcdef");
    expect(m.ledger.readBackup("claude-desktop", m.ledger.listBackups("claude-desktop")[0]!)).toBe(claudeDesktop);
  });

  it("Restore puts every untouched file back byte for byte, and removes files Ringkeeper created", () => {
    const m = machine({ desktop: claudeDesktopCrlfBom });
    m.manager.connect(["claude-desktop", "cursor", "claude-code"], [
      { host: "claude-desktop", name: "n8n" },
      { host: "claude-code", name: "github" },
    ]);
    expect(fs.existsSync(m.paths.cursor)).toBe(true);
    const results = m.manager.restoreAll();
    expect(results.every((r) => r.ok)).toBe(true);
    expect(m.read(m.paths.desktop)).toBe(claudeDesktopCrlfBom);
    expect(m.read(m.paths.code)).toBe(claudeCode);
    expect(fs.existsSync(m.paths.cursor)).toBe(false);
    expect(m.ledger.hosts()).toEqual([]);
  });

  it("Restore puts a file with comments back byte for byte too", () => {
    const m = machine({ cursor: cursorWithComments });
    m.manager.connect(["cursor"], [{ host: "cursor", name: "airtable" }]);
    m.manager.restoreAll();
    expect(m.read(m.paths.cursor)).toBe(cursorWithComments);
  });

  it("Restore after the app changed things undoes only what Ringkeeper did", () => {
    const m = machine();
    m.manager.connect(["claude-desktop"], [{ host: "claude-desktop", name: "n8n" }]);
    // Later, the user changes a preference and adds a connection of their own in Claude Desktop.
    const changed = JSON.parse(m.read(m.paths.desktop));
    changed.preferences.sidebarMode = "code";
    changed.mcpServers.mine = { command: "my-tool" };
    fs.writeFileSync(m.paths.desktop, JSON.stringify(changed, null, 2));

    m.manager.restoreAll();
    const after = JSON.parse(m.read(m.paths.desktop));
    expect(after.preferences.sidebarMode).toBe("code");
    expect(after.mcpServers.mine).toEqual({ command: "my-tool" });
    expect(after.mcpServers.n8n).toEqual(JSON.parse(claudeDesktop).mcpServers.n8n);
    expect(after.mcpServers[RINGKEEPER_ENTRY]).toBeUndefined();
  });

  it("Restore brings back connections moved in later, too", () => {
    const m = machine();
    m.manager.connect(["claude-desktop"], []);
    const added = JSON.parse(m.read(m.paths.desktop));
    added.mcpServers.later = { command: "later-tool", env: { LATER_TOKEN: "abc" } };
    fs.writeFileSync(m.paths.desktop, JSON.stringify(added, null, 2));
    m.manager.moveIn("claude-desktop", "later");
    expect(JSON.parse(m.read(m.paths.desktop)).mcpServers.later).toBeUndefined();

    m.manager.restoreAll();
    const after = JSON.parse(m.read(m.paths.desktop));
    expect(after.mcpServers.later).toEqual({ command: "later-tool", env: { LATER_TOKEN: "abc" } });
    expect(after.mcpServers[RINGKEEPER_ENTRY]).toBeUndefined();
  });

  it("Restore fixes a file the app broke by putting the original back", () => {
    const m = machine();
    m.manager.connect(["claude-desktop"], [{ host: "claude-desktop", name: "n8n" }]);
    fs.writeFileSync(m.paths.desktop, '{"mcpServers": {');
    m.manager.restoreAll();
    expect(m.read(m.paths.desktop)).toBe(claudeDesktop);
  });

  it("skips apps that aren't installed", () => {
    const m = machine({ cursorInstalled: false });
    const results = m.manager.connect(["claude-desktop", "cursor", "claude-code"], []);
    expect(results.map((r) => r.host)).toEqual(["claude-desktop", "claude-code"]);
    expect(fs.existsSync(m.paths.cursor)).toBe(false);
    expect(m.manager.views()[1]!.status).toBe("not_installed");
  });
});

describe("watching the apps", () => {
  it("asks about a connection added in a connected app, but not about ignored ones or its own changes", () => {
    const m = machine();
    m.manager.connect(["claude-desktop"], [{ host: "claude-desktop", name: "n8n" }]);
    m.manager.watch(60_000);
    m.manager.check("claude-desktop"); // its own write
    expect(m.events).toEqual([]);

    const cfg = JSON.parse(m.read(m.paths.desktop));
    cfg.mcpServers.airtable = { command: "npx", args: ["-y", "airtable-mcp-server"] };
    cfg.mcpServers.keepme = { command: "x" };
    m.ledger.ignore("claude-desktop", "keepme");
    fs.writeFileSync(m.paths.desktop, JSON.stringify(cfg, null, 2));
    m.manager.check("claude-desktop");
    m.manager.stop();
    expect(m.events).toEqual([{ kind: "found", host: "claude-desktop", name: "airtable" }]);
  });

  it("doesn't ask about apps Ringkeeper isn't connected to", () => {
    const m = machine();
    m.manager.watch(60_000);
    const cfg = JSON.parse(m.read(m.paths.desktop));
    cfg.mcpServers.airtable = { command: "npx" };
    fs.writeFileSync(m.paths.desktop, JSON.stringify(cfg, null, 2));
    m.manager.check("claude-desktop");
    m.manager.stop();
    expect(m.events).toEqual([]);
  });

  it("puts Ringkeeper back if the app drops it, but stops after a few tries and says so", () => {
    const m = machine();
    m.manager.connect(["claude-desktop"], []);
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) {
      // Claude Desktop rewrites the whole file without us.
      fs.writeFileSync(m.paths.desktop, claudeDesktop);
      m.manager.check("claude-desktop", t0 + i * 1000);
    }
    expect(m.events.map((e) => e.kind)).toEqual(["reconnected", "reconnected", "reconnected", "lost"]);
    expect(RINGKEEPER_ENTRY in JSON.parse(m.read(m.paths.desktop)).mcpServers).toBe(false);
  });
});

describe("Claude Desktop extensions", () => {
  it("lists installed extensions, skipping Claude's own backup copies, and spots their service", () => {
    const m = machine();
    const ext = join(m.home, "AppData", "Roaming", "Claude", "Claude Extensions");
    for (const [id, manifest] of [
      ["ant.dir.gh.airtable.airtable-mcp", { name: "airtable-mcp", display_name: "Airtable" }],
      ["ant.dir.gh.x.files", { name: "files" }],
      ["ant.dir.gh.x.files.backup-1777595284636", { name: "files" }],
    ] as const) {
      fs.mkdirSync(join(ext, id), { recursive: true });
      fs.writeFileSync(join(ext, id, "manifest.json"), JSON.stringify(manifest));
    }
    const list = listDesktopExtensions(m.paths.desktop);
    expect(list.map((e) => [e.name, e.service?.id])).toEqual([
      ["Airtable", "airtable"],
      ["files", undefined],
    ]);
  });
});
