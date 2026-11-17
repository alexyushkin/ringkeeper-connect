// The bridge: a stdio MCP server for hosts that only launch local commands
// (Claude Desktop). It forwards every message, unchanged, to the running
// gateway over HTTP. It finds the gateway through the runtime file, starts
// Ringkeeper Connect if it isn't running, reconnects by itself if the app
// restarts (for example after an update), and if it can't reach the app at
// all, answers with a plain explanation instead of failing silently.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import {
  isGatewayAlive,
  mcpUrl,
  readLaunchInfo,
  readRuntimeInfo,
  resolveDataDir,
  type RuntimeInfo,
} from "@ringkeeper/gateway/runtime";

const START_TIMEOUT_MS = 20_000;

/**
 * Which AI app launched this bridge, from its settings entry
 * (RINGKEEPER_APP). Sent with every request so Ringkeeper knows that app
 * really uses it.
 */
function headersFor(info: RuntimeInfo): Record<string, string> {
  const app = process.env.RINGKEEPER_APP;
  return { Authorization: `Bearer ${info.token}`, ...(app && /^[a-z0-9-]{1,40}$/.test(app) ? { "X-Ringkeeper-App": app } : {}) };
}

export const OFFLINE_MESSAGE =
  "Ringkeeper Connect isn't running, so your client tools aren't available. Open Ringkeeper Connect and try again. " +
  "If you uninstalled it, open Ringkeeper Connect's Restore option first, or remove \"Ringkeeper Connect\" from this app's connections.";

const STOPPED_MESSAGE = "Ringkeeper Connect stopped responding. Make sure it's open, then try again.";

function stderr(msg: string): void {
  process.stderr.write(`[ringkeeper-bridge] ${msg}\n`);
}

/** Find a live gateway; start Ringkeeper Connect if allowed. Returns null if none could be reached. */
export async function findOrStartGateway(dataDir: string, launch?: () => void, timeoutMs = START_TIMEOUT_MS): Promise<RuntimeInfo | null> {
  const current = readRuntimeInfo(dataDir);
  if (current && (await isGatewayAlive(current.port))) return current;
  if (!launch) return null;
  stderr("Ringkeeper Connect isn't running; starting it.");
  launch();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const info = readRuntimeInfo(dataDir);
    if (info && (await isGatewayAlive(info.port, 800))) return info;
  }
  return null;
}

/**
 * How to start Ringkeeper Connect: the app records its own command in
 * launcher.json. During development and tests, fall back to the standalone
 * gateway bundled next to the bridge.
 */
export function launcherFor(dataDir: string): (() => void) | undefined {
  if (process.env.RINGKEEPER_NO_LAUNCH === "1") return undefined;
  const info = readLaunchInfo(dataDir);
  const devGateway = join(dirname(resolve(process.argv[1] ?? ".")), "gateway.mjs");
  const cmd = info ?? (fs.existsSync(devGateway) ? { command: process.execPath, args: [devGateway] } : null);
  if (!cmd) return undefined;
  return () => {
    const child = spawn(cmd.command, cmd.args, { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
    child.on("error", (err) => stderr(`couldn't start Ringkeeper Connect: ${err.message}`));
    child.unref();
  };
}

export async function runBridge(): Promise<void> {
  const dataDir = resolveDataDir();
  const launch = launcherFor(dataDir);
  const info = await findOrStartGateway(dataDir, launch);
  if (!info) {
    stderr("Couldn't reach Ringkeeper Connect; serving the offline notice.");
    return serveOffline();
  }
  await new BridgePipe(dataDir, info, launch).start();
}

/** True for errors that mean "the gateway restarted or went away", which a reconnect can fix. */
function isReconnectable(err: unknown): boolean {
  if (err instanceof StreamableHTTPError) return err.code === 404 || err.code === undefined;
  const text = `${String(err)} ${String((err as { cause?: unknown })?.cause ?? "")}`;
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed/i.test(text);
}

export class BridgePipe {
  private readonly stdio = new StdioServerTransport();
  private upstream!: StreamableHTTPClientTransport;
  /** The host's own initialize request and initialized notice, replayed on reconnect. */
  private initRequest?: JSONRPCRequest;
  private initialized?: JSONRPCMessage;
  private initializeId?: RequestId;
  private reconnecting?: Promise<boolean>;
  private reinitCount = 0;
  private closing = false;

  constructor(
    private readonly dataDir: string,
    private info: RuntimeInfo,
    private readonly launch?: () => void,
  ) {}

  async start(): Promise<void> {
    this.upstream = this.makeUpstream(this.info);
    await this.upstream.start();
    this.stdio.onmessage = (msg) => void this.fromHost(msg);
    this.stdio.onclose = () => void this.shutdown("host closed stdin");
    process.stdin.on("end", () => void this.shutdown("stdin ended"));
    await this.stdio.start();
  }

  private makeUpstream(info: RuntimeInfo): StreamableHTTPClientTransport {
    const t = new StreamableHTTPClientTransport(new URL(mcpUrl(info.port)), {
      requestInit: { headers: headersFor(info) },
    });
    t.onmessage = (msg) => this.fromGateway(t, msg);
    t.onerror = (err) => stderr(`gateway error: ${err.message}`);
    return t;
  }

  private fromGateway(t: StreamableHTTPClientTransport, msg: JSONRPCMessage): void {
    if (t !== this.upstream) return; // a replaced connection
    // The client transport only sends the protocol-version header once told.
    if (this.initializeId !== undefined && "id" in msg && msg.id === this.initializeId && "result" in msg) {
      const v = (msg.result as { protocolVersion?: string }).protocolVersion;
      if (v) t.setProtocolVersion(v);
      this.initializeId = undefined;
    }
    this.stdio.send(msg).catch((err) => stderr(`write to host failed: ${String(err)}`));
  }

  private async fromHost(msg: JSONRPCMessage): Promise<void> {
    if ("method" in msg && msg.method === "initialize" && "id" in msg) {
      this.initRequest = msg as JSONRPCRequest;
      this.initializeId = msg.id;
    }
    if ("method" in msg && msg.method === "notifications/initialized") this.initialized = msg;

    if (this.reconnecting) await this.reconnecting;
    try {
      await this.upstream.send(msg);
    } catch (err) {
      stderr(`forward failed: ${err instanceof Error ? err.message : String(err)}`);
      if (isReconnectable(err) && this.initRequest && msg !== this.initRequest && (await this.reconnect())) {
        try {
          await this.upstream.send(msg);
          return;
        } catch (retryErr) {
          stderr(`retry failed: ${String(retryErr)}`);
        }
      }
      // Never leave the host waiting on a request that went nowhere.
      if ("method" in msg && "id" in msg) {
        await this.stdio.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: STOPPED_MESSAGE } }).catch(() => {});
      }
    }
  }

  /** Reconnect to a (possibly restarted) gateway and replay the host's handshake. One at a time. */
  private reconnect(): Promise<boolean> {
    this.reconnecting ??= this.doReconnect().finally(() => (this.reconnecting = undefined));
    return this.reconnecting;
  }

  private async doReconnect(): Promise<boolean> {
    stderr("lost Ringkeeper Connect; reconnecting");
    const info = await findOrStartGateway(this.dataDir, this.launch);
    if (!info || !this.initRequest) return false;
    const old = this.upstream;
    old.onmessage = undefined;
    old.onerror = undefined;
    old.onclose = undefined;
    void old.close().catch(() => {});

    const fresh = new StreamableHTTPClientTransport(new URL(mcpUrl(info.port)), {
      requestInit: { headers: headersFor(info) },
    });
    const reinitId = `ringkeeper-reinit-${++this.reinitCount}`;
    const handshake = new Promise<boolean>((resolveHandshake) => {
      const timer = setTimeout(() => resolveHandshake(false), 10_000);
      fresh.onmessage = (msg) => {
        if ("id" in msg && msg.id === reinitId) {
          clearTimeout(timer);
          const v = "result" in msg ? (msg.result as { protocolVersion?: string }).protocolVersion : undefined;
          if (v) fresh.setProtocolVersion(v);
          resolveHandshake("result" in msg);
        }
      };
    });
    try {
      await fresh.start();
      await fresh.send({ ...this.initRequest, id: reinitId });
      if (!(await handshake)) throw new Error("handshake failed");
      fresh.onmessage = (msg) => this.fromGateway(fresh, msg);
      fresh.onerror = (err) => stderr(`gateway error: ${err.message}`);
      this.upstream = fresh;
      this.info = info;
      if (this.initialized) await fresh.send(this.initialized);
      // The tools may differ after a restart; let hosts that listen re-fetch.
      await this.stdio.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }).catch(() => {});
      stderr(`reconnected on port ${info.port}`);
      return true;
    } catch (err) {
      stderr(`reconnect failed: ${String(err)}`);
      await fresh.close().catch(() => {});
      return false;
    }
  }

  private async shutdown(why: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    stderr(`closing: ${why}`);
    await this.upstream.terminateSession().catch(() => {});
    await this.upstream.close().catch(() => {});
    await this.stdio.close().catch(() => {});
    process.exit(0);
  }
}

async function serveOffline(): Promise<void> {
  const server = new Server(
    { name: "ringkeeper-connect", title: "Ringkeeper Connect", version: "0.1.0" },
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
