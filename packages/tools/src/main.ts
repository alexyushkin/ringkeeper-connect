// tools.mjs <service>: one built-in service over stdio, for one connection.
//   RINGKEEPER_ACCESS_TOKEN  the connection's access token (the gateway renews it and restarts this program)
//   RINGKEEPER_ACCESS        the access keys ticked for the account, comma-separated
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVICES } from "./index.js";
import { createToolServer } from "./server.js";

const id = process.argv[2] ?? "";
const service = SERVICES[id];
if (!service) {
  process.stderr.write(`[ringkeeper-tools] unknown service "${id}"\n`);
  process.exit(2);
}
const token = process.env.RINGKEEPER_ACCESS_TOKEN ?? "";
const access = new Set((process.env.RINGKEEPER_ACCESS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
// Tests point the tools at a stand-in service: RINGKEEPER_TOOLS_BASE_<NAME>=http://127.0.0.1:port
const base = (name: string, fallback: string) => process.env[`RINGKEEPER_TOOLS_BASE_${name.toUpperCase()}`] ?? fallback;

await createToolServer(service, access, { token, fetch, base }).connect(new StdioServerTransport());
