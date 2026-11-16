// What the gateway runs on: every client and connection with secrets already
// filled in. Built in memory from the ClientStore; never written to disk.

interface ConnectionBase {
  /** Stable id, used as the tool prefix: `${id}__${toolName}`. */
  id: string;
  /** Shown to people, e.g. "n8n". */
  name: string;
  /** Keys the user hasn't filled in yet; the connection isn't started until they do. */
  missingKeys?: string[];
}

/** A program on this computer, talked to over stdin/stdout. */
export interface LocalConnectionConfig extends ConnectionBase {
  kind?: "local";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** A server on the web, talked to over Streamable HTTP. */
export interface RemoteConnectionConfig extends ConnectionBase {
  kind: "remote";
  url: string;
  /** "sse" for older servers; Streamable HTTP otherwise. */
  transport?: "sse";
  headers?: Record<string, string>;
}

export type ConnectionConfig = LocalConnectionConfig | RemoteConnectionConfig;

export interface ClientConfig {
  id: string;
  name: string;
  connections: ConnectionConfig[];
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
  options: GatewayOptionsConfig;
}

export const TOOL_PREFIX_SEPARATOR = "__";

export function findClient(config: GatewayConfig, idOrName: string): ClientConfig | undefined {
  const needle = idOrName.trim().toLowerCase();
  return config.clients.find((c) => c.id.toLowerCase() === needle || c.name.toLowerCase() === needle);
}

/** Changes when anything that affects how the connection runs changes (including keys). In memory only. */
export function connectionFingerprint(c: ConnectionConfig): string {
  return JSON.stringify(c.kind === "remote" ? [c.kind, c.url, c.transport, c.headers, c.missingKeys] : ["local", c.command, c.args, c.env, c.missingKeys]);
}
