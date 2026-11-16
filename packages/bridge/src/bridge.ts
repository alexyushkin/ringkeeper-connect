// The bridge: a stdio MCP server for hosts that only launch local commands
// (Claude Desktop). It forwards every message, unchanged, to the running
// gateway over HTTP. It finds the gateway through the runtime file, starts it
// if it isn't running, and if it still can't reach it, answers with a plain
// explanation instead of failing silently.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { isGatewayAlive, mcpUrl, readRuntimeInfo, resolveDataDir, type RuntimeInfo } from "@ringkeeper/gateway/runtime";

const START_TIMEOUT_MS = 20_000;

export const OFFLINE_MESSAGE =
  "Ringkeeper Connect isn't running, so your client tools aren't available. Open Ringkeeper Connect and try again. " +
  "If you uninstalled it, open Ringkeeper Connect's Restore option first, or remove \"Ringkeeper Connect\" from this app's connections.";

function stderr(msg: string): void {
  process.stderr.write(`[ringkeeper-bridge] ${msg}\n`);
}

/** Find a live gateway; start one if allowed. Returns null if none could be reached. */
export async function findOrStartGateway(dataDir: string, launch?: () => void): Promise<RuntimeInfo | null> {
  const current = readRuntimeInfo(dataDir);
  if (current && (await isGatewayAlive(current.port))) return current;
  if (!launch) return null;
  stderr("Ringkeeper Connect isn't running; starting it.");
  launch();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const info = readRuntimeInfo(dataDir);
    if (info && (await isGatewayAlive(info.port, 800))) return info;
  }
  return null;
}

/** Spike launcher: start the bundled gateway next to this file. M5 launches the app instead. */
function spikeLauncher(): (() => void) | undefined {
  if (process.env.RINGKEEPER_NO_LAUNCH === "1") return undefined;
  const gatewayScript = join(dirname(resolve(process.argv[1] ?? ".")), "gateway.mjs");
  if (!fs.existsSync(gatewayScript)) return undefined;
  return () => {
    const child = spawn(process.execPath, [gatewayScript], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  };
}

export async function runBridge(): Promise<void> {
  const dataDir = resolveDataDir();
  const info = await findOrStartGateway(dataDir, spikeLauncher());
  if (!info) {
    stderr("Couldn't reach Ringkeeper Connect; serving the offline notice.");
    return serveOffline();
  }
  return pipe(info);
}

async function pipe(info: RuntimeInfo): Promise<void> {
  const stdio = new StdioServerTransport();
  const upstream = new StreamableHTTPClientTransport(new URL(mcpUrl(info.port)), {
    requestInit: { headers: { Authorization: `Bearer ${info.token}` } },
  });
  let initializeId: RequestId | undefined;
  let closing = false;

  const shutdown = async (why: string) => {
    if (closing) return;
    closing = true;
    stderr(`closing: ${why}`);
    await upstream.terminateSession().catch(() => {});
    await upstream.close().catch(() => {});
    await stdio.close().catch(() => {});
    process.exit(0);
  };

  upstream.onmessage = (msg: JSONRPCMessage) => {
    // The client transport only sends the protocol-version header once told.
    if (initializeId !== undefined && "id" in msg && msg.id === initializeId && "result" in msg) {
      const v = (msg.result as { protocolVersion?: string }).protocolVersion;
      if (v) upstream.setProtocolVersion(v);
      initializeId = undefined;
    }
    stdio.send(msg).catch((err) => stderr(`write to host failed: ${String(err)}`));
  };
  upstream.onerror = (err) => stderr(`gateway error: ${err.message}`);
  upstream.onclose = () => void shutdown("gateway connection closed");

  stdio.onmessage = (msg: JSONRPCMessage) => {
    if ("method" in msg && msg.method === "initialize" && "id" in msg) initializeId = msg.id;
    upstream.send(msg).catch((err: Error) => {
      stderr(`forward failed: ${err.message}`);
      // Never leave the host waiting on a request that went nowhere.
      if ("method" in msg && "id" in msg) {
        void stdio.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "Ringkeeper Connect stopped responding. Make sure it's open, then try again." },
        });
      }
    });
  };
  stdio.onclose = () => void shutdown("host closed stdin");
  process.stdin.on("end", () => void shutdown("stdin ended"));

  await upstream.start();
  await stdio.start();
}

async function serveOffline(): Promise<void> {
  const server = new Server(
    { name: "ringkeeper-connect", title: "Ringkeeper Connect", version: "0.0.1" },
    { capabilities: { tools: {} }, instructions: OFFLINE_MESSAGE },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "ringkeeper_status",
        description: "Explains why Ringkeeper Connect's client tools aren't available right now.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: OFFLINE_MESSAGE }],
    isError: true,
  }));
  await server.connect(new StdioServerTransport());
}
