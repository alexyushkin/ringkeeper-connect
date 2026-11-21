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
// Tests: print an env var to stderr, like a careless server might, to check the gateway redacts it.
const echo = arg("echo-env", "");
if (echo) process.stderr.write(`starting with ${echo}=${process.env[echo] ?? "(unset)"}\n`);

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
  // For the per-client guard: one tool that looks, one that changes, one that deletes. No
  // annotations on purpose: most servers don't send them, so the names have to be enough.
  crm: [
    { name: "find_contacts", description: "Find contacts.", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    { name: "update_contact", description: "Change a contact.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
    { name: "delete_contact", description: "Delete a contact for good.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
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
    case "crm/find_contacts":
      return JSON.stringify([{ id: `${slug}-c-1`, name: `${account} contact` }]);
    case "crm/update_contact":
      return `updated ${String(args.id)} for ${account}`;
    case "crm/delete_contact":
      return `deleted ${String(args.id)} for ${account}`;
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
