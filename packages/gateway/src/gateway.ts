// The gateway: one MCP endpoint on 127.0.0.1 that shows the active client's
// tools and routes each call to that client's upstream connection.
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type CallToolResult,
  type JSONRPCMessage,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  TOOL_PREFIX_SEPARATOR,
  connectionFingerprint,
  findClient,
  type ClientConfig,
  type GatewayConfig,
} from "./config.js";
import { Upstream, type UpstreamEnv, type UpstreamStatus } from "./upstream.js";
import { originalArguments, safeInputSchema } from "./schema-names.js";
import { nullLogger, type Logger } from "./log.js";
import { DEFAULT_GUARD, actionKind, type ActionKind, type Activity } from "./guard.js";
import {
  META_CALL_TOOL,
  META_HELP,
  META_LIST_CLIENTS,
  META_SEARCH_TOOLS,
  META_USE_CLIENT,
  fixedModeTools,
  metaTools,
  serverInstructions,
  toolModeFor,
  type ToolMode,
} from "./meta-tools.js";

export const CLIENT_ARG = "ringkeeper_client";

/**
 * What the person is asked before a deletion. The first line becomes the headline (after the
 * client's name); the rest is shown below it. What the AI sent is shown, shortened, so the
 * person can see what would go. It is shown on this computer only and never written to the log.
 */
export function deleteQuestion(tool: string, args: Record<string, unknown>): string {
  let sent = "";
  try {
    sent = JSON.stringify(args);
  } catch {
    sent = "";
  }
  if (sent === "{}") sent = "";
  if (sent.length > 400) sent = `${sent.slice(0, 400)}…`;
  return `Let the AI run "${tool}"?\n\nIt looks like this deletes or removes something, and that usually can't be undone.${sent ? `\n\nWhat it sent: ${sent}` : ""}`;
}
const VERSION = "0.1.0";
const UPSTREAM_WAIT_MS = 10_000;
const MAX_TOOL_NAME = 64;

export interface GatewayTimings {
  /** Stop a non-active client's connections after this long unused. */
  upstreamIdleMs: number;
  /** Forget a host session with no open stream after this long without requests. */
  sessionIdleMs: number;
  /** How often to check for both. */
  sweepMs: number;
}

const DEFAULT_TIMINGS: GatewayTimings = { upstreamIdleMs: 10 * 60_000, sessionIdleMs: 30 * 60_000, sweepMs: 60_000 };

/** Who changed the active client. */
export type SwitchSource = { by: "app" } | { by: "ai"; host: string };

export interface ConnectionStatus {
  clientId: string;
  connectionId: string;
  status: UpstreamStatus;
  /** Plain-language problem, if any. */
  problem?: string;
  tools: number;
}

export interface GatewayOptions {
  config: GatewayConfig;
  activeClientId: string | null;
  token: string;
  /** Preferred port (picked once at install). Falls back to a free one if taken. */
  port: number;
  log?: Logger;
  onActiveClientChanged?: (clientId: string, source: SwitchSource) => void;
  onStatusChanged?: () => void;
  timings?: Partial<GatewayTimings>;
  /** Bundled Node/uv and the OAuth sign-in store, for upstream connections. */
  upstreamEnv?: UpstreamEnv;
  /**
   * An AI app connected and introduced itself: proof that it really uses us.
   * `app` comes from the bridge (which knows which app launched it), or from
   * the name the app reports; `hostName` is that reported name.
   */
  onAppContact?: (contact: { app?: string; hostName?: string; at: number }) => void;
  /**
   * Answers ringkeeper_help: a guide plus what's set up on this computer. Must
   * never include a key. `host` is the AI app asking, by the name people know.
   */
  help?: (request: { question: string; host: string }) => string | Promise<string>;
  /** Something was done, or refused, for a client. Never carries what was sent or returned. */
  onActivity?: (activity: Activity) => void;
}

interface Session {
  id: string;
  server: Server;
  transport: StreamableHTTPServerTransport;
  hostName?: string;
  host?: string;
  mode: ToolMode;
  /** Whether the host currently holds its listening (GET) stream open. */
  streamOpen: boolean;
  /** A tools-changed notice the host hasn't received yet. */
  pendingListChanged: boolean;
  lastSeen: number;
}

const LIST_CHANGED = { method: "notifications/tools/list_changed" as const };

/** The name people know each AI app by. */
export function hostLabel(hostName: string | undefined): string {
  if (!hostName) return "An AI app";
  if (hostName === "claude-code") return "Claude Code";
  if (hostName.startsWith("cursor")) return "Cursor";
  if (hostName === "claude-ai" || hostName.startsWith("local-agent-mode-")) return "Claude Desktop";
  return hostName;
}

export class Gateway {
  private upstreams: Upstream[] = [];
  private readonly sessions = new Map<string, Session>();
  private httpServer?: http.Server;
  private activeClientId: string | null;
  private config: GatewayConfig;
  private readonly log: Logger;
  private readonly timings: GatewayTimings;
  private sweepTimer?: NodeJS.Timeout;
  port = 0;
  usedFallbackPort = false;

  constructor(private readonly opts: GatewayOptions) {
    this.log = opts.log ?? nullLogger;
    this.config = opts.config;
    this.timings = { ...DEFAULT_TIMINGS, ...(opts.timings ?? {}) };
    this.activeClientId = this.pickActive(opts.activeClientId);
  }

  private pickActive(wanted: string | null): string | null {
    if (wanted && findClient(this.config, wanted)) return findClient(this.config, wanted)!.id;
    return this.config.clients[0]?.id ?? null;
  }

  get activeClient(): ClientConfig | undefined {
    return this.config.clients.find((c) => c.id === this.activeClientId);
  }

  get options() {
    return this.config.options;
  }

  async start(): Promise<number> {
    this.syncUpstreams();
    this.prewarmActive();
    this.port = await this.listen(this.opts.port);
    this.sweepTimer = setInterval(() => this.sweep(), this.timings.sweepMs);
    this.sweepTimer.unref();
    this.log({ ev: "gateway_started", port: this.port, fallback: this.usedFallbackPort, active: this.activeClientId });
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const s of this.sessions.values()) await s.transport.close().catch(() => {});
    this.sessions.clear();
    await Promise.all(this.upstreams.map((u) => u.stop()));
    await new Promise<void>((r) => (this.httpServer ? this.httpServer.close(() => r()) : r()));
    this.httpServer?.closeAllConnections?.();
  }

  // ---------- config ----------

  /**
   * Take a new config (clients, connections, keys or settings changed).
   * Connections whose settings didn't change keep running.
   */
  applyConfig(config: GatewayConfig, activeClientId?: string | null): void {
    this.config = config;
    const wanted = activeClientId === undefined ? this.activeClientId : activeClientId;
    const before = this.activeClientId;
    this.activeClientId = this.pickActive(wanted);
    this.syncUpstreams();
    this.prewarmActive();
    this.log({ ev: "config_applied", clients: config.clients.length, active: this.activeClientId });
    if (before !== this.activeClientId && this.activeClientId) {
      this.opts.onActiveClientChanged?.(this.activeClientId, { by: "app" });
    }
    this.notifyToolsChanged("config_changed");
    this.opts.onStatusChanged?.();
  }

  private syncUpstreams(): void {
    const next: Upstream[] = [];
    const keep = new Set<Upstream>();
    for (const client of this.config.clients) {
      for (const conn of client.connections) {
        const existing = this.upstreams.find(
          (u) =>
            u.owner.id === client.id &&
            u.conn.id === conn.id &&
            connectionFingerprint(u.conn) === connectionFingerprint(conn),
        );
        if (existing) {
          // Same settings: keep it running, but pick up renamed client/connection.
          Object.assign(existing.owner, { name: client.name });
          Object.assign(existing.conn, { name: conn.name });
          keep.add(existing);
          next.push(existing);
        } else {
          next.push(new Upstream({ ...client }, conn, (u) => this.onUpstreamChanged(u), this.log, this.opts.upstreamEnv));
        }
      }
    }
    for (const u of this.upstreams) if (!keep.has(u)) void u.stop();
    this.upstreams = next;
  }

  /** Start one connection afresh (after the user signs in again, say). */
  restartConnection(clientId: string, connectionId: string): void {
    const i = this.upstreams.findIndex((u) => u.owner.id === clientId && u.conn.id === connectionId);
    const old = this.upstreams[i];
    if (!old) return;
    const fresh = new Upstream(old.owner, old.conn, (u) => this.onUpstreamChanged(u), this.log, this.opts.upstreamEnv);
    this.upstreams[i] = fresh;
    void old.stop();
    if (clientId === this.activeClientId) void fresh.ensureStarted();
    this.opts.onStatusChanged?.();
  }

  private prewarmActive(): void {
    for (const u of this.upstreams) if (u.owner.id === this.activeClientId) void u.ensureStarted();
  }

  // ---------- active client ----------

  /** `from` is the session that asked for the switch (an AI app); it gets the notice inline with its reply. */
  setActiveClient(idOrName: string, from?: Session): ClientConfig {
    const client = findClient(this.config, idOrName);
    if (!client) {
      const names = this.config.clients.map((c) => c.name).join(", ");
      throw new UserFacingError(
        names ? `There's no client called "${idOrName}". The clients are: ${names}.` : "No clients are set up yet. Add one in Ringkeeper Connect.",
      );
    }
    if (client.id !== this.activeClientId) {
      this.activeClientId = client.id;
      const source: SwitchSource = from ? { by: "ai", host: hostLabel(from.hostName) } : { by: "app" };
      this.log({ ev: "active_client_changed", active: client.id, by: source.by, host: from?.hostName });
      this.prewarmActive();
      this.opts.onActiveClientChanged?.(client.id, source);
      this.notifyToolsChanged("active_client_changed", from);
      this.opts.onStatusChanged?.();
    }
    return client;
  }

  private onUpstreamChanged(u: Upstream): void {
    if (u.owner.id === this.activeClientId) this.notifyToolsChanged(`upstream:${u.conn.id}`);
    this.opts.onStatusChanged?.();
  }

  // Notices sent while a host has no listening stream open are dropped by the
  // transport, so remember them and deliver on the next stream or request.
  private notifyToolsChanged(reason: string, skip?: Session): void {
    for (const s of this.sessions.values()) {
      // Fixed-mode tool lists never change, so there's nothing to tell those hosts.
      if (s === skip || s.mode === "fixed") continue;
      if (!s.streamOpen) {
        s.pendingListChanged = true;
        this.log({ ev: "list_changed_pending", session: short(s.id), reason });
        continue;
      }
      this.sendListChanged(s, reason);
    }
  }

  private sendListChanged(s: Session, reason: string): void {
    s.pendingListChanged = false;
    this.log({ ev: "send_list_changed", session: short(s.id), reason });
    s.server.notification(LIST_CHANGED).catch((err) => {
      s.pendingListChanged = true;
      this.log({ ev: "send_list_changed_failed", session: short(s.id), error: String(err) });
    });
  }

  // ---------- housekeeping ----------

  /** Park idle connections of other clients and forget abandoned host sessions. */
  sweep(now = Date.now()): void {
    for (const u of this.upstreams) {
      if (u.owner.id !== this.activeClientId && u.status === "ready" && now - u.lastUsed > this.timings.upstreamIdleMs) {
        void u.park().then(() => this.opts.onStatusChanged?.());
      }
    }
    for (const s of [...this.sessions.values()]) {
      if (!s.streamOpen && now - s.lastSeen > this.timings.sessionIdleMs) {
        this.log({ ev: "session_expired", session: short(s.id), host: s.hostName });
        this.sessions.delete(s.id);
        void s.transport.close().catch(() => {});
      }
    }
  }

  connectionStatuses(): ConnectionStatus[] {
    return this.upstreams.map((u) => ({
      clientId: u.owner.id,
      connectionId: u.conn.id,
      status: u.status,
      problem: u.status === "error" || u.status === "needs_key" || u.status === "needs_signin" ? u.error : undefined,
      tools: u.tools.length,
    }));
  }

  // ---------- tools ----------

  private get clientNames(): string[] {
    return this.config.clients.map((c) => c.name);
  }

  modeForHost(hostName: string | undefined): ToolMode {
    return toolModeFor(hostName, this.options.dynamicHosts);
  }

  async listExposedTools(mode: ToolMode = "dynamic"): Promise<Tool[]> {
    if (mode === "fixed") return fixedModeTools(this.clientNames);
    return [...metaTools(this.clientNames), ...(await this.activeClientTools())];
  }

  private activeUpstreams(): Upstream[] {
    return this.upstreams.filter((u) => u.owner.id === this.activeClientId);
  }

  /** The active client's tools, prefixed and labelled, as a dynamic-mode host sees them. */
  private async activeClientTools(withClientArg = this.options.requireClientArg): Promise<Tool[]> {
    const client = this.activeClient;
    if (!client) return [];
    const mine = this.activeUpstreams();
    await Promise.all(mine.map((u) => u.whenSettled(UPSTREAM_WAIT_MS)));
    const tools: Tool[] = [];
    for (const u of mine) {
      if (u.status !== "ready") continue;
      for (const t of u.tools) {
        const exposed = this.exposeTool(client, u, t, withClientArg);
        if (exposed.name.length > MAX_TOOL_NAME) {
          this.log({ ev: "tool_name_too_long", tool: exposed.name });
          continue;
        }
        tools.push(exposed);
      }
    }
    return tools;
  }

  private exposeTool(client: ClientConfig, u: Upstream, t: Tool, withClientArg: boolean): Tool {
    // Input names AI apps refuse (Twilio's "DateSent<") are shown under valid ones; see schema-names.ts.
    const inputSchema = structuredClone(safeInputSchema(t.inputSchema ?? { type: "object" }).schema) as Tool["inputSchema"];
    if (withClientArg) {
      inputSchema.properties = {
        ...(inputSchema.properties ?? {}),
        [CLIENT_ARG]: {
          type: "string",
          description:
            "The client this call is for, by name. It must be the active client; if the user means a different client, call ringkeeper_use_client first.",
        },
      };
      inputSchema.required = [...(inputSchema.required ?? []).filter((r) => r !== CLIENT_ARG), CLIENT_ARG];
    }
    return {
      ...t,
      name: `${u.conn.id}${TOOL_PREFIX_SEPARATOR}${t.name}`,
      description: `[${client.name}'s ${u.conn.name}, via Ringkeeper Connect] ${t.description ?? ""}`.trim(),
      inputSchema,
    };
  }

  /** Plain lines about connections of the active client that aren't working. */
  private activeProblems(): string[] {
    return this.activeUpstreams()
      .filter((u) => (u.status === "error" || u.status === "needs_key" || u.status === "needs_signin") && u.error)
      .map((u) => u.error!);
  }

  async callTool(name: string, args: Record<string, unknown>, from?: Session): Promise<CallToolResult> {
    try {
      if (name === META_LIST_CLIENTS) return this.listClientsResult();
      if (name === META_HELP) {
        const question = typeof args.question === "string" ? args.question.slice(0, 2000) : "";
        this.log({ ev: "help_asked", host: from?.hostName });
        if (!this.opts.help) return text("Ringkeeper Connect's help isn't available here. Open the Ringkeeper Connect window and click How it works.");
        return text(await this.opts.help({ question, host: hostLabel(from?.hostName) }));
      }
      if (name === META_USE_CLIENT) {
        const wanted = typeof args.client === "string" ? args.client : "";
        const client = this.setActiveClient(wanted, from);
        const toolNames = (await this.activeClientTools(false)).map((t) => t.name);
        const how = from?.mode === "fixed" ? ` Find and run them with ${META_SEARCH_TOOLS} and ${META_CALL_TOOL}.` : "";
        const problems = this.activeProblems();
        return text(
          `Now working with ${client.name}, in every chat of this app. Its tools: ${toolNames.join(", ") || "none yet"}.${how}` +
            (problems.length ? `\nNot working right now: ${problems.join(" ")}` : ""),
        );
      }
      if (name === META_SEARCH_TOOLS) return await this.searchTools(typeof args.query === "string" ? args.query : "");
      if (name === META_CALL_TOOL) {
        const tool = typeof args.tool === "string" ? await this.resolveToolName(args.tool) : "";
        const toolArgs = (args.arguments && typeof args.arguments === "object" ? args.arguments : {}) as Record<string, unknown>;
        return await this.callProxied(tool, toolArgs, { required: true, value: args.client }, from);
      }
      const forwarded = { ...args };
      const claimed = forwarded[CLIENT_ARG];
      delete forwarded[CLIENT_ARG];
      return await this.callProxied(name, forwarded, { required: this.options.requireClientArg, value: claimed }, from);
    } catch (err) {
      if (err instanceof UserFacingError) return errorResult(err.message);
      this.log({ ev: "call_failed", tool: name, error: String(err).slice(0, 300) });
      return errorResult(`Something went wrong running ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private requireActive(): ClientConfig {
    const active = this.activeClient;
    if (!active) throw new UserFacingError("No clients are set up yet. Add one in Ringkeeper Connect, then try again.");
    return active;
  }

  /** Accept "list_bases" as well as "airtable_main__list_bases" when it's unambiguous in the active client. */
  private async resolveToolName(tool: string): Promise<string> {
    if (tool.includes(TOOL_PREFIX_SEPARATOR)) return tool;
    const mine = this.activeUpstreams();
    await Promise.all(mine.map((u) => u.whenSettled(UPSTREAM_WAIT_MS)));
    const matches = mine.filter((u) => u.tools.some((t) => t.name === tool));
    return matches.length === 1 ? `${matches[0]!.conn.id}${TOOL_PREFIX_SEPARATOR}${tool}` : tool;
  }

  private async searchTools(query: string): Promise<CallToolResult> {
    const client = this.requireActive();
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = await this.activeClientTools(false);
    const hits = all.filter((t) => {
      const hay = `${t.name} ${t.description ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const shown = hits.length ? hits : all;
    const header =
      hits.length || !words.length
        ? `Tools for ${client.name} (the active client):`
        : `No ${client.name} tool matched "${query}", so here are all of them:`;
    const list = shown.map((t) => ({ name: t.name, description: t.description, arguments: t.inputSchema }));
    const problems = this.activeProblems();
    return {
      content: [
        { type: "text", text: `[Client: ${client.name}]` },
        {
          type: "text",
          text:
            `${header}\n${JSON.stringify(list, null, 1)}\n\nRun one with ${META_CALL_TOOL} (client: "${client.name}").` +
            (problems.length ? `\nNot working right now (tell the user; don't use another connector instead): ${problems.join(" ")}` : ""),
        },
      ],
      _meta: { "ringkeeper/client": client.id },
    };
  }

  private async callProxied(
    name: string,
    args: Record<string, unknown>,
    claim: { required: boolean; value: unknown },
    from?: Session,
  ): Promise<CallToolResult> {
    const active = this.requireActive();
    const sep = name.indexOf(TOOL_PREFIX_SEPARATOR);
    const connId = sep > 0 ? name.slice(0, sep) : "";
    const toolName = sep > 0 ? name.slice(sep + TOOL_PREFIX_SEPARATOR.length) : name;
    const upstream = this.activeUpstreams().find((u) => u.conn.id === connId);
    // A host may call a tool it remembers before that connection finished starting.
    if (upstream) await upstream.whenSettled(UPSTREAM_WAIT_MS);

    if (upstream && (upstream.status === "error" || upstream.status === "needs_key" || upstream.status === "needs_signin")) {
      this.log({ ev: "refused_connection_not_working", tool: name, client: active.id, status: upstream.status });
      throw new UserFacingError(`${upstream.error} Nothing was run. Don't use another connector for ${active.name}'s data instead.`);
    }

    if (!upstream || !upstream.tools.some((t) => t.name === toolName)) {
      // Don't start other clients' connections just to explain; their names are enough.
      const elsewhere = this.upstreams.find((u) => u.owner.id !== active.id && u.conn.id === connId);
      this.log({ ev: "refused_not_in_active_client", tool: name, active: active.id, owner: elsewhere?.owner.id });
      if (elsewhere) {
        throw new UserFacingError(
          `${name} belongs to ${elsewhere.owner.name}, but the active client is ${active.name}. Call ringkeeper_use_client with "${elsewhere.owner.name}" first.`,
        );
      }
      throw new UserFacingError(
        `${active.name} has no tool called ${name || "that"}. Call ${META_SEARCH_TOOLS} or ${META_LIST_CLIENTS} to see what's available, and don't use another connector instead.`,
      );
    }

    const tool = upstream.tools.find((t) => t.name === toolName)!;
    const kind = actionKind(tool);
    const note = (outcome: Activity["outcome"]): void => {
      try {
        this.opts.onActivity?.({ at: Date.now(), clientId: active.id, connectionId: upstream.conn.id, connectionName: upstream.conn.name, tool: toolName, kind, app: hostLabel(from?.hostName), outcome });
      } catch {
        // Keeping the list must never break a call.
      }
    };

    if (claim.required) {
      const claimed = claim.value;
      if (typeof claimed !== "string" || claimed.trim() === "") {
        this.log({ ev: "refused_client_arg_missing", tool: name, active: active.id });
        throw new UserFacingError(`Say which client this is for (the active client is ${active.name}).`);
      }
      const claimedClient = findClient(this.config, claimed);
      if (!claimedClient || claimedClient.id !== active.id) {
        this.log({ ev: "refused_client_arg_mismatch", tool: name, active: active.id, claimed });
        note("wrong_client");
        throw new UserFacingError(
          `This call says it's for "${claimed}", but the active client is ${active.name}. Nothing was run. If you meant ${claimed}, call ringkeeper_use_client first.`,
        );
      }
    }

    const schema = tool.inputSchema;
    const original = schema ? (originalArguments(args, safeInputSchema(schema).map) as Record<string, unknown>) : args;

    // What this client allows. Ordinary changes are left to the AI app's own permission mode.
    const guard = active.guard ?? DEFAULT_GUARD;
    if (guard === "look_only" && kind !== "read") {
      this.log({ ev: "refused_look_only", tool: name, client: active.id, kind });
      note("look_only");
      throw new UserFacingError(
        `${active.name} is set to "Look only" in Ringkeeper Connect, so ${name} wasn't run and nothing was changed. Tell the user: they can change this on ${active.name}'s page in Ringkeeper Connect.`,
      );
    }
    if (guard === "ask_delete" && kind === "delete") {
      const ask = this.opts.upstreamEnv?.approve;
      const allowed = ask
        ? await ask({ clientName: active.name, connectionName: upstream.conn.name, message: deleteQuestion(toolName, original) }).catch(() => false)
        : false;
      if (!allowed) {
        this.log({ ev: "refused_delete_not_allowed", tool: name, client: active.id, asked: !!ask });
        note("not_allowed");
        throw new UserFacingError(
          ask
            ? `The user didn't allow ${name} for ${active.name} in Ringkeeper Connect (it asks before anything is deleted). Nothing was deleted. Don't try another way: ask the user.`
            : `${name} would delete something for ${active.name}, and Ringkeeper Connect couldn't ask the user first. Nothing was deleted.`,
        );
      }
    }

    this.log({ ev: "call_proxied", tool: name, client: active.id, kind });
    let result: CallToolResult;
    try {
      result = await upstream.callTool(toolName, original);
    } catch (err) {
      note("failed");
      throw err;
    }
    note(result.isError ? "failed" : "ran");
    return labelResult(result, active, upstream.conn.name);
  }

  private listClientsResult(): CallToolResult {
    if (!this.config.clients.length) return text("No clients are set up yet. Add one in Ringkeeper Connect.");
    const statusWord = (s: UpstreamStatus) =>
      s === "needs_key" ? "needs a key" : s === "needs_signin" ? "needs sign-in" : s === "error" ? "not working" : s === "ready" ? "ready" : "starts when needed";
    const lines = this.config.clients.map((c) => {
      const isActive = c.id === this.activeClientId;
      const conns =
        c.connections
          .map((x) => {
            const u = this.upstreams.find((up) => up.owner.id === c.id && up.conn.id === x.id);
            return isActive && u ? `${x.name}: ${statusWord(u.status)}` : x.name;
          })
          .join(", ") || "no connections yet";
      return `${isActive ? "* " : "  "}${c.name} (${conns})${isActive ? " ← active" : ""}`;
    });
    const problems = this.activeProblems();
    return text(
      `Clients in Ringkeeper Connect:\n${lines.join("\n")}\n\nSwitch with ringkeeper_use_client. Switching applies to every chat in this app.` +
        (problems.length ? `\n\n${problems.join("\n")}` : ""),
    );
  }

  // ---------- HTTP ----------

  private listen(preferred: number): Promise<number> {
    const server = http.createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        this.log({ ev: "http_error", error: String(err) });
        if (!res.headersSent) sendJson(res, 500, { error: "Ringkeeper Connect hit an internal error." });
      });
    });
    this.httpServer = server;
    const tryPort = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve((server.address() as AddressInfo).port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
    return tryPort(preferred).catch((err: NodeJS.ErrnoException) => {
      // EACCES happens on Windows when the port falls in an excluded range.
      if (err.code !== "EADDRINUSE" && err.code !== "EACCES") throw err;
      this.usedFallbackPort = true;
      this.log({ ev: "port_fallback", preferred, code: err.code });
      return tryPort(0);
    });
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const expected = `Bearer ${this.opts.token}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") return sendJson(res, 200, { app: "ringkeeper-connect", version: VERSION });

    if (!this.authorized(req)) {
      this.log({ ev: "http_unauthorized", path: url.pathname, method: req.method });
      return sendJson(res, 401, { error: "Ringkeeper Connect didn't recognise this app. Reconnect it from Ringkeeper Connect." });
    }

    if (url.pathname.startsWith("/admin/")) return this.handleAdmin(url.pathname, req, res);
    if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "Not found" });

    const sessionId = header(req, "mcp-session-id");
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session) session.lastSeen = Date.now();
    this.log({ ev: "http", method: req.method, session: sessionId ? short(sessionId) : undefined, known: !!session });

    if (req.method === "POST") {
      const body = await readBody(req);
      if (session) return session.transport.handleRequest(req, res, body);
      if (!sessionId && isInitializeRequest(body)) return this.createSession(req, res, body);
      if (sessionId) return sendJsonRpcError(res, 404, "This session has ended. Reconnect to continue.");
      return sendJsonRpcError(res, 400, "Start with an initialize request.");
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!session) return sendJsonRpcError(res, sessionId ? 404 : 400, "Unknown or missing session.");
      if (req.method === "GET") {
        session.streamOpen = true;
        res.on("close", () => {
          session.streamOpen = false;
          session.lastSeen = Date.now();
          this.log({ ev: "stream_closed", session: short(session.id) });
        });
        // Let the transport register the stream before flushing a held notice.
        if (session.pendingListChanged) setTimeout(() => session.streamOpen && this.sendListChanged(session, "flush_on_stream"), 100);
      }
      return session.transport.handleRequest(req, res);
    }

    res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
  }

  private async createSession(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> {
    const hostName = (body as { params?: { clientInfo?: { name?: string } } }).params?.clientInfo?.name;
    // The bridge says which app launched it (RINGKEEPER_APP in that app's settings).
    const declaredApp = header(req, "x-ringkeeper-app");
    const mode = this.modeForHost(hostName);
    const session = {
      id: "",
      hostName,
      mode,
      streamOpen: false,
      pendingListChanged: false,
      lastSeen: Date.now(),
    } as unknown as Session;
    const server = this.createSessionServer(session);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      keepAliveMs: 15_000,
      onsessioninitialized: (id) => {
        session.id = id;
        this.sessions.set(id, session);
        this.log({ ev: "session_created", session: short(id), via: userAgentKind(req.headers["user-agent"]), host: hostName, mode });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId && this.sessions.get(transport.sessionId) === session) {
        this.sessions.delete(transport.sessionId);
        this.log({ ev: "session_closed", session: short(transport.sessionId) });
      }
    };
    server.oninitialized = () => {
      const info = server.getClientVersion();
      session.host = info ? `${info.name} ${info.version}` : undefined;
      this.log({
        ev: "host_initialized",
        session: transport.sessionId ? short(transport.sessionId) : undefined,
        host: info,
        app: declaredApp,
        capabilities: server.getClientCapabilities(),
      });
      this.opts.onAppContact?.({ app: declaredApp, hostName: info?.name ?? hostName, at: Date.now() });
    };
    session.server = server;
    session.transport = transport;
    await server.connect(transport);
    // Log every inbound method so we can see whether a host re-fetches tools after list_changed.
    const orig = transport.onmessage;
    transport.onmessage = (msg: JSONRPCMessage, extra) => {
      if ("method" in msg) {
        const tool = msg.method === "tools/call" ? (msg.params as { name?: string } | undefined)?.name : undefined;
        this.log({ ev: "rpc_in", session: transport.sessionId ? short(transport.sessionId) : undefined, method: msg.method, tool });
      }
      orig?.(msg, extra);
    };
    await transport.handleRequest(req, res, body);
  }

  private createSessionServer(session: Session): Server {
    const server = new Server(
      { name: "ringkeeper-connect", title: "Ringkeeper Connect", version: VERSION },
      {
        capabilities: { tools: { listChanged: session.mode === "dynamic" } },
        instructions: serverInstructions(session.mode, this.clientNames),
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      session.pendingListChanged = false;
      return { tools: await this.listExposedTools(session.mode) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      const result = await this.callTool(name, (request.params.arguments ?? {}) as Record<string, unknown>, session);
      // Deliver the notice on this reply's own stream: it doesn't depend on the
      // host keeping a listening stream open.
      const switched = name === META_USE_CLIENT && !result.isError;
      if (session.mode === "dynamic" && (switched || session.pendingListChanged)) {
        session.pendingListChanged = false;
        this.log({ ev: "send_list_changed_inline", session: short(session.id), tool: name });
        await extra.sendNotification(LIST_CHANGED).catch(() => {});
      }
      return result;
    });
    return server;
  }

  private async handleAdmin(path: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (path === "/admin/state" && req.method === "GET") {
      return sendJson(res, 200, this.state());
    }
    if (path === "/admin/active-client" && req.method === "POST") {
      const body = (await readBody(req)) as { client?: string } | undefined;
      try {
        const c = this.setActiveClient(body?.client ?? "");
        return sendJson(res, 200, { active: c.id });
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (path === "/admin/options" && req.method === "POST") {
      const body = (await readBody(req)) as Partial<GatewayConfig["options"]> | undefined;
      const options = { ...this.options };
      if (body && typeof body.requireClientArg === "boolean") options.requireClientArg = body.requireClientArg;
      // Applies to sessions that start after the change.
      if (body && Array.isArray(body.dynamicHosts)) options.dynamicHosts = body.dynamicHosts.map(String);
      this.applyConfig({ ...this.config, options });
      return sendJson(res, 200, this.options);
    }
    if (path === "/admin/shutdown" && req.method === "POST") {
      sendJson(res, 200, { ok: true });
      setTimeout(() => process.emit("SIGTERM"), 50);
      return;
    }
    return sendJson(res, 404, { error: "Not found" });
  }

  state() {
    return {
      port: this.port,
      active: this.activeClientId,
      options: this.options,
      sessions: [...this.sessions.values()].map((s) => ({ id: short(s.id), host: s.host, mode: s.mode, streamOpen: s.streamOpen })),
      upstreams: this.connectionStatuses(),
    };
  }
}

export class UserFacingError extends Error {}

function labelResult(result: CallToolResult, client: ClientConfig, connName: string): CallToolResult {
  const label = { type: "text" as const, text: `[Client: ${client.name} · ${connName}]` };
  return {
    ...result,
    content: [label, ...(result.content ?? [])],
    _meta: { ...(result._meta ?? {}), "ringkeeper/client": client.id },
  };
}

function text(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }] };
}

function errorResult(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }], isError: true };
}

/** The bridge talks over Node's fetch ("node"); anything else is a host connecting directly. */
function userAgentKind(ua: string | undefined): string {
  if (!ua) return "unknown";
  return ua === "node" || ua.startsWith("node/") || ua.startsWith("undici") ? "bridge" : `direct (${ua.slice(0, 40)})`;
}

function short(id: string): string {
  return id.slice(0, 8);
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

const MAX_BODY = 4 * 1024 * 1024;

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Request too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function sendJsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}
