// Spike-level config model. M2 replaces this with the real client store and
// moves secrets into safeStorage.

export interface ConnectionConfig {
  /** Stable id, used as the tool prefix: `${id}__${toolName}`. */
  id: string;
  /** Shown to people, e.g. "n8n". */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ClientConfig {
  id: string;
  name: string;
  connections: ConnectionConfig[];
}

export interface GatewayOptionsConfig {
  /**
   * M1 experiment: add a required `ringkeeper_client` argument to every proxied
   * tool and reject calls where it doesn't match the active client.
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
