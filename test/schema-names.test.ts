// Tools whose input names AI apps refuse (Twilio's "DateSent<") are shown
// under valid names, and calls get the tool's own names back.
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { originalArguments, safeInputSchema } from "../packages/gateway/src/schema-names.js";
import { Gateway } from "../packages/gateway/src/gateway.js";
import { mcpUrl, newToken } from "../packages/gateway/src/runtime.js";

const VALID = /^[a-zA-Z0-9_.-]{1,64}$/;

/** Twilio's ListMessage, as its program describes it (shortened). */
const listMessage = {
  type: "object" as const,
  properties: {
    AccountSid: { type: "string" },
    To: { type: "string" },
    DateSent: { type: "string", format: "date-time" },
    "DateSent<": { type: "string", format: "date-time", description: "Only messages sent before this date" },
    "DateSent>": { type: "string", format: "date-time", description: "Only messages sent after this date" },
    PageSize: { type: "integer" },
  },
  required: ["AccountSid"],
};

describe("input names AI apps refuse", () => {
  it("shows Twilio's DateSent< and DateSent> as DateSent_before and DateSent_after, and renames calls back", () => {
    const { schema, map } = safeInputSchema(listMessage);
    expect(Object.keys(schema.properties)).toEqual(["AccountSid", "To", "DateSent", "DateSent_before", "DateSent_after", "PageSize"]);
    for (const k of Object.keys(schema.properties)) expect(k).toMatch(VALID);
    expect((schema.properties as Record<string, unknown>).DateSent_before).toEqual(listMessage.properties["DateSent<"]);
    expect(schema.required).toEqual(["AccountSid"]);
    expect(originalArguments({ AccountSid: "AC1", DateSent_after: "2026-11-01", PageSize: 20 }, map)).toEqual({ AccountSid: "AC1", "DateSent>": "2026-11-01", PageSize: 20 });
  });

  it("leaves valid tools exactly as they are", () => {
    const plain = { type: "object", properties: { query: { type: "string" }, "page.size": { type: "integer" } }, required: ["query"] };
    const r = safeInputSchema(plain);
    expect(r.schema).toBe(plain);
    expect(r.map).toBeUndefined();
    expect(originalArguments({ query: "x" }, r.map)).toEqual({ query: "x" });
  });

  it("keeps names unique, renames required ones, and handles nested objects and lists", () => {
    const schema = {
      type: "object",
      properties: {
        "a b": { type: "string" },
        a_b: { type: "string" },
        filter: { type: "object", properties: { "Price>=": { type: "number" } } },
        rows: { type: "array", items: { type: "object", properties: { "x/y": { type: "string" } } } },
        ["x".repeat(80)]: { type: "string" },
      },
      required: ["a b"],
    };
    const { schema: safe, map } = safeInputSchema(schema);
    const keys = Object.keys(safe.properties as object);
    expect(keys).toEqual(["a_b_2", "a_b", "filter", "rows", "x".repeat(60)]);
    for (const k of keys) expect(k).toMatch(VALID);
    expect(safe.required).toEqual(["a_b_2"]);
    expect(Object.keys((safe.properties as any).filter.properties)).toEqual(["Price_after"]);
    expect(Object.keys((safe.properties as any).rows.items.properties)).toEqual(["x_y"]);
    expect(originalArguments({ a_b_2: 1, a_b: 2, filter: { Price_after: 5 }, rows: [{ x_y: "1" }, { x_y: "2" }] }, map)).toEqual({
      "a b": 1,
      a_b: 2,
      filter: { "Price>=": 5 },
      rows: [{ "x/y": "1" }, { "x/y": "2" }],
    });
  });
});

describe("through the gateway", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0).reverse()) await c();
  });

  it("an AI app sees valid names; the tool receives its own", async () => {
    // A small tool server that answers with the arguments it received.
    const received: unknown[] = [];
    const httpServer = http.createServer(async (req, res) => {
      const server = new Server({ name: "twilio-like", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ListMessage", description: "List messages", inputSchema: listMessage }] }));
      server.setRequestHandler(CallToolRequestSchema, async (r) => {
        received.push(r.params.arguments);
        return { content: [{ type: "text", text: "ok" }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => void transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
    closers.push(
      () =>
        new Promise((r) => {
          httpServer.closeAllConnections();
          httpServer.close(() => r());
        }),
    );
    const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;

    const token = newToken();
    const freePort = await new Promise<number>((r) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => r(p));
      });
    });
    const gateway = new Gateway({
      config: { clients: [{ id: "gi", name: "General Informatics", connections: [{ kind: "remote", id: "twilio", name: "Twilio", url, headers: {} }] }], options: { requireClientArg: false } },
      activeClientId: "gi",
      token,
      port: freePort,
    });
    const port = await gateway.start();
    closers.push(() => gateway.stop());

    // An app that gets every tool listed (others get Ringkeeper's search and call tools; same rename there).
    const client = new Client({ name: "claude-code", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(port)), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    closers.push(() => client.close());

    const tools = (await client.listTools()).tools;
    const tool = tools.find((t) => t.name.endsWith("ListMessage"))!;
    for (const k of Object.keys(tool.inputSchema.properties ?? {})) expect(k).toMatch(VALID);
    expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("DateSent_after");

    await client.callTool({ name: tool.name, arguments: { AccountSid: "AC1", DateSent_after: "2026-11-01" } });
    expect(received).toEqual([{ AccountSid: "AC1", "DateSent>": "2026-11-01" }]);

    // An app that finds and runs tools through ringkeeper_call_tool: same names, same rename back.
    const other = new Client({ name: "claude-ai", version: "0" });
    await other.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(port)), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    closers.push(() => other.close());
    await other.callTool({
      name: "ringkeeper_call_tool",
      arguments: { tool: tool.name, client: "General Informatics", arguments: { AccountSid: "AC1", DateSent_before: "2026-11-02" } },
    });
    expect(received.at(-1)).toEqual({ AccountSid: "AC1", "DateSent<": "2026-11-02" });
  });
});
