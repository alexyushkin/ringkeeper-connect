// The AI apps added for the MVP: four Ringkeeper writes to (VS Code, Kiro,
// Antigravity, Codex / ChatGPT) and the ones it only reads from. Same rules as
// the first three (CLAUDE.md): only the connections are touched, every other
// byte stays, backups before each change, and Restore puts files back exactly.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import type { Cipher } from "../packages/gateway/src/store/secrets.js";
import {
  HostConfigError,
  HostManager,
  Ledger,
  RINGKEEPER_ENTRY,
  applyChanges,
  editHostConfig,
  readHostConfig,
  CODEX_TOML,
  type HostEvent,
  type MapContext,
  type Roots,
} from "../packages/hostconfig/src/index.js";
import { applyTomlChanges, splitKey } from "../packages/hostconfig/src/toml-file.js";
import { mapEntry } from "../packages/hostconfig/src/import.js";
import { appOnlyHelper } from "../packages/gateway/src/app-only.js";
import { claudeDesktop } from "./fixtures/host-configs.js";
import * as F from "./fixtures/more-hosts.js";

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const LAUNCH = { command: "C:\\Program Files\\Ringkeeper Connect\\node.exe", args: ["C:\\Program Files\\Ringkeeper Connect\\bridge.mjs"] };

/** A fake Windows user folder. Files are only written when given. */
function machine(files: Record<string, string> = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), "rk-more-"));
  dirs.push(root);
  const home = join(root, "home");
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const p = join(home, rel);
    fs.mkdirSync(join(p, ".."), { recursive: true });
    fs.writeFileSync(p, text);
  }
  const roots: Roots = { platform: "win32", home, appData, localAppData };
  const ctx: MapContext = { env: { DOCS_TOKEN: "docs_fake_token_123456789" }, home, pathSeparator: "\\" };
  const events: HostEvent[] = [];
  const ledger = new Ledger(join(root, "data"), cipher);
  const manager = new HostManager({ roots, ledger, ctx, launch: () => LAUNCH, onEvent: (e) => events.push(e) });
  const path = (rel: string) => join(home, rel);
  const read = (rel: string) => fs.readFileSync(path(rel), "utf8");
  return { home, roots, ledger, manager, events, path, read };
}

const P = {
  desktop: "AppData/Roaming/Claude/claude_desktop_config.json",
  cursor: ".cursor/mcp.json",
  copilot: ".copilot/mcp-config.json",
  vscodeSettings: "AppData/Roaming/Code/User/settings.json",
  vscodeLegacy: "AppData/Roaming/Code/User/mcp.json",
  kiro: ".kiro/settings/mcp.json",
  antigravity: ".gemini/config/mcp_config.json",
  codex: ".codex/config.toml",
};

// ---------------------------------------------------------------------------

describe("the TOML editor (Codex / ChatGPT)", () => {
  const entry = { command: LAUNCH.command, args: LAUNCH.args, env: { RINGKEEPER_APP: "codex" }, startup_timeout_sec: 30 };

  it("adds Ringkeeper as its own table at the end and leaves every other line exactly as written", () => {
    const after = applyTomlChanges(F.codexToml, [{ op: "set", name: RINGKEEPER_ENTRY, value: entry }]);
    expect(after.startsWith(F.codexToml)).toBe(true);
    const added = after.slice(F.codexToml.length);
    expect(added).toBe(
      [
        "",
        "[mcp_servers.ringkeeper-connect]",
        'command = "C:\\\\Program Files\\\\Ringkeeper Connect\\\\node.exe"',
        'args = [ "C:\\\\Program Files\\\\Ringkeeper Connect\\\\bridge.mjs" ]',
        "startup_timeout_sec = 30",
        "",
        "[mcp_servers.ringkeeper-connect.env]",
        'RINGKEEPER_APP = "codex"',
        "",
      ].join("\n"),
    );
    expect((parseToml(after) as { mcp_servers: Record<string, unknown> }).mcp_servers[RINGKEEPER_ENTRY]).toEqual(entry);
  });

  it("adding and then removing gives back the original file byte for byte", () => {
    const added = applyTomlChanges(F.codexToml, [{ op: "set", name: RINGKEEPER_ENTRY, value: entry }]);
    expect(applyTomlChanges(added, [{ op: "remove", name: RINGKEEPER_ENTRY }])).toBe(F.codexToml);
  });

  it("takes out a server with its sub-tables, keeping the comment and the tables around it", () => {
    const after = applyTomlChanges(F.codexToml, [{ op: "remove", name: "n8n" }]);
    const parsed = parseToml(after) as Record<string, unknown>;
    expect(Object.keys(parsed.mcp_servers as object)).toEqual(["docs search"]);
    expect(after).toContain("# Pat's tools\n[mcp_servers.\"docs search\"]");
    expect(after).toContain("# Keep this note: it explains the sandbox.\n[sandbox_workspace_write]");
    expect(after).not.toContain("n8n_api_fake");
    // Everything that isn't a connection is unchanged.
    const { mcp_servers: _a, ...before } = parseToml(F.codexToml) as Record<string, unknown>;
    const { mcp_servers: _b, ...rest } = parsed;
    expect(rest).toEqual(before);
  });

  it("replaces an existing entry where it is, not at the end", () => {
    const first = applyTomlChanges(F.codexToml, [{ op: "set", name: RINGKEEPER_ENTRY, value: entry }]);
    const moved = first.replace("[sandbox_workspace_write]", "[mcp_servers.zzz]\ncommand = \"x\"\n\n[sandbox_workspace_write]");
    const again = applyTomlChanges(moved, [{ op: "set", name: RINGKEEPER_ENTRY, value: { ...entry, args: ["other.mjs"] } }]);
    expect(again.indexOf("[mcp_servers.ringkeeper-connect]")).toBe(moved.indexOf("[mcp_servers.ringkeeper-connect]"));
    expect((parseToml(again) as { mcp_servers: Record<string, { args: string[] }> }).mcp_servers[RINGKEEPER_ENTRY]!.args).toEqual(["other.mjs"]);
  });

  it("isn't fooled by a table header inside a multi-line string", () => {
    const after = applyTomlChanges(F.codexToml, [{ op: "remove", name: "not-a-table" }]);
    expect(after).toBe(F.codexToml);
  });

  it("keeps Windows line endings and the byte-order mark", () => {
    const crlf = "\uFEFF" + F.codexToml.replace(/\n/g, "\r\n");
    const after = applyTomlChanges(crlf, [{ op: "set", name: RINGKEEPER_ENTRY, value: entry }]);
    expect(after.startsWith(crlf)).toBe(true);
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
    expect(applyTomlChanges(after, [{ op: "remove", name: RINGKEEPER_ENTRY }])).toBe(crlf);
  });

  it("starts an empty or missing file cleanly", () => {
    const after = applyTomlChanges("", [{ op: "set", name: RINGKEEPER_ENTRY, value: entry }]);
    expect(after.startsWith("[mcp_servers.ringkeeper-connect]\n")).toBe(true);
    expect(parseToml(after)).toEqual({ mcp_servers: { [RINGKEEPER_ENTRY]: entry } });
  });

  it("refuses connections written in a compact form it can't change safely", () => {
    const inline = 'model = "x"\nmcp_servers = { a = { command = "y" } }\n';
    expect(() => applyTomlChanges(inline, [{ op: "set", name: RINGKEEPER_ENTRY, value: entry }])).toThrow(HostConfigError);
    const dotted = '[mcp_servers]\na.command = "y"\n';
    expect(() => applyTomlChanges(dotted, [{ op: "remove", name: "a" }])).toThrow(HostConfigError);
  });

  it("leaves a file that isn't valid alone, and says so plainly", () => {
    expect(() => applyTomlChanges('model = "x\n', [{ op: "set", name: RINGKEEPER_ENTRY, value: entry }])).toThrow(/left this file alone because it isn't valid/);
    const r = readHostConfig(writeTemp('model = "x\n'), CODEX_TOML);
    expect(r.status).toBe("unreadable");
  });

  it("reads dotted and quoted keys the way TOML does", () => {
    expect(splitKey('mcp_servers."docs search".env')).toEqual(["mcp_servers", "docs search", "env"]);
    expect(splitKey("mcp_servers . 'x y'")).toEqual(["mcp_servers", "x y"]);
    expect(splitKey("a b")).toBeNull();
  });

  it("goes through the same checked, atomic edit as JSON files", () => {
    const p = writeTemp(F.codexToml);
    const res = editHostConfig(p, () => [{ op: "set", name: RINGKEEPER_ENTRY, value: entry }], { format: CODEX_TOML });
    expect(res.changed).toBe(true);
    expect(res.before).toBe(F.codexToml);
    expect(applyChanges(fs.readFileSync(p, "utf8"), [{ op: "remove", name: RINGKEEPER_ENTRY }], CODEX_TOML)).toBe(F.codexToml);
  });
});

function writeTemp(text: string): string {
  const d = fs.mkdtempSync(join(tmpdir(), "rk-toml-"));
  dirs.push(d);
  const p = join(d, "config.toml");
  fs.writeFileSync(p, text);
  return p;
}

// ---------------------------------------------------------------------------

describe("setting up the new apps", () => {
  it("finds each new app only when it's installed, and marks them opt-in", () => {
    const none = machine();
    expect(none.manager.views().filter((v) => v.optIn).map((v) => [v.id, v.status])).toEqual([
      ["vscode", "not_installed"],
      ["kiro", "not_installed"],
      ["antigravity", "not_installed"],
      ["codex", "not_installed"],
    ]);
    const all = machine({ [P.copilot]: F.copilotJson, [P.kiro]: F.kiroJson, [P.antigravity]: F.antigravityJson, [P.codex]: F.codexToml });
    expect(all.manager.views().filter((v) => v.optIn).map((v) => [v.id, v.status, v.optIn])).toEqual([
      ["vscode", "not_connected", true],
      ["kiro", "not_connected", true],
      ["antigravity", "not_connected", true],
      ["codex", "not_connected", true],
    ]);
  });

  it("writes each app's own entry shape, touching nothing else, and Restore puts every file back byte for byte", () => {
    const m = machine({ [P.copilot]: F.copilotJson, [P.kiro]: F.kiroJson, [P.antigravity]: F.antigravityJson, [P.codex]: F.codexToml });
    const results = m.manager.connect(["vscode", "kiro", "antigravity", "codex"], []);
    expect(results.map((r) => [r.host, r.ok])).toEqual([
      ["kiro", true],
      ["antigravity", true],
      ["codex", true],
      ["vscode", true],
    ]);
    const env = (app: string) => ({ RINGKEEPER_APP: app });
    expect(JSON.parse(m.read(P.copilot)).mcpServers[RINGKEEPER_ENTRY]).toEqual({ type: "stdio", ...LAUNCH, env: env("vscode"), tools: ["*"] });
    expect(JSON.parse(m.read(P.kiro)).mcpServers[RINGKEEPER_ENTRY]).toEqual({ ...LAUNCH, env: env("kiro") });
    expect(JSON.parse(m.read(P.antigravity)).mcpServers[RINGKEEPER_ENTRY]).toEqual({ ...LAUNCH, env: env("antigravity") });
    expect((parseToml(m.read(P.codex)) as { mcp_servers: Record<string, unknown> }).mcp_servers[RINGKEEPER_ENTRY]).toEqual({
      ...LAUNCH,
      env: env("codex"),
      startup_timeout_sec: 30,
    });
    // Other connections stay.
    expect(Object.keys(JSON.parse(m.read(P.kiro)).mcpServers)).toEqual(["fetch", RINGKEEPER_ENTRY]);
    expect(m.manager.views().filter((v) => v.optIn).map((v) => v.status)).toEqual(["entry_present", "entry_present", "entry_present", "entry_present"]);

    for (const r of m.manager.restoreAll()) expect(r).toEqual({ host: r.host, ok: true });
    expect(m.read(P.copilot)).toBe(F.copilotJson);
    expect(m.read(P.kiro)).toBe(F.kiroJson);
    expect(m.read(P.antigravity)).toBe(F.antigravityJson);
    expect(m.read(P.codex)).toBe(F.codexToml);
  });

  it("creates VS Code's file when it doesn't exist yet, and Restore removes it again", () => {
    const m = machine({ [P.vscodeSettings]: "{}" });
    expect(m.manager.connect(["vscode"], [])[0]!.ok).toBe(true);
    expect(fs.existsSync(m.path(P.copilot))).toBe(true);
    m.manager.restoreAll();
    expect(fs.existsSync(m.path(P.copilot))).toBe(false);
  });

  it("moves a chosen Codex connection out of config.toml, and Restore puts it back exactly", () => {
    const m = machine({ [P.codex]: F.codexToml });
    const [res] = m.manager.connect(["codex"], [{ host: "codex", name: "n8n" }]);
    expect(res!.taken.map((t) => t.name)).toEqual(["n8n"]);
    const after = m.read(P.codex);
    expect(after).not.toContain("[mcp_servers.n8n]");
    expect(after).toContain("[mcp_servers.ringkeeper-connect]");
    expect(m.ledger.listBackups("codex").length).toBeGreaterThan(0);
    m.manager.restoreAll();
    expect(m.read(P.codex)).toBe(F.codexToml);
  });

  it("brings Codex's connections in: a key named by environment variable becomes a header", () => {
    const m = machine({ [P.codex]: F.codexToml });
    const { candidates } = m.manager.scan();
    const docs = candidates.find((c) => c.name === "docs search")!;
    expect(docs.input).toEqual({
      kind: "remote",
      name: "docs search",
      url: "https://docs.example.com/mcp",
      fields: [{ name: "Authorization", value: "Bearer docs_fake_token_123456789", secret: true }],
    });
    expect(docs.warnings.join(" ")).toMatch(/turned off in Codex/);
  });
});

// ---------------------------------------------------------------------------
// Helpers an AI app ships for itself (Codex's node_repl). They aren't a
// client's tool and only work inside that app, so they're never offered,
// never moved out of the app, and never asked about.
// ---------------------------------------------------------------------------
describe("an AI app's own helpers", () => {
  const withHelper = F.codexToml + F.codexNodeRepl;
  const WIN = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.9664.0_x64__2p2nqsd0c76g0\\app\\resources\\cua_node\\bin\\node_repl.exe";

  it("recognises Codex's node_repl wherever the app keeps it, on Windows and on a Mac", () => {
    expect(appOnlyHelper("node_repl", WIN, [])).toEqual({ app: "Codex" });
    // Renamed on the way in ("node_repl (Codex / ChatGPT)"): still the same program.
    expect(appOnlyHelper("node_repl (Codex / ChatGPT)", WIN, [])).toEqual({ app: "Codex" });
    // The other places the app has kept it (openai/codex issues 26011, 26530, 53664).
    expect(appOnlyHelper("node_repl", "C:\\Users\\pat\\AppData\\Local\\OpenAI\\Codex\\bin\\0a1b2c3d4e5f6a7b\\node_repl.exe", [])).toEqual({ app: "Codex" });
    expect(appOnlyHelper("node_repl (Codex / ChatGPT)", "C:\\Users\\pat\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\0a1b2c3d4e5f6a7b\\bin\\node_repl.exe", [])).toEqual({ app: "Codex" });
    expect(appOnlyHelper("node_repl", "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl", [])).toEqual({ app: "Codex" });
  });

  it("recognises Codex's other helpers: cua_repl, computer-use, and anything else run from the app's own folders", () => {
    // cua_repl: the bundled Node running @oai/cua-repl (openai/codex issues 26011, 42454).
    const node = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.9664.0_x64__2p2nqsd0c76g0\\app\\resources\\cua_node\\bin\\node.exe";
    expect(appOnlyHelper("cua_repl", node, ["C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.9664.0_x64__2p2nqsd0c76g0\\app\\resources\\cua_node\\bin\\node_modules\\@oai\\cua-repl\\bin\\cua-repl.mjs"])).toEqual({ app: "Codex" });
    expect(appOnlyHelper("cua_repl", "/Users/pat/.codex/plugins/cache/openai-bundled/unified-computer-use/1.4.0/node", ["/Users/pat/.codex/plugins/cache/openai-bundled/unified-computer-use/1.4.0/node_modules/@oai/cua-repl/bin/cua-repl.mjs"])).toEqual({ app: "Codex" });
    // computer-use, as seen in a real Mac config: a path relative to Codex's own folder.
    expect(appOnlyHelper("computer-use", "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient", ["mcp"])).toEqual({ app: "Codex" });
    // A helper under a name not known yet: run from the app's install folder, or by a system Node from it.
    expect(appOnlyHelper("artifact_picker", node, ["server.mjs"])).toEqual({ app: "Codex" });
    expect(appOnlyHelper("new_helper", "node", ["C:\\Users\\pat\\AppData\\Local\\OpenAI\\Codex\\runtimes\\thing\\0a1b2c3d4e5f6a7b\\main.js"])).toEqual({ app: "Codex" });
    expect(appOnlyHelper("new_helper", "/Applications/ChatGPT.app/Contents/Resources/helper", [])).toEqual({ app: "Codex" });
    expect(appOnlyHelper("new_helper", "/mnt/c/Users/pat/AppData/Local/OpenAI/Codex/bin/0a1b2c3d4e5f6a7b/helper", [])).toEqual({ app: "Codex" });
  });

  it("doesn't mistake ordinary tools for helpers", () => {
    expect(appOnlyHelper("n8n", "npx", ["-y", "n8n-mcp"])).toBeUndefined();
    expect(appOnlyHelper("playwright", "C:\\Users\\pat\\bin\\pw-mcp.cmd", [])).toBeUndefined();
    expect(appOnlyHelper("repl", "node", ["C:\\tools\\my_node_repl_server.js"])).toBeUndefined();
    expect(appOnlyHelper("python", "C:\\Program Files\\WindowsApps\\PythonSoftwareFoundation.Python.3.12_3.12.2800.0_x64__qbz5n2kfra8p0\\python3.12.exe", ["server.py"])).toBeUndefined();
    // The user's own program kept in Codex's settings folder isn't the app's.
    expect(appOnlyHelper("mine", "node", ["C:\\Users\\pat\\.codex\\my-server\\server.js"])).toBeUndefined();
    // Tools that are the same for everyone but work from any AI app stay offered.
    expect(appOnlyHelper("jetbrains", "/Applications/RubyMine.app/Contents/jbr/Contents/Home/bin/java", ["-classpath", "/Applications/RubyMine.app/Contents/plugins/mcpserver/lib/mcpserver-frontend.jar", "com.intellij.mcpserver.stdio.McpStdioRunnerKt"])).toBeUndefined();
    expect(appOnlyHelper("fetch", "uvx", ["mcp-server-fetch"])).toBeUndefined();
    expect(appOnlyHelper("MCP_DOCKER", "docker", ["mcp", "gateway", "run"])).toBeUndefined();
    expect(appOnlyHelper("chrome-devtools", "npx", ["-y", "chrome-devtools-mcp@latest"])).toBeUndefined();
    expect(appOnlyHelper("unity-mcp", "C:\\Users\\pat\\.unity\\relay\\relay_win.exe", ["--mcp"])).toBeUndefined();
    expect(appOnlyHelper("docs", undefined)).toBeUndefined();
  });

  it("doesn't offer it when bringing tools in, and still offers the others", () => {
    const m = machine({ [P.codex]: withHelper });
    const names = m.manager.scan().candidates.map((c) => c.name);
    expect(names).toContain("n8n");
    expect(names).toContain("docs search");
    expect(names).not.toContain("node_repl");
  });

  it("says why, in plain words, if it's asked for anyway", () => {
    const m = machine({ [P.codex]: withHelper });
    const r = readHostConfig(m.path(P.codex), CODEX_TOML);
    if (r.status !== "ok") throw new Error("fixture unreadable");
    const mapped = mapEntry("node_repl", r.servers.node_repl, "codex", { env: {}, home: m.home, pathSeparator: "\\" });
    expect(mapped.input).toBeUndefined();
    expect(mapped.problem).toBe("node_repl is part of Codex and only works inside Codex, so it was left there.");
    // Found in another app's settings (some apps read Codex's): names both.
    expect(mapEntry("node_repl", r.servers.node_repl, "warp", { env: {}, home: m.home, pathSeparator: "\\" }).problem).toBe(
      "node_repl is part of Codex and only works inside Codex, so it was left in Warp.",
    );
  });

  it("never moves it out of Codex, even when told to, and Restore still puts the file back exactly", () => {
    const m = machine({ [P.codex]: withHelper });
    const [res] = m.manager.connect(["codex"], [
      { host: "codex", name: "n8n" },
      { host: "codex", name: "node_repl" },
    ]);
    expect(res!.taken.map((t) => t.name)).toEqual(["n8n"]);
    const after = m.read(P.codex);
    expect(after).toContain(F.codexNodeRepl.trim());
    expect(after).not.toContain("[mcp_servers.n8n]");
    m.manager.restoreAll();
    expect(m.read(P.codex)).toBe(withHelper);
  });

  it("doesn't ask about it when Codex adds it later, but still asks about a real tool", () => {
    const m = machine({ [P.codex]: F.codexToml });
    m.manager.connect(["codex"], []);
    m.manager.watch(60_000);
    m.manager.check("codex"); // its own write
    fs.writeFileSync(m.path(P.codex), m.read(P.codex) + F.codexNodeRepl + '\n[mcp_servers.airtable]\ncommand = "npx"\nargs = ["-y", "airtable-mcp-server"]\n');
    m.manager.check("codex");
    m.manager.stop();
    expect(m.events.filter((e) => e.kind === "found")).toEqual([{ kind: "found", host: "codex", name: "airtable" }]);
  });
});

// ---------------------------------------------------------------------------

describe("never showing Ringkeeper twice in VS Code", () => {
  it("doesn't write VS Code's file when VS Code already reads Claude Desktop's, which has Ringkeeper", () => {
    const m = machine({ [P.desktop]: claudeDesktop, [P.vscodeSettings]: F.vscodeSettingsDiscovery, [P.copilot]: F.copilotJson });
    const results = m.manager.connect(["vscode", "claude-desktop"], []);
    // Claude Desktop first, then VS Code (which sees our entry there).
    expect(results.map((r) => [r.host, r.ok])).toEqual([
      ["claude-desktop", true],
      ["vscode", true],
    ]);
    expect(m.read(P.copilot)).toBe(F.copilotJson);
    expect(m.manager.views().find((v) => v.id === "vscode")).toMatchObject({ status: "via_other", via: "claude-desktop" });
  });

  it("takes out an entry it added before, once VS Code starts reading Claude Desktop's settings (with a backup)", () => {
    const m = machine({ [P.desktop]: claudeDesktop, [P.copilot]: F.copilotJson });
    m.manager.connect(["claude-desktop", "vscode"], []);
    expect(JSON.parse(m.read(P.copilot)).mcpServers[RINGKEEPER_ENTRY]).toBeDefined();
    fs.mkdirSync(m.path("AppData/Roaming/Code/User"), { recursive: true });
    fs.writeFileSync(m.path(P.vscodeSettings), F.vscodeSettingsDiscovery);
    const backups = m.ledger.listBackups("vscode").length;
    m.manager.connect(["vscode"], []);
    expect(JSON.parse(m.read(P.copilot)).mcpServers[RINGKEEPER_ENTRY]).toBeUndefined();
    expect(m.read(P.copilot)).toBe(F.copilotJson);
    expect(m.ledger.listBackups("vscode").length).toBeGreaterThan(backups);
    // And the watcher doesn't put it back.
    m.manager.check("vscode");
    expect(JSON.parse(m.read(P.copilot)).mcpServers[RINGKEEPER_ENTRY]).toBeUndefined();
  });

  it("still writes VS Code's own entry when discovery covers only an app without Ringkeeper", () => {
    const m = machine({ [P.cursor]: "{}", [P.vscodeSettings]: '{ "chat.mcp.discovery.enabled": { "cursor-global": true } }' });
    m.manager.connect(["vscode"], []);
    expect(JSON.parse(m.read(P.copilot)).mcpServers[RINGKEEPER_ENTRY]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------

describe("apps Ringkeeper only reads from", () => {
  const everything = {
    [P.cursor]: F.cursorWithN8n,
    [P.vscodeLegacy]: F.vscodeLegacyJson,
    ".mcp.json": F.visualStudioJson,
    ".codeium/windsurf/mcp_config.json": F.windsurfJson,
    "AppData/Roaming/devin/mcp_config.json": F.devinJson,
    ".gemini/settings.json": F.geminiSettings,
    ".cline/data/settings/cline_mcp_settings.json": F.clineNested,
    "AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json": F.clineLegacy,
    "AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json": F.rooJson,
    ".warp/.mcp.json": F.warpJson,
    ".lmstudio/mcp.json": F.lmStudioJson,
    ".junie/mcp/mcp.json": F.junieJson,
    "AppData/Roaming/Zed/settings.json": F.zedSettings,
    ".continue/config.yaml": F.continueYaml,
    ".aws/amazonq/mcp.json": F.amazonQJson,
  };

  it("reads every app's own shape, and lists each app it looked in", () => {
    const m = machine(everything);
    const { candidates, seen } = m.manager.scan();
    const by = (name: string) => candidates.find((c) => c.name === name)!;

    expect(seen.map((s) => [s.label, s.count, s.problems.length])).toEqual([
      ["VS Code (older settings)", 2, 0],
      ["Visual Studio", 1, 0],
      ["Windsurf", 1, 0],
      ["Devin Desktop", 1, 0],
      ["Gemini CLI", 2, 0],
      ["Cline", 2, 0],
      ["Roo Code", 1, 0],
      ["Warp", 1, 0],
      ["LM Studio", 1, 0],
      ["Junie", 1, 0],
      ["Zed", 2, 0],
      ["Continue", 2, 0],
      ["Amazon Q", 1, 0],
    ]);

    // The same n8n in Cursor (url) and Windsurf (serverUrl) is one connection.
    expect(candidates.filter((c) => c.name.startsWith("n8n"))).toHaveLength(1);
    expect(by("n8n").sources.map((s) => s.host)).toEqual(["cursor", "windsurf"]);

    expect(by("notion").input).toEqual({ kind: "remote", name: "notion", url: "https://mcp.notion.com/mcp", fields: [] });
    expect(by("legacy-sse").input).toMatchObject({ kind: "remote", transport: "sse" });
    expect(by("linear").input).toEqual({ kind: "remote", name: "linear", url: "https://mcp.linear.app/mcp", fields: [] });
    expect(by("weather").input).toMatchObject({ kind: "remote", transport: "sse" });
    expect(by("supabase").input).toMatchObject({ kind: "remote", url: "https://mcp.supabase.com/mcp" });
    expect(by("postgres").input).toEqual({
      kind: "local",
      name: "postgres",
      command: "npx",
      args: ["-y", "@zeddev/postgres-context-server"],
      fields: [{ name: "DATABASE_URL", value: "postgres://user:pw@db.example.com/app", secret: false }],
    });
    expect(by("cal").input).toMatchObject({ kind: "remote", url: "https://mcp.cal.com/mcp" });
    expect(by("learn").input).toMatchObject({ kind: "remote", url: "https://learn.microsoft.com/api/mcp" });
    // VS Code's \${input:...} and Continue's secrets can't be known here: asked for instead.
    expect(by("github").warnings.join(" ")).toMatch(/needs Authorization/);
    expect(by("github-remote").warnings.join(" ")).toMatch(/needs Authorization/);
    expect(by("files").input).toMatchObject({ kind: "local", args: ["-y", "@modelcontextprotocol/server-filesystem", `${m.home}/Documents`] });
    // Cline's own sign-in data is never copied.
    expect(JSON.stringify(candidates)).not.toContain("cline-oauth-secret");
  });

  it("never changes those apps' files, even when their connections are brought in", () => {
    const m = machine(everything);
    const before = Object.fromEntries(Object.keys(everything).map((rel) => [rel, m.read(rel)]));
    const { candidates } = m.manager.scan();
    const take = candidates.flatMap((c) => c.sources);
    m.manager.connect(["cursor"], take);
    for (const [rel, text] of Object.entries(before)) if (rel !== P.cursor) expect(m.read(rel), rel).toBe(text);
  });

  it("lists a file it can't read with a plain reason, instead of skipping it", () => {
    const m = machine({ ".kiro/settings/mcp.json": "{ broken", ".warp/.mcp.json": "{ broken", ".continue/config.yaml": "mcpServers: [ {" });
    const { seen, unreadable } = m.manager.scan();
    expect(unreadable.map((v) => v.id)).toEqual(["kiro"]);
    expect(seen.find((s) => s.label === "Warp")!.problems[0]).toMatch(/^Couldn't read Warp's settings .*: it isn't valid/);
    expect(seen.find((s) => s.label === "Continue")!.problems[0]).toMatch(/Couldn't read Continue's settings/);
  });

  it("looks for Visual Studio only on Windows", () => {
    const m = machine({ ".mcp.json": F.visualStudioJson });
    const mac = new HostManager({ roots: { ...m.roots, platform: "darwin" }, ledger: m.ledger, ctx: { env: {}, home: m.home, pathSeparator: "/" }, launch: () => LAUNCH });
    expect(mac.scan().seen.map((s) => s.label)).not.toContain("Visual Studio");
    expect(m.manager.scan().seen.map((s) => s.label)).toContain("Visual Studio");
  });
});

// Keep the plain JSON path honest too: a JSON file's key can be other than mcpServers.
describe("the JSON editor with another key", () => {
  it("edits only that key", () => {
    const text = '{\n  "servers": {},\n  "inputs": []\n}\n';
    const after = applyChanges(text, [{ op: "set", name: "x", value: { url: "https://x" } }], { kind: "json", key: "servers" });
    expect(JSON.parse(after)).toEqual({ servers: { x: { url: "https://x" } }, inputs: [] });
  });
});
