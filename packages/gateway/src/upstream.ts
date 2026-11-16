// One upstream connection for one client: a program the gateway launches, or
// a server on the web. Started on demand and stopped when idle.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ClientConfig, ConnectionConfig } from "./config.js";
import type { Logger } from "./log.js";

export type UpstreamStatus = "idle" | "starting" | "ready" | "error" | "needs_key" | "stopped";

/** After a failed start, wait this long before trying again on the next request. */
const RETRY_AFTER_MS = 30_000;

export class Upstream {
  status: UpstreamStatus = "idle";
  /** Plain-language problem, safe to show the user and the model. */
  error?: string;
  tools: Tool[] = [];
  lastUsed = 0;
  private client?: Client;
  private starting?: Promise<void>;
  private failedAt = 0;
  private readonly secretsToRedact: string[];

  constructor(
    readonly owner: ClientConfig,
    readonly conn: ConnectionConfig,
    private readonly onToolsChanged: (u: Upstream) => void,
    private readonly log: Logger,
  ) {
    const values = conn.kind === "remote" ? Object.values(conn.headers ?? {}) : Object.values(conn.env ?? {});
    this.secretsToRedact = values.filter((v) => v.length >= 6);
    if (conn.missingKeys?.length) {
      this.status = "needs_key";
      this.error = `${conn.name} for ${owner.name} needs ${conn.missingKeys.join(" and ")}. Add it in Ringkeeper Connect under ${owner.name} > ${conn.name}.`;
    }
  }

  private redact(text: string): string {
    let out = text;
    for (const s of this.secretsToRedact) out = out.split(s).join("•••");
    return out;
  }

  /** Start if not started (or retry a failed start after a pause). Resolves when settled. */
  ensureStarted(): Promise<void> {
    this.lastUsed = Date.now();
    if (this.status === "needs_key" || this.status === "ready") return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.status === "error" && Date.now() - this.failedAt < RETRY_AFTER_MS) return Promise.resolve();
    this.starting = this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  /** Start and wait, but give up waiting after `timeoutMs` (the start carries on). */
  async whenSettled(timeoutMs: number): Promise<void> {
    await Promise.race([this.ensureStarted(), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  private makeTransport(): Transport {
    const c = this.conn;
    if (c.kind === "remote") {
      return new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers: c.headers ?? {} } });
    }
    const t = new StdioClientTransport({
      command: c.command,
      args: c.args ?? [],
      env: { ...getDefaultEnvironment(), ...(c.env ?? {}) },
      stderr: "pipe",
    });
    // Must drain stderr or a chatty server blocks once the pipe buffer fills.
    t.stderr?.on("data", (chunk: Buffer) => {
      this.log({ ev: "upstream_stderr", client: this.owner.id, conn: this.conn.id, text: this.redact(chunk.toString()).slice(0, 500) });
    });
    return t;
  }

  private async start(): Promise<void> {
    this.status = "starting";
    this.error = undefined;
    const client = new Client({ name: "ringkeeper-connect", version: "0.1.0" }, { capabilities: {} });
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.refreshTools().catch(() => {});
      this.onToolsChanged(this);
    });
    client.onclose = () => {
      if (this.client === client && this.status === "ready") {
        this.status = "error";
        this.failedAt = Date.now();
        this.error = `${this.conn.name} for ${this.owner.name} stopped unexpectedly. It will restart the next time it's needed.`;
        this.client = undefined;
        this.log({ ev: "upstream_closed", client: this.owner.id, conn: this.conn.id });
        this.onToolsChanged(this);
      }
    };
    try {
      await client.connect(this.makeTransport());
      this.client = client;
      await this.refreshTools();
      this.status = "ready";
      this.log({ ev: "upstream_ready", client: this.owner.id, conn: this.conn.id, tools: this.tools.length });
    } catch (err) {
      await client.close().catch(() => {});
      this.client = undefined;
      this.status = "error";
      this.failedAt = Date.now();
      this.error = this.explain(err);
      this.log({ ev: "upstream_error", client: this.owner.id, conn: this.conn.id, error: this.redact(String(err)).slice(0, 500) });
    } finally {
      this.onToolsChanged(this);
    }
  }

  /** Turn a start failure into something an agency owner can act on. */
  private explain(err: unknown): string {
    const who = `${this.conn.name} for ${this.owner.name}`;
    const where = `${this.owner.name} > ${this.conn.name}`;
    const e = err as NodeJS.ErrnoException;
    const httpStatus = err instanceof StreamableHTTPError ? (err as unknown as { code?: number }).code : undefined;
    if (httpStatus === 401 || httpStatus === 403) {
      return `${who} didn't accept the key. Update it in Ringkeeper Connect under ${where}.`;
    }
    if (httpStatus === 404) {
      return `${who}'s web address wasn't found. Check it in Ringkeeper Connect under ${where}.`;
    }
    if (e?.code === "ENOENT" && this.conn.kind !== "remote") {
      return `Couldn't start ${who}: the program "${this.conn.command}" isn't on this computer.`;
    }
    if (this.conn.kind === "remote" && /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(String(err))) {
      return `Couldn't reach ${who}. Check your internet connection and the web address under ${where}.`;
    }
    if (/Connection closed/i.test(String(err))) {
      return `${who} stopped right after starting. Check its settings under ${where}.`;
    }
    return `${who} isn't working right now. Check its settings under ${where}, then try again.`;
  }

  private async refreshTools(): Promise<void> {
    if (!this.client) return;
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    await this.ensureStarted();
    if (!this.client || this.status !== "ready") {
      throw new Error(this.error ?? `${this.conn.name} for ${this.owner.name} isn't ready yet.`);
    }
    this.lastUsed = Date.now();
    return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
  }

  async stop(): Promise<void> {
    const wasRunning = this.client;
    this.status = this.conn.missingKeys?.length ? "needs_key" : "stopped";
    this.client = undefined;
    this.tools = [];
    await wasRunning?.close().catch(() => {});
  }

  /** Stopped because it was idle: can start again later. */
  async park(): Promise<void> {
    await this.stop();
    if (this.status === "stopped") this.status = "idle";
    this.log({ ev: "upstream_parked", client: this.owner.id, conn: this.conn.id });
  }
}
