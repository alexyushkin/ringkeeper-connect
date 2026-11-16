// M1 end-to-end: real gateway, real fixture upstreams, real bridge process.
import fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CLIENT_ARG, Gateway } from "../packages/gateway/src/gateway.js";
import { spikeDefaultConfig } from "../packages/gateway/src/spike-config.js";
import { dataFiles, mcpUrl, newToken, readRuntimeInfo, writeJsonAtomic } from "../packages/gateway/src/runtime.js";
import { OFFLINE_MESSAGE } from "../packages/bridge/src/bridge.js";

const dist = resolve("dist");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-m1-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

async function startGateway(port?: number) {
  const token = newToken();
  const gateway = new Gateway({
    config: spikeDefaultConfig(join(dist, "fixture-server.mjs")),
    activeClientId: "acme",
    token,
    port: port ?? (await freePort()),
    log: process.env.RK_TEST_LOG ? (e) => console.error(JSON.stringify(e)) : undefined,
  });
  await gateway.start();
  cleanups.push(() => gateway.stop());
  return { gateway, token };
}

async function httpClient(port: number, token: string, hostName = "claude-code") {
  const client = new Client({ name: hostName, version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl(port)), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

function bridgeClient(env: Record<string, string>, hostName = "claude-code") {
  const client = new Client({ name: hostName, version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dist, "bridge.mjs")],
    env: { ...getDefaultEnvironment(), ...env },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  cleanups.push(() => client.close());
  return { client, connect: () => client.connect(transport) };
}

function waitForListChanged(client: Client): Promise<void> {
  return new Promise((r) => client.setNotificationHandler(ToolListChangedNotificationSchema, async () => r()));
}

function texts(result: unknown): string[] {
  return ((result as CallToolResult).content ?? []).map((c) => (c.type === "text" ? c.text : ""));
}

const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();

describe("gateway over HTTP", () => {
  it("shows only the active client's tools, prefixed, plus the meta tools", async () => {
    const { gateway, token } = await startGateway();
    const c = await httpClient(gateway.port, token);
    expect(await toolNames(c)).toEqual([
      "n8n_main__get_workflow",
      "n8n_main__list_workflows",
      "ringkeeper_list_clients",
      "ringkeeper_use_client",
    ]);
  });

  it("labels every result with the client it ran against", async () => {
    const { gateway, token } = await startGateway();
    const c = await httpClient(gateway.port, token);
    const out = texts(await c.callTool({ name: "n8n_main__list_workflows", arguments: {} }));
    expect(out[0]).toBe("[Client: Acme · n8n]");
    expect(out[1]).toContain("Acme lead intake");
  });

  it("rejects requests without the install token", async () => {
    const { gateway } = await startGateway();
    const res = await fetch(mcpUrl(gateway.port), { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    const health = await fetch(`http://127.0.0.1:${gateway.port}/health`);
    expect(health.status).toBe(200);
  });

  it("switching client sends list_changed and swaps the tools", async () => {
    const { gateway, token } = await startGateway();
    const c = await httpClient(gateway.port, token);
    await c.listTools();
    const changed = waitForListChanged(c);
    const reply = texts(await c.callTool({ name: "ringkeeper_use_client", arguments: { client: "globex" } }));
    expect(reply[0]).toContain("Now working with Globex");
    await changed;
    expect(await toolNames(c)).toContain("airtable_main__list_bases");
    const out = texts(await c.callTool({ name: "n8n_main__list_workflows", arguments: {} }));
    expect(out[0]).toBe("[Client: Globex · n8n]");
    expect(out[1]).toContain("Globex lead intake");
  });

  it("a switch from outside (the tray) reaches connected hosts too", async () => {
    const { gateway, token } = await startGateway();
    const c = await httpClient(gateway.port, token);
    await c.listTools();
    const changed = waitForListChanged(c);
    gateway.setActiveClient("Globex");
    await changed;
    expect(await toolNames(c)).toContain("airtable_main__list_bases");
  });

  it("refuses a tool that belongs to another client, and says how to fix it", async () => {
    const { gateway, token } = await startGateway();
    const c = await httpClient(gateway.port, token);
    const res = (await c.callTool({ name: "airtable_main__list_bases", arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(texts(res)[0]).toMatch(/belongs to Globex.*active client is Acme/);
  });

  it("with the client argument on, rejects missing or mismatched clients and accepts the right one", async () => {
    const { gateway, token } = await startGateway();
    const c = await httpClient(gateway.port, token);
    const changed = waitForListChanged(c);
    gateway.applyConfig({ ...spikeDefaultConfig(join(dist, "fixture-server.mjs")), options: { requireClientArg: true } });
    await changed;
    const tool = (await c.listTools()).tools.find((t) => t.name === "n8n_main__list_workflows")!;
    expect(tool.inputSchema.required).toContain(CLIENT_ARG);

    const missing = (await c.callTool({ name: "n8n_main__list_workflows", arguments: {} })) as CallToolResult;
    expect(missing.isError).toBe(true);

    const wrong = (await c.callTool({ name: "n8n_main__list_workflows", arguments: { [CLIENT_ARG]: "Globex" } })) as CallToolResult;
    expect(wrong.isError).toBe(true);
    expect(texts(wrong)[0]).toContain("Nothing was run");
    expect(texts(wrong).join(" ")).not.toContain("lead intake");

    const right = texts(await c.callTool({ name: "n8n_main__list_workflows", arguments: { [CLIENT_ARG]: "acme" } }));
    expect(right[1]).toContain("Acme lead intake");
  });

  it("falls back to a free port when the install port is taken", async () => {
    const blocker = net.createServer();
    const taken = await new Promise<number>((r) => blocker.listen(0, "127.0.0.1", () => r((blocker.address() as net.AddressInfo).port)));
    cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const { gateway } = await startGateway(taken);
    expect(gateway.usedFallbackPort).toBe(true);
    expect(gateway.port).not.toBe(taken);
  });
});

describe("bridge (stdio)", () => {
  it("forwards to the running gateway, including list_changed", async () => {
    const { gateway, token } = await startGateway();
    const dataDir = tempDir();
    writeJsonAtomic(dataFiles(dataDir).runtime, { version: 1, port: gateway.port, token, pid: process.pid, startedAt: "" });
    const { client, connect } = bridgeClient({ RINGKEEPER_DATA_DIR: dataDir, RINGKEEPER_NO_LAUNCH: "1" });
    await connect();
    expect(client.getServerVersion()?.name).toBe("ringkeeper-connect");
    expect(await toolNames(client)).toContain("n8n_main__list_workflows");

    const changed = waitForListChanged(client);
    gateway.setActiveClient("globex");
    await changed;
    expect(await toolNames(client)).toContain("airtable_main__list_bases");
    const out = texts(await client.callTool({ name: "airtable_main__list_bases", arguments: {} }));
    expect(out[0]).toBe("[Client: Globex · Airtable]");
  });

  it("explains itself in plain language when Ringkeeper isn't running", async () => {
    const dataDir = tempDir();
    const { client, connect } = bridgeClient({ RINGKEEPER_DATA_DIR: dataDir, RINGKEEPER_NO_LAUNCH: "1" });
    await connect();
    expect(await toolNames(client)).toEqual(["ringkeeper_status"]);
    const res = (await client.callTool({ name: "ringkeeper_status", arguments: {} })) as CallToolResult;
    expect(texts(res)[0]).toBe(OFFLINE_MESSAGE);
  });

  it("starts the gateway itself if it isn't running", async () => {
    const dataDir = tempDir();
    const { client, connect } = bridgeClient({ RINGKEEPER_DATA_DIR: dataDir });
    cleanups.push(async () => {
      const info = readRuntimeInfo(dataDir);
      if (info) {
        await fetch(`http://127.0.0.1:${info.port}/admin/shutdown`, {
          method: "POST",
          headers: { Authorization: `Bearer ${info.token}` },
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
      }
    });
    await connect();
    expect(await toolNames(client)).toContain("n8n_main__list_workflows");
    expect(readRuntimeInfo(dataDir)).not.toBeNull();
  });
});
