import type { ActionChoice, ClientGuard } from "./guard.js";
// What the gateway runs on: every client and connection with secrets already
// filled in. Built in memory from the ClientStore; never written to disk.

/**
 * The owner of the tools every client gets (a browser helper, web search): not a client of its
 * own. "~" never appears in a client's id, so it can't clash with one, or with its saved keys.
 */
export const EVERY_CLIENT_ID = "~every";

interface ConnectionBase {
  /** Stable id, used as the tool prefix: `${id}__${toolName}`. */
  id: string;
  /** Shown to people, e.g. "n8n". */
  name: string;
  /** Keys the user hasn't filled in yet; the connection isn't started until they do. */
  missingKeys?: string[];
  /** Which of its actions the AI apps get (see guard.ts). Left out: all. */
  actions?: ActionChoice;
  /** Turned off by the user: kept with its keys, but not started and not offered. */
  off?: boolean;
}

/** A program on this computer, talked to over stdin/stdout. */
export interface LocalConnectionConfig extends ConnectionBase {
  kind?: "local";
  /** BUILTIN_TOOLS_COMMAND runs Ringkeeper Connect's own tools program (args[0]: the service). */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Signs in through a registered app; the program gets a fresh access token in RINGKEEPER_ACCESS_TOKEN. */
  oauth?: { key: string; app?: string; scope?: string };
  needsSignIn?: boolean;
}

/** The command that stands for Ringkeeper Connect's built-in tools program (packages/tools). */
export const BUILTIN_TOOLS_COMMAND = "ringkeeper-tools";

/** A server on the web, talked to over Streamable HTTP. */
export interface RemoteConnectionConfig extends ConnectionBase {
  kind: "remote";
  url: string;
  /** "sse" for older servers; Streamable HTTP otherwise. */
  transport?: "sse";
  headers?: Record<string, string>;
  /** Signs in with OAuth; tokens live in the OAuth state store under this key. `app`: a registered app (Google, Microsoft); `scope`: permissions. */
  oauth?: { key: string; app?: string; scope?: string };
  /** OAuth connection with no saved sign-in yet. */
  needsSignIn?: boolean;
}

export type ConnectionConfig = LocalConnectionConfig | RemoteConnectionConfig;

export interface ClientConfig {
  id: string;
  name: string;
  connections: ConnectionConfig[];
  /** How much the AI may do for this client (see guard.ts). Unset means the default: ask before deleting. */
  guard?: ClientGuard;
}

export interface GatewayOptionsConfig {
  /**
   * Add a required `ringkeeper_client` argument to every proxied tool (dynamic
   * mode) and reject calls where it doesn't match the active client.
   */
  requireClientArg: boolean;
  /**
   * Host names (clientInfo.name) that honour tools/list_changed and get the
   * active client's tools directly. Everything else gets fixed mode.
   * Defaults to DEFAULT_DYNAMIC_HOSTS.
   */
  dynamicHosts?: string[];
}

export interface GatewayConfig {
  clients: ClientConfig[];
  /** Tools every client gets, next to its own. The active client's rules (what the AI may do) apply to them. */
  everyClient?: ConnectionConfig[];
  options: GatewayOptionsConfig;
}

export const TOOL_PREFIX_SEPARATOR = "__";

export function findClient(config: GatewayConfig, idOrName: string): ClientConfig | undefined {
  const needle = idOrName.trim().toLowerCase();
  return config.clients.find((c) => c.id.toLowerCase() === needle || c.name.toLowerCase() === needle);
}

/** Changes when anything that affects how the connection runs changes (including keys). In memory only. */
export function connectionFingerprint(c: ConnectionConfig): string {
  return JSON.stringify(c.kind === "remote" ? [c.kind, c.url, c.transport, c.headers, c.missingKeys, c.oauth?.key, c.oauth?.app, c.oauth?.scope, c.needsSignIn] : ["local", c.command, c.args, c.env, c.missingKeys, c.oauth?.key, c.oauth?.app, c.oauth?.scope, c.needsSignIn]);
}
