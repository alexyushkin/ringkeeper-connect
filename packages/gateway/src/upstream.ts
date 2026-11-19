// One upstream connection for one client: a program the gateway launches, or
// a server on the web. Started on demand and stopped when idle.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { ClientConfig, ConnectionConfig } from "./config.js";
import { NeedsSignInError, StoredOAuthProvider, directAccessToken, type OAuthStateStore, type RegisteredApp } from "./oauth.js";
import { BUILTIN_TOOLS_COMMAND } from "./config.js";
import { resolveLaunch, type BundledRuntimes } from "./runtimes.js";
import type { Logger } from "./log.js";

export type UpstreamStatus = "idle" | "starting" | "ready" | "error" | "needs_key" | "needs_signin" | "stopped";

/** What upstreams need from the app around them. */
export interface UpstreamEnv {
  runtimes?: BundledRuntimes;
  oauthStore?: OAuthStateStore;
  /** Ringkeeper Connect's registered apps (Google, Microsoft), by id; those this build has. */
  apps?: Record<string, RegisteredApp>;
  /** Path of the built-in tools program (tools.mjs), run with the bundled Node. */
  toolsProgram?: string;
}

/** Restart a program whose access token has less than this left, so it never runs with an expired one. */
const TOKEN_RENEW_BEFORE_MS = 2 * 60_000;

/** After a failed start, wait this long before trying again on the next request. */
const RETRY_AFTER_MS = 30_000;

/**
 * Programs that only take a key as an argument (Twilio) get `${NAME}` there:
 * filled in from the connection's own settings (kept secret) just before
 * starting, so the key is never saved in the plain list of arguments. Only
 * the connection's own settings, never this computer's environment. Exported for tests.
 */
export function withSettings(args: string[], env: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => (Object.hasOwn(env, name) ? env[name]! : whole)));
}

/** Quick-tunnel services whose addresses are random and change on every restart. */
const TEMPORARY_HOSTS = [".trycloudflare.com", ".loca.lt"];

/** The address's host when it's one of those temporary ones. Exported for tests. */
export function temporaryHost(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return TEMPORARY_HOSTS.some((suffix) => host.endsWith(suffix)) ? host : undefined;
  } catch {
    return undefined;
  }
}

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
  private oauth?: StoredOAuthProvider;
  /** Last lines the program printed, to explain a failed start (e.g. an offline download). */
  private stderrTail = "";
  /** When the access token a signed-in program was started with runs out. */
  private tokenExpiresAt?: number;

  constructor(
    readonly owner: ClientConfig,
    readonly conn: ConnectionConfig,
    private readonly onToolsChanged: (u: Upstream) => void,
    private readonly log: Logger,
    private readonly env: UpstreamEnv = {},
  ) {
    const values = conn.kind === "remote" ? Object.values(conn.headers ?? {}) : Object.values(conn.env ?? {});
    this.secretsToRedact = values.filter((v) => v.length >= 6);
    if (conn.missingKeys?.length) {
      this.status = "needs_key";
      this.error = `${conn.name} for ${owner.name} needs ${conn.missingKeys.join(" and ")}. Add it in Ringkeeper Connect under ${owner.name} > ${conn.name}.`;
    } else if (conn.oauth?.app && !env.apps?.[conn.oauth.app]) {
      // Needs a registered app this version of Ringkeeper Connect doesn't have, or one of the user's own that's gone.
      this.status = "needs_signin";
      this.error = conn.oauth.app.includes(":")
        ? `${conn.name} for ${owner.name} signs in through a ${conn.oauth.app.startsWith("microsoft:") ? "Microsoft" : "Google"} app that isn't set up on this computer anymore. Add it again under "Your own Google and Microsoft apps" in Ringkeeper Connect.`
        : `${conn.name} for ${owner.name} needs a newer version of Ringkeeper Connect. Update it, then sign in under ${owner.name} > ${conn.name}.`;
    } else if (conn.needsSignIn) {
      this.status = "needs_signin";
      this.error = this.signInMessage(false);
    }
  }

  private signInMessage(again: boolean): string {
    return `${this.conn.name} for ${this.owner.name} needs you to sign in${again ? " again" : ""}. Choose Sign in under ${this.owner.name} > ${this.conn.name} in Ringkeeper Connect.`;
  }

  private redact(text: string): string {
    let out = text;
    for (const s of this.secretsToRedact) out = out.split(s).join("•••");
    return out;
  }

  /** Start if not started (or retry a failed start after a pause). Resolves when settled. */
  ensureStarted(): Promise<void> {
    this.lastUsed = Date.now();
    if (this.starting) return this.starting;
    // A program started with an access token that's about to run out: restart it with a fresh one.
    if (this.status === "ready" && this.tokenExpiresAt !== undefined && this.tokenExpiresAt - Date.now() < TOKEN_RENEW_BEFORE_MS) {
      this.log({ ev: "upstream_token_renew", client: this.owner.id, conn: this.conn.id });
      this.starting = this.stop()
        .then(() => this.start())
        .finally(() => (this.starting = undefined));
      return this.starting;
    }
    if (this.status === "needs_key" || this.status === "needs_signin" || this.status === "ready") return Promise.resolve();
    if (this.status === "error" && Date.now() - this.failedAt < RETRY_AFTER_MS) return Promise.resolve();
    this.starting = this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  /** Start and wait, but give up waiting after `timeoutMs` (the start carries on). */
  async whenSettled(timeoutMs: number): Promise<void> {
    await Promise.race([this.ensureStarted(), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  private async makeTransport(): Promise<Transport> {
    const c = this.conn;
    if (c.kind === "remote") {
      const headers = c.headers ?? {};
      if (c.transport === "sse") {
        return new SSEClientTransport(new URL(c.url), { requestInit: { headers }, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) } });
      }
      this.oauth = c.oauth && this.env.oauthStore ? new StoredOAuthProvider(this.env.oauthStore, c.oauth.key, c.oauth.app ? this.env.apps?.[c.oauth.app] : undefined) : undefined;
      return new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers }, ...(this.oauth ? { authProvider: this.oauth } : {}) });
    }
    const env: Record<string, string> = { ...(c.env ?? {}) };
    let command = c.command;
    let args = c.args ?? [];
    if (command === BUILTIN_TOOLS_COMMAND) {
      if (!this.env.toolsProgram) throw new Error("built-in tools program missing");
      command = "node";
      args = [this.env.toolsProgram, ...args];
    }
    if (c.oauth) {
      // Signed in through a registered app: a current access token, renewed first if it's about to run out.
      const app = c.oauth.app ? this.env.apps?.[c.oauth.app] : undefined;
      if (!app || !this.env.oauthStore) throw new NeedsSignInError();
      const fresh = await directAccessToken(this.env.oauthStore, c.oauth.key, app, c.oauth.scope);
      env.RINGKEEPER_ACCESS_TOKEN = fresh.token;
      this.secretsToRedact.push(fresh.token);
      this.tokenExpiresAt = fresh.expiresAt;
    }
    // npx / node / uvx run on the copies bundled with Ringkeeper Connect when present.
    const launch = resolveLaunch(command, withSettings(args, env), { ...getDefaultEnvironment(), ...env }, this.env.runtimes ?? {});
    const t = new StdioClientTransport({ command: launch.command, args: launch.args, env: launch.env, stderr: "pipe" });
    this.stderrTail = "";
    // Must drain stderr or a chatty server blocks once the pipe buffer fills.
    t.stderr?.on("data", (chunk: Buffer) => {
      const text = this.redact(chunk.toString());
      this.stderrTail = (this.stderrTail + text).slice(-2000);
      this.log({ ev: "upstream_stderr", client: this.owner.id, conn: this.conn.id, text: text.slice(0, 500) });
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
      await client.connect(await this.makeTransport());
      this.client = client;
      await this.refreshTools();
      this.status = "ready";
      this.log({ ev: "upstream_ready", client: this.owner.id, conn: this.conn.id, tools: this.tools.length });
    } catch (err) {
      await client.close().catch(() => {});
      this.client = undefined;
      // Any refusal from the vendor's sign-in service (expired, revoked, unknown app) means: sign in again.
      if (err instanceof UnauthorizedError || err instanceof NeedsSignInError || (this.oauth && err instanceof OAuthError) || this.oauth?.needsSignIn) {
        this.status = "needs_signin";
        this.error = this.signInMessage(true);
      } else {
        this.status = "error";
        this.failedAt = Date.now();
        this.error = this.explain(err);
      }
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
      const host = temporaryHost(this.conn.url);
      if (host) {
        return `Couldn't reach ${who}. Its web address (${host}) is temporary and changes whenever it restarts. Ask whoever runs it for the new address, then update it under ${where}.`;
      }
      return `Couldn't reach ${who}. Check your internet connection and the web address under ${where}.`;
    }
    if (this.conn.kind !== "remote" && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|getaddrinfo|network|registry\.npmjs|Failed to fetch|failed to download/i.test(this.stderrTail)) {
      return `Couldn't download what ${who} needs to start. Check your internet connection, then try again.`;
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
    this.tokenExpiresAt = undefined;
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
