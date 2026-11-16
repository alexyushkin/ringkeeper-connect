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
import { TOOL_PREFIX_SEPARATOR, findClient, type ClientConfig, type GatewayConfig } from "./config.js";
import { Upstream } from "./upstream.js";
import { nullLogger, type Logger } from "./log.js";
import {
  META_CALL_TOOL,
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
const VERSION = "0.0.1";
const UPSTREAM_WAIT_MS = 10_000;

export interface GatewayOptions {
  config: GatewayConfig;
  activeClientId: string;
  token: string;
  /** Preferred port (picked once at install). Falls back to a free one if taken. */
  port: number;
  log?: Logger;
  onActiveClientChanged?: (clientId: string) => void;
}

interface Session {
  id: string;
  server: Server;
  transport: StreamableHTTPServerTransport;
  host?: string;
  mode: ToolMode;
  /** Whether the host currently holds its listening (GET) stream open. */
  streamOpen: boolean;
  /** A tools-changed notice the host hasn't received yet. */
  pendingListChanged: boolean;
}

const LIST_CHANGED = { method: "notifications/tools/list_changed" as const };

export class Gateway {
  private readonly upstreams: Upstream[] = [];
  private readonly sessions = new Map<string, Session>();
  private httpServer?: http.Server;
  private activeClientId: string;
  private readonly log: Logger;
  port = 0;
  usedFallbackPort = false;

  constructor(private readonly opts: GatewayOptions) {
    this.log = opts.log ?? nullLogger;
    if (!findClient(opts.config, opts.activeClientId)) {
      const first = opts.config.clients[0];
      if (!first) throw new Error("Add at least one client before starting.");
      this.activeClientId = first.id;
    } else {
      this.activeClientId = findClient(opts.config, opts.activeClientId)!.id;
    }
  }

  get activeClient(): ClientConfig {
    return this.opts.config.clients.find((c) => c.id === this.activeClientId)!;
  }

  get options() {
    return this.opts.config.options;
  }

  async start(): Promise<number> {
    for (const client of this.opts.config.clients) {
      for (const conn of client.connections) {
        const u = new Upstream(client, conn, (changed) => this.onUpstreamToolsChanged(changed), this.log);
        this.upstreams.push(u);
        void u.start();
      }
    }
    this.port = await this.listen(this.opts.port);
    this.log({ ev: "gateway_started", port: this.port, fallback: this.usedFallbackPort, active: this.activeClientId });
    return this.port;
  }

  async stop(): Promise<void> {
    for (const s of this.sessions.values()) await s.transport.close().catch(() => {});
    this.sessions.clear();
    await Promise.all(this.upstreams.map((u) => u.stop()));
    await new Promise<void>((r) => (this.httpServer ? this.httpServer.close(() => r()) : r()));
    this.httpServer?.closeAllConnections?.();
  }

  // ---------- active client ----------

  /** `from` is the session that asked for the switch; it gets the notice inline with its reply. */
  setActiveClient(idOrName: string, from?: Session): ClientConfig {
    const client = findClient(this.opts.config, idOrName);
    if (!client) {
      const names = this.opts.config.clients.map((c) => c.name).join(", ");
      throw new UserFacingError(`There's no client called "${idOrName}". Your clients are: ${names}.`);
    }
    if (client.id !== this.activeClientId) {
      this.activeClientId = client.id;
      this.log({ ev: "active_client_changed", active: client.id });
      this.opts.onActiveClientChanged?.(client.id);
      this.notifyToolsChanged("active_client_changed", from);
    }
    return client;
  }

  setOptions(patch: Partial<GatewayConfig["options"]>): void {
    Object.assign(this.opts.config.options, patch);
    this.log({ ev: "options_changed", options: this.opts.config.options });
    this.notifyToolsChanged("options_changed");
  }

  private onUpstreamToolsChanged(u: Upstream): void {
    if (u.owner.id === this.activeClientId) this.notifyToolsChanged(`upstream:${u.conn.id}`);
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

  // ---------- tools ----------

  private get clientNames(): string[] {
    return this.opts.config.clients.map((c) => c.name);
  }

  modeForHost(hostName: string | undefined): ToolMode {
    return toolModeFor(hostName, this.options.dynamicHosts);
  }

  async listExposedTools(mode: ToolMode = "dynamic"): Promise<Tool[]> {
    if (mode === "fixed") return fixedModeTools(this.clientNames);
    return [...metaTools(this.clientNames), ...(await this.activeClientTools())];
  }

  /** The active client's tools, prefixed and labelled, as a dynamic-mode host sees them. */
  private async activeClientTools(): Promise<Tool[]> {
    const client = this.activeClient;
    const mine = this.upstreams.filter((u) => u.owner.id === client.id);
    await Promise.all(mine.map((u) => u.whenSettled(UPSTREAM_WAIT_MS)));
    const tools: Tool[] = [];
    for (const u of mine) {
      if (u.status !== "ready") continue;
      for (const t of u.tools) tools.push(this.exposeTool(client, u, t));
    }
    return tools;
  }

  private exposeTool(client: ClientConfig, u: Upstream, t: Tool): Tool {
    const inputSchema = structuredClone(t.inputSchema ?? { type: "object" }) as Tool["inputSchema"];
    if (this.options.requireClientArg) {
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

  async callTool(name: string, args: Record<string, unknown>, from?: Session): Promise<CallToolResult> {
    try {
      if (name === META_LIST_CLIENTS) return this.listClientsResult();
      if (name === META_USE_CLIENT) {
        const wanted = typeof args.client === "string" ? args.client : "";
        const client = this.setActiveClient(wanted, from);
        const toolNames = (await this.activeClientTools()).map((t) => t.name);
        const how = from?.mode === "fixed" ? ` Find and run them with ${META_SEARCH_TOOLS} and ${META_CALL_TOOL}.` : "";
        return text(
          `Now working with ${client.name}, in every chat of this app. Its tools: ${toolNames.join(", ") || "none yet"}.${how}`,
        );
      }
      if (name === META_SEARCH_TOOLS) return await this.searchTools(typeof args.query === "string" ? args.query : "");
      if (name === META_CALL_TOOL) {
        const tool = typeof args.tool === "string" ? await this.resolveToolName(args.tool) : "";
        const toolArgs = (args.arguments && typeof args.arguments === "object" ? args.arguments : {}) as Record<string, unknown>;
        return await this.callProxied(tool, toolArgs, { required: true, value: args.client });
      }
      const forwarded = { ...args };
      const claimed = forwarded[CLIENT_ARG];
      delete forwarded[CLIENT_ARG];
      return await this.callProxied(name, forwarded, { required: this.options.requireClientArg, value: claimed });
    } catch (err) {
      if (err instanceof UserFacingError) return errorResult(err.message);
      this.log({ ev: "call_failed", tool: name, error: String(err) });
      return errorResult(`Something went wrong running ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Accept "list_bases" as well as "airtable_main__list_bases" when it's unambiguous in the active client. */
  private async resolveToolName(tool: string): Promise<string> {
    if (tool.includes(TOOL_PREFIX_SEPARATOR)) return tool;
    const mine = this.upstreams.filter((u) => u.owner.id === this.activeClientId);
    await Promise.all(mine.map((u) => u.whenSettled(UPSTREAM_WAIT_MS)));
    const matches = mine.filter((u) => u.tools.some((t) => t.name === tool));
    return matches.length === 1 ? `${matches[0]!.conn.id}${TOOL_PREFIX_SEPARATOR}${tool}` : tool;
  }

  private async searchTools(query: string): Promise<CallToolResult> {
    const client = this.activeClient;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = await this.activeClientTools();
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
    return {
      content: [
        { type: "text", text: `[Client: ${client.name}]` },
        {
          type: "text",
          text: `${header}\n${JSON.stringify(list, null, 1)}\n\nRun one with ${META_CALL_TOOL} (client: "${client.name}").`,
        },
      ],
      _meta: { "ringkeeper/client": client.id },
    };
  }

  private async callProxied(
    name: string,
    args: Record<string, unknown>,
    claim: { required: boolean; value: unknown },
  ): Promise<CallToolResult> {
    const sep = name.indexOf(TOOL_PREFIX_SEPARATOR);
    const connId = sep > 0 ? name.slice(0, sep) : "";
    const toolName = sep > 0 ? name.slice(sep + TOOL_PREFIX_SEPARATOR.length) : name;
    const active = this.activeClient;
    // A host may call a tool it remembers before that connection finished starting.
    await Promise.all(this.upstreams.filter((u) => u.conn.id === connId).map((u) => u.whenSettled(UPSTREAM_WAIT_MS)));
    const upstream = this.upstreams.find((u) => u.owner.id === active.id && u.conn.id === connId);

    if (!upstream || !upstream.tools.some((t) => t.name === toolName)) {
      const elsewhere = this.upstreams.find(
        (u) => u.owner.id !== active.id && u.conn.id === connId && u.tools.some((t) => t.name === toolName),
      );
      this.log({ ev: "refused_not_in_active_client", tool: name, active: active.id, owner: elsewhere?.owner.id });
      if (elsewhere) {
        throw new UserFacingError(
          `${name} belongs to ${elsewhere.owner.name}, but the active client is ${active.name}. Call ringkeeper_use_client with "${elsewhere.owner.name}" first.`,
        );
      }
      throw new UserFacingError(`${active.name} has no tool called ${name || "that"}. Call ${META_SEARCH_TOOLS} or ${META_LIST_CLIENTS} to see what's available, and don't use another connector instead.`);
    }

    const forwarded = args;
    if (claim.required) {
      const claimed = claim.value;
      if (typeof claimed !== "string" || claimed.trim() === "") {
        this.log({ ev: "refused_client_arg_missing", tool: name, active: active.id });
        throw new UserFacingError(`Say which client this is for (the active client is ${active.name}).`);
      }
      const claimedClient = findClient(this.opts.config, claimed);
      if (!claimedClient || claimedClient.id !== active.id) {
        this.log({ ev: "refused_client_arg_mismatch", tool: name, active: active.id, claimed });
        throw new UserFacingError(
          `This call says it's for "${claimed}", but the active client is ${active.name}. Nothing was run. If you meant ${claimed}, call ringkeeper_use_client first.`,
        );
      }
    }

    this.log({ ev: "call_proxied", tool: name, client: active.id });
    const result = await upstream.callTool(toolName, forwarded);
    return labelResult(result, active, upstream.conn.name);
  }

  private listClientsResult(): CallToolResult {
    const lines = this.opts.config.clients.map((c) => {
      const conns = c.connections.map((x) => x.name).join(", ") || "no connections yet";
      return `${c.id === this.activeClientId ? "* " : "  "}${c.name} (${conns})${c.id === this.activeClientId ? " ← active" : ""}`;
    });
    return text(`Clients in Ringkeeper Connect:\n${lines.join("\n")}\n\nSwitch with ringkeeper_use_client. Switching applies to every chat in this app.`);
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
    const mode = this.modeForHost(hostName);
    const session = { id: "", host: undefined, mode, streamOpen: false, pendingListChanged: false } as unknown as Session;
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
      if (transport.sessionId) {
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
        capabilities: server.getClientCapabilities(),
      });
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
      if (body && typeof body.requireClientArg === "boolean") this.setOptions({ requireClientArg: body.requireClientArg });
      // Applies to sessions that start after the change.
      if (body && Array.isArray(body.dynamicHosts)) this.setOptions({ dynamicHosts: body.dynamicHosts.map(String) });
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
      sessions: [...this.sessions.values()].map((s) => ({ id: short(s.id), host: s.host, mode: s.mode })),
      upstreams: this.upstreams.map((u) => ({ client: u.owner.id, conn: u.conn.id, status: u.status, tools: u.tools.length, error: u.error })),
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
