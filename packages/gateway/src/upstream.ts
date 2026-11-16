// One upstream connection: a local server the gateway launches for one client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ClientConfig, ConnectionConfig } from "./config.js";
import type { Logger } from "./log.js";

export type UpstreamStatus = "starting" | "ready" | "error" | "stopped";

export class Upstream {
  status: UpstreamStatus = "starting";
  error?: string;
  tools: Tool[] = [];
  private client?: Client;
  private ready: Promise<void>;
  private resolveReady!: () => void;

  constructor(
    readonly owner: ClientConfig,
    readonly conn: ConnectionConfig,
    private readonly onToolsChanged: (u: Upstream) => void,
    private readonly log: Logger,
  ) {
    this.ready = new Promise((r) => (this.resolveReady = r));
  }

  async start(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.conn.command,
      args: this.conn.args ?? [],
      env: { ...getDefaultEnvironment(), ...(this.conn.env ?? {}) },
      stderr: "pipe",
    });
    // Must drain stderr or a chatty server blocks once the pipe buffer fills.
    transport.stderr?.on("data", (chunk: Buffer) => {
      this.log({ ev: "upstream_stderr", client: this.owner.id, conn: this.conn.id, text: chunk.toString().slice(0, 500) });
    });
    const client = new Client({ name: "ringkeeper-connect", version: "0.0.1" }, { capabilities: {} });
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.refreshTools();
      this.onToolsChanged(this);
    });
    client.onclose = () => {
      if (this.status !== "stopped") {
        this.status = "error";
        this.error = "The connection stopped unexpectedly.";
        this.log({ ev: "upstream_closed", client: this.owner.id, conn: this.conn.id });
      }
    };
    try {
      await client.connect(transport);
      this.client = client;
      await this.refreshTools();
      this.status = "ready";
      this.log({ ev: "upstream_ready", client: this.owner.id, conn: this.conn.id, tools: this.tools.length });
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.log({ ev: "upstream_error", client: this.owner.id, conn: this.conn.id, error: this.error });
    } finally {
      this.resolveReady();
      this.onToolsChanged(this);
    }
  }

  /** Resolves once the first start attempt finished (ready or failed), or after the timeout. */
  async whenSettled(timeoutMs: number): Promise<void> {
    await Promise.race([this.ready, new Promise((r) => setTimeout(r, timeoutMs))]);
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
    if (!this.client || this.status !== "ready") {
      throw new Error(this.error ?? "This connection isn't ready yet.");
    }
    return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    await this.client?.close().catch(() => {});
  }
}
