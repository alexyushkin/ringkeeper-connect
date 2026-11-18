// Shared by the JSON and TOML editors.
export class HostConfigError extends Error {}

export type ServerMap = Record<string, unknown>;

export type Change = { op: "set"; name: string; value: unknown } | { op: "remove"; name: string };

/**
 * How an app's settings file is written, and where its connections are:
 * JSON (with comments allowed) under a top-level key, or TOML [mcp_servers.*].
 */
export type ConfigFormat = { kind: "json"; key: string } | { kind: "toml"; key: "mcp_servers" };

export const MCP_JSON: ConfigFormat = { kind: "json", key: "mcpServers" };
export const CODEX_TOML: ConfigFormat = { kind: "toml", key: "mcp_servers" };
