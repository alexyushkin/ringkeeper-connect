// M1 spike helpers. Run with: pnpm spike <command>
//   start | stop | state | switch <client> | client-arg on|off
//   configs                 write host config snippets to spike/out/
//   desktop-add | desktop-remove   add/remove the spike entry in Claude Desktop's config (with backup)
import { spawn } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  dataFiles,
  isGatewayAlive,
  loadOrCreateInstallSettings,
  mcpUrl,
  readRuntimeInfo,
  writeJsonAtomic,
} from "../packages/gateway/src/runtime.js";

const distDir = dirname(resolve(process.argv[1] ?? "."));
const repoRoot = resolve(distDir, "..");
process.env.RINGKEEPER_DATA_DIR ??= join(repoRoot, "spike", ".data");
const dataDir = process.env.RINGKEEPER_DATA_DIR;
const outDir = join(repoRoot, "spike", "out");
const bridgePath = join(distDir, "bridge.mjs");
const gatewayPath = join(distDir, "gateway.mjs");
const DESKTOP_ENTRY = "ringkeeper-connect-spike";

function desktopConfigPath(): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

async function admin(path: string, body?: unknown) {
  const info = readRuntimeInfo(dataDir);
  if (!info || !(await isGatewayAlive(info.port))) throw new Error("The gateway isn't running. Run: pnpm spike start");
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

async function start() {
  const info = readRuntimeInfo(dataDir);
  if (info && (await isGatewayAlive(info.port))) return console.log(`Already running on port ${info.port}.`);
  spawn(process.execPath, [gatewayPath], { detached: true, stdio: "ignore", windowsHide: true, env: process.env }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const now = readRuntimeInfo(dataDir);
    if (now && (await isGatewayAlive(now.port))) return console.log(`Gateway running on port ${now.port}. Log: ${dataFiles(dataDir).log}`);
  }
  throw new Error("Gateway didn't start; see the log.");
}

function bridgeEntry() {
  return { command: process.execPath, args: [bridgePath], env: { RINGKEEPER_DATA_DIR: dataDir } };
}

function configs() {
  const install = loadOrCreateInstallSettings(dataDir);
  const url = mcpUrl(install.port);
  const headers = { Authorization: `Bearer ${install.token}` };
  const write = (rel: string, value: unknown) => {
    const p = join(outDir, rel);
    writeJsonAtomic(p, value, 0o644);
    console.log(`wrote ${p}`);
  };
  write("claude-code-http.json", { mcpServers: { ringkeeper: { type: "http", url, headers } } });
  write("claude-code-bridge.json", { mcpServers: { ringkeeper: { type: "stdio", ...bridgeEntry() } } });
  write("cursor-http/.cursor/mcp.json", { mcpServers: { "ringkeeper-spike": { url, headers } } });
  write("cursor-bridge/.cursor/mcp.json", { mcpServers: { "ringkeeper-spike": bridgeEntry() } });
  write("claude-desktop-entry.json", { [DESKTOP_ENTRY]: bridgeEntry() });
}

function detectIndent(raw: string): number {
  const m = raw.match(/\n( +)\S/);
  return m ? m[1]!.length : 2;
}

function editDesktopConfig(mutate: (servers: Record<string, unknown>) => boolean) {
  const file = desktopConfigPath();
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const servers = (parsed.mcpServers ??= {}) as Record<string, unknown>;
  if (!mutate(servers)) return console.log("Nothing to change.");
  const backups = join(dataDir, "backups");
  fs.mkdirSync(backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(backups, `claude_desktop_config.${stamp}.json`);
  fs.writeFileSync(backup, raw, { mode: 0o600 });
  // Re-read right before writing, in case Claude Desktop rewrote it meanwhile.
  if (fs.readFileSync(file, "utf8") !== raw) throw new Error("Claude Desktop changed its config just now; run this again.");
  const tmp = `${file}.ringkeeper.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, detectIndent(raw)) + (raw.endsWith("\n") ? "\n" : ""));
  fs.renameSync(tmp, file);
  console.log(`Updated ${file}\nBackup: ${backup}\nQuit Claude Desktop fully (tray icon > Quit) and reopen it.`);
}

async function main() {
  const [cmd, a1] = process.argv.slice(2);
  switch (cmd) {
    case "start":
      return start();
    case "stop":
      return console.log(await admin("/admin/shutdown", {}));
    case "state":
      return console.log(JSON.stringify(await admin("/admin/state"), null, 2));
    case "switch":
      return console.log(await admin("/admin/active-client", { client: a1 }));
    case "client-arg":
      return console.log(await admin("/admin/options", { requireClientArg: a1 === "on" }));
    case "configs":
      return configs();
    case "desktop-add":
      return editDesktopConfig((s) => {
        s[DESKTOP_ENTRY] = bridgeEntry();
        return true;
      });
    case "desktop-remove":
      return editDesktopConfig((s) => (DESKTOP_ENTRY in s ? delete s[DESKTOP_ENTRY] : false));
    default:
      console.log("Commands: start | stop | state | switch <client> | client-arg on|off | configs | desktop-add | desktop-remove");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
