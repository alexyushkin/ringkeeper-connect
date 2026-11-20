// M2 gateway behaviour: config reloads, on-demand connections, keys, remote
// connections, who switched, and housekeeping.
import fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Gateway, type SwitchSource } from "../packages/gateway/src/gateway.js";
import type { ClientConfig, GatewayConfig } from "../packages/gateway/src/config.js";
import { fileLogger } from "../packages/gateway/src/log.js";
import { mcpUrl, newToken } from "../packages/gateway/src/runtime.js";

const fixture = join(resolve("dist"), "fixture-server.mjs");
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

const local = (id: string, name: string, service: string, account: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  command: process.execPath,
  args: [fixture, "--service", service, "--account", account],
  ...extra,
});

const acme: ClientConfig = { id: "acme", name: "Acme", connections: [local("n8n", "n8n", "n8n", "Acme")] };
const globex: ClientConfig = {
  id: "globex",
  name: "Globex",
  connections: [local("n8n", "n8n", "n8n", "Globex"), local("airtable", "Airtable", "airtable", "Globex")],
};

function config(clients: ClientConfig[], requireClientArg = false): GatewayConfig {
  return { clients: structuredClone(clients), options: { requireClientArg } };
}

async function start(cfg: GatewayConfig, extra: Partial<ConstructorParameters<typeof Gateway>[0]> = {}) {
  const token = newToken();
  const switches: Array<[string, SwitchSource]> = [];
  const gateway = new Gateway({
    config: cfg,
    activeClientId: cfg.clients[0]?.id ?? null,
    token,
    port: await freePort(),
    onActiveClientChanged: (id, source) => switches.push([id, source]),
    ...extra,
  });
  await gateway.start();
  cleanups.push(() => gateway.stop());
  return { gateway, token, switches };
}

async function connect(port: number, token: string, hostName = "claude-code") {
  const client = new Client({ name: hostName, version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl(port)), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  cleanups.push(() => client.close());
  return client;
}

const texts = (r: unknown) => ((r as CallToolResult).content ?? []).map((c) => (c.type === "text" ? c.text : ""));
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
const statusOf = (g: Gateway, client: string, conn: string) =>
  g.connectionStatuses().find((s) => s.clientId === client && s.connectionId === conn);

describe("no clients yet", () => {
  it("still answers, and says what to do", async () => {
    const { gateway, token } = await start(config([]));
    const c = await connect(gateway.port, token, "claude-ai");
    expect(await names(c)).toHaveLength(5);
    const res = (await c.callTool({ name: "ringkeeper_call_tool", arguments: { client: "Acme", tool: "x" } })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(texts(res)[0]).toMatch(/No clients are set up yet/);
  });
});

describe("connections start on demand", () => {
  it("starts the active client's connections, not the others'", async () => {
    const { gateway, token } = await start(config([acme, globex]));
    const c = await connect(gateway.port, token);
    await c.listTools();
    expect(statusOf(gateway, "acme", "n8n")?.status).toBe("ready");
    expect(statusOf(gateway, "globex", "n8n")?.status).toBe("idle");
    expect(statusOf(gateway, "globex", "airtable")?.status).toBe("idle");
  });

  it("parks another client's connections when they've been idle", async () => {
    const { gateway, token } = await start(config([acme, globex]), { timings: { upstreamIdleMs: 1000, sweepMs: 3_600_000 } });
    const c = await connect(gateway.port, token);
    await c.callTool({ name: "ringkeeper_use_client", arguments: { client: "Globex" } });
    await c.listTools();
    gateway.setActiveClient("Acme");
    expect(statusOf(gateway, "globex", "n8n")?.status).toBe("ready");
    gateway.sweep(Date.now() + 5000);
    await new Promise((r) => setTimeout(r, 200));
    expect(statusOf(gateway, "globex", "n8n")?.status).toBe("idle");
    // And it comes back when needed.
    await c.callTool({ name: "ringkeeper_use_client", arguments: { client: "Globex" } });
    const out = texts(await c.callTool({ name: "n8n__list_workflows", arguments: {} }));
    expect(out[1]).toContain("Globex lead intake");
  });
});

describe("reloading the config", () => {
  it("a new connection on the active client appears without restarting the others", async () => {
    const events: string[] = [];
    const { gateway, token } = await start(config([acme]), { log: (e) => events.push(`${e.ev}:${String(e.conn ?? "")}`) });
    const c = await connect(gateway.port, token);
    await c.listTools();
    const changed = new Promise<void>((r) => c.setNotificationHandler(ToolListChangedNotificationSchema, async () => r()));
    gateway.applyConfig(config([{ ...acme, connections: [...acme.connections, local("airtable", "Airtable", "airtable", "Acme")] }]));
    await changed;
    expect(await names(c)).toContain("airtable__list_bases");
    expect(events.filter((e) => e === "upstream_ready:n8n")).toHaveLength(1);
  });

  it("renaming a client shows up in labels without restarting its connections", async () => {
    const { gateway, token } = await start(config([acme]));
    const c = await connect(gateway.port, token);
    await c.listTools();
    gateway.applyConfig(config([{ ...acme, name: "Acme Corp" }]));
    const out = texts(await c.callTool({ name: "n8n__list_workflows", arguments: {} }));
    expect(out[0]).toBe("[Client: Acme Corp · n8n]");
  });

  it("removing the active client falls back to another and says so", async () => {
    const { gateway, switches } = await start(config([acme, globex]));
    gateway.applyConfig(config([globex]));
    expect(gateway.activeClient?.id).toBe("globex");
    expect(switches.at(-1)).toEqual(["globex", { by: "app" }]);
  });
});

describe("keys and problems, in plain words", () => {
  it("a connection missing its key isn't started, and the model is told why", async () => {
    const needsKey: ClientConfig = { ...acme, connections: [local("n8n", "n8n", "n8n", "Acme", { missingKeys: ["N8N_API_KEY"] })] };
    const { gateway, token } = await start(config([needsKey]));
    const c = await connect(gateway.port, token);
    expect(statusOf(gateway, "acme", "n8n")).toMatchObject({ status: "needs_key" });
    const res = (await c.callTool({ name: "n8n__list_workflows", arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(texts(res)[0]).toMatch(/n8n for Acme needs N8N_API_KEY\. Add it in Ringkeeper Connect under Acme > n8n\. Nothing was run/);
    const list = texts(await c.callTool({ name: "ringkeeper_list_clients", arguments: {} }))[0];
    expect(list).toContain("n8n: needs a key");
  });

  it("a program that isn't installed is explained", async () => {
    const broken: ClientConfig = { ...acme, connections: [{ id: "n8n", name: "n8n", command: "rk-definitely-not-installed" }] };
    const { gateway, token } = await start(config([broken]));
    const c = await connect(gateway.port, token);
    await c.listTools();
    expect(statusOf(gateway, "acme", "n8n")?.problem).toMatch(/isn't on this computer|stopped right after starting/);
  });

  it("a program that was there and is gone (its app updated and moved it) is explained", async () => {
    const gone = join(tmpdir(), "rk-moved-app-1.2.3", "bin", "tool.exe");
    const broken: ClientConfig = { ...acme, connections: [{ id: "n8n", name: "n8n", command: gone }] };
    const { gateway, token } = await start(config([broken]));
    const c = await connect(gateway.port, token);
    await c.listTools();
    const problem = statusOf(gateway, "acme", "n8n")?.problem ?? "";
    expect(problem).toContain("Couldn't start n8n for Acme: its program isn't on this computer any more");
    expect(problem).toContain("an update may have moved it");
    expect(problem).toContain("Acme > n8n");
  });

  it("another AI app's own helper says it can't work here and can be removed", async () => {
    const command = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0\\app\\resources\\cua_node\\bin\\node_repl.exe";
    const helper: ClientConfig = { ...acme, connections: [{ id: "node_repl", name: "node_repl", command }] };
    const { gateway, token } = await start(config([helper]));
    const c = await connect(gateway.port, token);
    await c.listTools();
    expect(statusOf(gateway, "acme", "node_repl")?.problem).toBe(
      "node_repl is part of Codex and only works inside Codex, so it can't run for Acme. Remove it under Acme > node_repl: Codex keeps its own copy.",
    );
  });

  it("keys don't reach the log, even if a server prints them", async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "rk-log-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logPath = join(dir, "gateway.log");
    const leaky: ClientConfig = {
      ...acme,
      connections: [
        {
          ...local("n8n", "n8n", "n8n", "Acme"),
          args: [fixture, "--service", "n8n", "--account", "Acme", "--echo-env", "N8N_API_KEY"],
          env: { N8N_API_KEY: "super-secret-acme-key-1234" },
        },
      ],
    };
    const { gateway, token } = await start(config([leaky]), { log: fileLogger(logPath) });
    const c = await connect(gateway.port, token);
    await c.listTools();
    await new Promise((r) => setTimeout(r, 200));
    const log = fs.readFileSync(logPath, "utf8");
    expect(log).toContain("starting with N8N_API_KEY=•••");
    expect(log).not.toContain("super-secret-acme-key-1234");
  });
});

describe("remote connections", () => {
  it("proxies a server on the web, sending its key as a header", async () => {
    const remote = await start(config([acme]));
    const viaRemote: ClientConfig = {
      id: "initech",
      name: "Initech",
      connections: [
        { kind: "remote", id: "remote", name: "Remote", url: mcpUrl(remote.gateway.port), headers: { Authorization: `Bearer ${remote.token}` } },
      ],
    };
    const { gateway, token } = await start(config([viaRemote]));
    const c = await connect(gateway.port, token);
    expect(await names(c)).toContain("remote__ringkeeper_list_clients");
  });

  it("a rejected key is explained", async () => {
    const remote = await start(config([acme]));
    const wrongKey: ClientConfig = {
      id: "initech",
      name: "Initech",
      connections: [{ kind: "remote", id: "remote", name: "Notion", url: mcpUrl(remote.gateway.port), headers: { Authorization: "Bearer nope" } }],
    };
    const { gateway, token } = await start(config([wrongKey]));
    const c = await connect(gateway.port, token);
    await c.listTools();
    expect(statusOf(gateway, "initech", "remote")?.problem).toBe(
      "Notion for Initech didn't accept the key. Update it in Ringkeeper Connect under Initech > Notion.",
    );
  });

  it("fills a program's ${NAME} arguments from its own settings only, just before starting it", async () => {
    const { withSettings } = await import("../packages/gateway/src/upstream.js");
    expect(withSettings(["-s", "${TWILIO_API_SECRET}", "--x=${A}${A}"], { TWILIO_API_SECRET: "s3cret", A: "1" })).toEqual(["-s", "s3cret", "--x=11"]);
    // Not one of its settings (e.g. the computer's PATH): left as written.
    expect(withSettings(["${PATH}", "${workspaceFolder}", "plain"], {})).toEqual(["${PATH}", "${workspaceFolder}", "plain"]);
  });

  it("recognises temporary tunnel addresses, which change on every restart", async () => {
    const { temporaryHost } = await import("../packages/gateway/src/upstream.js");
    expect(temporaryHost("https://chronicles-dance-provincial-columbus.trycloudflare.com/api/mcp")).toBe("chronicles-dance-provincial-columbus.trycloudflare.com");
    expect(temporaryHost("https://Quiet-Fox-12.LOCA.LT/mcp")).toBe("quiet-fox-12.loca.lt");
    expect(temporaryHost("https://mcp.notion.com/mcp")).toBeUndefined();
    expect(temporaryHost("https://trycloudflare.com.example.com/mcp")).toBeUndefined();
    expect(temporaryHost("not a web address")).toBeUndefined();
  });
});

describe("who switched", () => {
  it("reports AI-app switches with the app's name, and app switches as the app's", async () => {
    const { gateway, token, switches } = await start(config([acme, globex]));
    const c = await connect(gateway.port, token, "claude-ai");
    await c.callTool({ name: "ringkeeper_use_client", arguments: { client: "Globex" } });
    gateway.setActiveClient("Acme");
    expect(switches).toEqual([
      ["globex", { by: "ai", host: "Claude Desktop" }],
      ["acme", { by: "app" }],
    ]);
  });
});

describe("abandoned sessions", () => {
  it("are forgotten after a while without requests", async () => {
    const { gateway, token } = await start(config([acme]), { timings: { sessionIdleMs: 1000, sweepMs: 3_600_000 } });
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const init = await fetch(mcpUrl(gateway.port), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } },
      }),
    });
    const sid = init.headers.get("mcp-session-id")!;
    await init.text();
    expect(gateway.state().sessions).toHaveLength(1);
    gateway.sweep(Date.now() + 5000);
    expect(gateway.state().sessions).toHaveLength(0);
    const after = await fetch(mcpUrl(gateway.port), {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(after.status).toBe(404);
  });
});
