// Pretend to be an AI app and switch clients, to see the desktop app's notification.
//   RINGKEEPER_DATA_DIR=... node spike/ai-switch.mjs Globex [host-name] [--via-bridge]
// --via-bridge connects the way Claude Desktop does: through the bridge, which
// starts Ringkeeper Connect if it isn't running.
import fs from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const dataDir = process.env.RINGKEEPER_DATA_DIR;
if (!dataDir) throw new Error("Set RINGKEEPER_DATA_DIR");
const viaBridge = process.argv.includes("--via-bridge");
const [clientName = "Globex", host = "claude-ai"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const c = new Client({ name: host, version: "1" });
if (viaBridge) {
  const bridge = resolve(import.meta.dirname, "..", "apps", "desktop", "dist", "bridge.mjs");
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [bridge],
    env: { ...getDefaultEnvironment(), RINGKEEPER_DATA_DIR: dataDir },
    stderr: "inherit",
  });
  await c.connect(t);
} else {
  const { port, token } = JSON.parse(fs.readFileSync(join(dataDir, "runtime.json"), "utf8"));
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
}
const res = await c.callTool({ name: "ringkeeper_use_client", arguments: { client: clientName } });
console.log(res.content.map((x) => x.text).join("\n"));
await c.close();
