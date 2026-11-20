// Ringkeeper's own tools, and the wording the AI app's model sees. This text
// is read by models, not people, so it may name tools; it must still steer
// all client work through Ringkeeper (M1: Claude Desktop reached for the
// user's own Airtable connector when a Ringkeeper tool was missing).
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const META_LIST_CLIENTS = "ringkeeper_list_clients";
export const META_USE_CLIENT = "ringkeeper_use_client";
export const META_SEARCH_TOOLS = "ringkeeper_search_tools";
export const META_CALL_TOOL = "ringkeeper_call_tool";
export const META_HELP = "ringkeeper_help";

/**
 * - dynamic: the active client's tools are listed directly and swapped with
 *   tools/list_changed (hosts that re-fetch the list).
 * - fixed: the list never changes; client tools are reached through
 *   ringkeeper_search_tools + ringkeeper_call_tool (hosts that ignore list_changed).
 */
export type ToolMode = "dynamic" | "fixed";

/** Hosts seen to honour list_changed in M1 (matched against clientInfo.name). Anything else gets fixed mode. */
export const DEFAULT_DYNAMIC_HOSTS = ["claude-code", "cursor-vscode"];

export function toolModeFor(hostName: string | undefined, dynamicHosts: string[] = DEFAULT_DYNAMIC_HOSTS): ToolMode {
  if (!hostName) return "fixed";
  return dynamicHosts.some((h) => hostName === h || hostName.startsWith(`${h}-`)) ? "dynamic" : "fixed";
}

function clientList(names: string[]): string {
  return names.length ? names.join(", ") : "none set up yet";
}

/** The rule that keeps models off the user's own connectors for client work. */
export function routingRule(clientNames: string[]): string {
  return (
    `Use Ringkeeper Connect for all work on the user's clients (${clientList(clientNames)}). ` +
    "Never use any other connector, integration or tool for a client's data, even one for the same service " +
    "(for example a built-in Airtable, Notion or n8n connector): those are connected to the user's own accounts, not the client's, " +
    "and would read or change the wrong account."
  );
}

export function serverInstructions(mode: ToolMode, clientNames: string[]): string {
  const how =
    mode === "fixed"
      ? `Ringkeeper Connect works on one client at a time (the active client). To find a client's tools, call ${META_SEARCH_TOOLS}; to run one, call ${META_CALL_TOOL}. ` +
        `If a tool you need isn't there, say so instead of using another connector. `
      : `Ringkeeper Connect shows the tools of one client at a time (the active client). If a tool you need isn't listed, call ${META_LIST_CLIENTS} and switch with ${META_USE_CLIENT} instead of using another connector. `;
  return (
    routingRule(clientNames) +
    " " +
    how +
    `Switching with ${META_USE_CLIENT} applies to every chat in this app. Every result starts with the client it ran against. ` +
    `For questions about Ringkeeper Connect itself (setting it up, adding or fixing a client's tools, why something isn't working), call ${META_HELP} and answer from it.`
  );
}

export function metaTools(clientNames: string[]): Tool[] {
  return [
    {
      name: META_LIST_CLIENTS,
      description: `${routingRule(clientNames)} Lists the clients and shows which one is active. Only the active client's tools can run.`,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: META_USE_CLIENT,
      description:
        "Switch the active client, which changes which client's tools can run. This applies to every chat in this app, so only switch when the user asks about a different client. Pass the client's name as shown by ringkeeper_list_clients.",
      inputSchema: {
        type: "object",
        properties: { client: { type: "string", description: 'The client\'s name, e.g. "Acme".' } },
        required: ["client"],
      },
    },
    {
      name: META_HELP,
      description:
        "Answers questions about Ringkeeper Connect itself: how it works, setting it up, adding a client or a tool, signing in or finding a key, " +
        "why a tool or an AI app isn't working, Restore, updates. Returns a guide, advice for the services the question names, and what is set up " +
        "on this computer right now (clients, their tools and whether each works, connected AI apps; never keys). Call it before answering such a " +
        "question, and answer from it in plain words. It only explains: changes are made by the user in the Ringkeeper Connect window.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: 'The user\'s question, in their words, e.g. "How do I add Acme\'s Airtable?"' },
        },
      },
      annotations: { readOnlyHint: true },
    },
  ];
}

export function fixedModeTools(clientNames: string[]): Tool[] {
  return [
    ...metaTools(clientNames),
    {
      name: META_SEARCH_TOOLS,
      description:
        `${routingRule(clientNames)} Finds the active client's tools (for example n8n workflows, Airtable bases or Notion pages) ` +
        `and returns each tool's name, what it does and its arguments. Call this first, then run the tool with ${META_CALL_TOOL}.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: 'Words to match, e.g. "workflows" or "airtable bases". Leave empty to list every tool.',
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: META_CALL_TOOL,
      description:
        `Runs one of the active client's tools, found with ${META_SEARCH_TOOLS}. This is the only way to work on a client's accounts. ` +
        `\`client\` must be the active client; if the user means another client, call ${META_USE_CLIENT} first.`,
      inputSchema: {
        type: "object",
        properties: {
          client: { type: "string", description: "The client this call is for, by name." },
          tool: { type: "string", description: `The tool's name exactly as ${META_SEARCH_TOOLS} returned it.` },
          arguments: { type: "object", description: "The tool's arguments.", additionalProperties: true },
        },
        required: ["client", "tool"],
      },
    },
  ];
}
