// Built-in tools: integrations Ringkeeper Connect carries itself (ported from
// Ringkeeper), for services with no server of their own that suits it
// (Google, Microsoft 365). The gateway runs this program once per connection
// and hands it that client's access token; it never signs in by itself.

/** What a tool call gets: the connection's access token and a fetch (swappable in tests). */
export interface ToolContext {
  token: string;
  fetch: typeof fetch;
  /** Base addresses, so tests can point the tools at a stand-in service. Keyed by the service's own name (e.g. "gmail"). */
  base: (name: string, fallback: string) => string;
  /**
   * Asks the person to allow something before it happens (an action that waits for approval).
   * Resolves true only if they allowed it. Missing where no one can be asked.
   */
  approve?: (message: string) => Promise<boolean>;
}

export interface BuiltinTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments (object). */
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** Access keys that allow this tool: it's offered when any one of them was ticked (Ringkeeper's _need(target, a, b)). */
  needs: string[];
  /** Returns what the AI sees: text, or a value shown as JSON. Throw ToolError for a plain-language failure. */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/** A failure the AI should read as is (plain language, says what to do). */
export class ToolError extends Error {}

/** A built-in service: its tools, and the access keys they're grouped by. */
export interface BuiltinService {
  id: string;
  name: string;
  tools: BuiltinTool[];
  /** A service that takes a pasted key rather than a sign-in: the setting that holds it. */
  tokenSetting?: string;
}
