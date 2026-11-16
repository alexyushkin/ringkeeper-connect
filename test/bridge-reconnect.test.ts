// The bridge survives Ringkeeper Connect restarting (e.g. after an update),
// even if the app comes back on a different port.
import fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Gateway } from "../packages/gateway/src/gateway.js";
import { spikeDefaultConfig } from "../packages/gateway/src/spike-config.js";
import { dataFiles, newToken, writeJsonAtomic } from "../packages/gateway/src/runtime.js";

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

async function startGateway(dataDir: string, token: string) {
  const gateway = new Gateway({ config: spikeDefaultConfig(join(dist, "fixture-server.mjs")), activeClientId: "acme", token, port: await freePort() });
  await gateway.start();
  writeJsonAtomic(dataFiles(dataDir).runtime, { version: 1, port: gateway.port, token, pid: process.pid, startedAt: "" });
  return gateway;
}

async function bridge(dataDir: string) {
  const client = new Client({ name: "claude-code", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dist, "bridge.mjs")],
    env: { ...getDefaultEnvironment(), RINGKEEPER_DATA_DIR: dataDir, RINGKEEPER_NO_LAUNCH: "1" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

const texts = (r: unknown) => ((r as CallToolResult).content ?? []).map((c) => (c.type === "text" ? c.text : ""));

describe("bridge reconnect", () => {
  it("carries on after the app restarts on a different port", async () => {
    const dataDir = fs.mkdtempSync(join(tmpdir(), "rk-reconnect-"));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const token = newToken();
    const first = await startGateway(dataDir, token);
    const host = await bridge(dataDir);
    expect((await host.listTools()).tools.map((t) => t.name)).toContain("n8n_main__list_workflows");

    await first.stop();
    const second = await startGateway(dataDir, token);
    cleanups.push(() => second.stop());
    expect(second.port).not.toBe(first.port);

    const relisted = new Promise<void>((r) => host.setNotificationHandler(ToolListChangedNotificationSchema, async () => r()));
    const out = texts(await host.callTool({ name: "n8n_main__list_workflows", arguments: {} }));
    expect(out[0]).toBe("[Client: Acme · n8n]");
    await relisted;
  });

  it("answers in plain words when the app is gone and can't be started", async () => {
    const dataDir = fs.mkdtempSync(join(tmpdir(), "rk-reconnect-"));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const gateway = await startGateway(dataDir, newToken());
    const host = await bridge(dataDir);
    await host.listTools();
    await gateway.stop();
    fs.rmSync(dataFiles(dataDir).runtime);
    await expect(host.callTool({ name: "n8n_main__list_workflows", arguments: {} })).rejects.toThrow(/stopped responding/);
  });
});
