// The MCP server for one built-in service and one connection: only the tools
// the account's ticked access allows, each called with that connection's token.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolError, type BuiltinService, type ToolContext } from "./types.js";

/** Tools this account may use: any one of the access keys a tool lists was ticked (as Ringkeeper's _need). */
export function allowedTools(service: BuiltinService, access: Set<string>) {
  return service.tools.filter((t) => t.needs.some((n) => access.has(n)));
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 1);
}

/** How long an approval waits for the person; no answer by then counts as not allowed. */
export const APPROVAL_WAIT_MS = 120_000;

/**
 * Asks the person through Ringkeeper Connect (the client that started this program): an
 * empty form with a message, answered Allow or Don't allow. False when the question went
 * unanswered; a ToolError when there's no one to ask.
 */
async function askThroughClient(server: Server, message: string): Promise<boolean> {
  if (!server.getClientCapabilities()?.elicitation) throw new ToolError("This needs your OK in Ringkeeper Connect, and it couldn't ask. Nothing was changed.");
  try {
    const answer = await server.elicitInput({ message, requestedSchema: { type: "object", properties: {} } }, { timeout: APPROVAL_WAIT_MS + 5_000 });
    return answer.action === "accept";
  } catch {
    return false;
  }
}

export function createToolServer(service: BuiltinService, access: Set<string>, ctx: ToolContext): Server {
  const tools = allowedTools(service, access);
  const server = new Server({ name: `ringkeeper-${service.id}`, version: "1.0.0" }, { capabilities: { tools: {} } });
  if (!ctx.approve) ctx = { ...ctx, approve: (message) => askThroughClient(server, message) };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) return { content: [{ type: "text", text: `${service.name} has no tool called ${req.params.name} for this account.` }], isError: true };
    try {
      const result = await tool.run((req.params.arguments ?? {}) as Record<string, unknown>, ctx);
      return { content: [{ type: "text", text: asText(result) }] };
    } catch (err) {
      const text = err instanceof ToolError ? err.message : `${service.name}: ${err instanceof Error ? err.message : String(err)}`;
      return { content: [{ type: "text", text }], isError: true };
    }
  });
  return server;
}
