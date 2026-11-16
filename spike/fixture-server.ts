// Fake upstream for the M1 spike: pretends to be n8n or Airtable for one
// account, and returns data stamped with that account so cross-client leaks
// are obvious.
//   node fixture-server.mjs --service n8n --account Acme
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const service = arg("service", "n8n");
const account = arg("account", "Acme");

const toolsByService: Record<string, Tool[]> = {
  n8n: [
    {
      name: "list_workflows",
      description: "List the workflows in this n8n instance.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_workflow",
      description: "Get one workflow by id.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      annotations: { readOnlyHint: true },
    },
  ],
  airtable: [
    {
      name: "list_bases",
      description: "List the Airtable bases this key can see.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
};

function run(tool: string, args: Record<string, unknown>): string {
  const slug = account.toLowerCase();
  switch (`${service}/${tool}`) {
    case "n8n/list_workflows":
      return JSON.stringify([
        { id: `${slug}-wf-1`, name: `${account} lead intake`, active: true },
        { id: `${slug}-wf-2`, name: `${account} weekly report`, active: false },
      ]);
    case "n8n/get_workflow":
      return JSON.stringify({ id: args.id, name: `${account} workflow ${String(args.id)}`, nodes: 5 });
    case "airtable/list_bases":
      return JSON.stringify([{ id: `app${slug}01`, name: `${account} CRM` }]);
    default:
      throw new Error(`Unknown tool ${tool}`);
  }
}

const server = new Server({ name: `fake-${service}`, version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsByService[service] ?? [] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: run(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>) }],
}));
await server.connect(new StdioServerTransport());
