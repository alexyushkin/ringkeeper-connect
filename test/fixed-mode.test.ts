// Fixed mode: for hosts that ignore tools/list_changed (Claude Desktop, M1).
// The tool list never changes; client tools are reached through
// ringkeeper_search_tools and ringkeeper_call_tool.
import net from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Gateway } from "../packages/gateway/src/gateway.js";
import { spikeDefaultConfig } from "../packages/gateway/src/spike-config.js";
import { mcpUrl, newToken } from "../packages/gateway/src/runtime.js";
import { toolModeFor } from "../packages/gateway/src/meta-tools.js";

const dist = resolve("dist");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

async function setup(hostName: string) {
  const token = newToken();
  const gateway = new Gateway({
    config: spikeDefaultConfig(join(dist, "fixture-server.mjs")),
    activeClientId: "acme",
    token,
    port: await freePort(),
  });
  await gateway.start();
  cleanups.push(() => gateway.stop());
  const client = new Client({ name: hostName, version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl(gateway.port)), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  cleanups.push(() => client.close());
  return { gateway, client };
}

const texts = (r: unknown) => ((r as CallToolResult).content ?? []).map((c) => (c.type === "text" ? c.text : ""));
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();

describe("which hosts get which mode", () => {
  it.each([
    ["claude-code", "dynamic"],
    ["cursor-vscode", "dynamic"],
    ["claude-ai", "fixed"],
    ["local-agent-mode-ringkeeper-connect", "fixed"],
    ["some-new-host", "fixed"],
    [undefined, "fixed"],
  ])("%s → %s", (host, mode) => {
    expect(toolModeFor(host)).toBe(mode);
  });

  it("can be overridden per install", () => {
    expect(toolModeFor("claude-ai", ["claude-ai"])).toBe("dynamic");
  });
});

describe("fixed mode (Claude Desktop)", () => {
  it("shows the same five tools whatever the active client, and doesn't promise list_changed", async () => {
    const { gateway, client } = await setup("claude-ai");
    const before = await names(client);
    expect(before).toEqual([
      "ringkeeper_call_tool",
      "ringkeeper_help",
      "ringkeeper_list_clients",
      "ringkeeper_search_tools",
      "ringkeeper_use_client",
    ]);
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    gateway.setActiveClient("globex");
    expect(await names(client)).toEqual(before);
  });

  it("tells the model to keep client work in Ringkeeper, naming the clients", async () => {
    const { client } = await setup("claude-ai");
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("Acme, Globex");
    expect(instructions).toMatch(/Never use any other connector/);
    const search = (await client.listTools()).tools.find((t) => t.name === "ringkeeper_search_tools")!;
    expect(search.description).toMatch(/Never use any other connector.*same service/);
  });

  it("search finds the active client's tools, and finds new ones after a switch", async () => {
    const { client } = await setup("claude-ai");
    const before = texts(await client.callTool({ name: "ringkeeper_search_tools", arguments: { query: "airtable" } }));
    expect(before[0]).toBe("[Client: Acme]");
    expect(before[1]).toContain("No Acme tool matched");
    expect(before[1]).not.toContain("airtable_main__list_bases");

    await client.callTool({ name: "ringkeeper_use_client", arguments: { client: "Globex" } });
    const after = texts(await client.callTool({ name: "ringkeeper_search_tools", arguments: { query: "airtable" } }));
    expect(after[1]).toContain("airtable_main__list_bases");
  });

  it("call_tool runs the tool for the active client and labels the result", async () => {
    const { client } = await setup("claude-ai");
    const out = texts(
      await client.callTool({
        name: "ringkeeper_call_tool",
        arguments: { client: "Acme", tool: "list_workflows", arguments: {} },
      }),
    );
    expect(out[0]).toBe("[Client: Acme · n8n]");
    expect(out[1]).toContain("Acme lead intake");
  });

  it("call_tool refuses a client that isn't active, and runs nothing", async () => {
    const { client } = await setup("claude-ai");
    const res = (await client.callTool({
      name: "ringkeeper_call_tool",
      arguments: { client: "Globex", tool: "n8n_main__list_workflows" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(texts(res)[0]).toContain("Nothing was run");
    expect(texts(res).join(" ")).not.toContain("lead intake");
  });

  it("call_tool requires the client", async () => {
    const { client } = await setup("claude-ai");
    const res = (await client.callTool({ name: "ringkeeper_call_tool", arguments: { tool: "list_workflows" } })) as CallToolResult;
    expect(res.isError).toBe(true);
  });

  it("doesn't send tool-change notices to fixed-mode hosts", async () => {
    const { gateway, client } = await setup("claude-ai");
    let notices = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notices++;
    });
    await client.listTools();
    gateway.setActiveClient("globex");
    await client.callTool({ name: "ringkeeper_use_client", arguments: { client: "Acme" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(notices).toBe(0);
  });
});

describe("dynamic mode wording", () => {
  it("marks proxied tools as coming through Ringkeeper", async () => {
    const { client } = await setup("claude-code");
    const tool = (await client.listTools()).tools.find((t) => t.name === "n8n_main__list_workflows")!;
    expect(tool.description).toMatch(/^\[Acme's n8n, via Ringkeeper Connect\]/);
    const list = (await client.listTools()).tools.find((t) => t.name === "ringkeeper_list_clients")!;
    expect(list.description).toMatch(/Never use any other connector/);
  });
});
