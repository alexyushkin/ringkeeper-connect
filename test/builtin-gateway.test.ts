// End to end: the gateway runs Ringkeeper Connect's own tools program (dist/tools.mjs)
// for a Google account, with the client's access token, against a stand-in Google.
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Gateway } from "../packages/gateway/src/gateway.js";
import { BUILTIN_TOOLS_COMMAND, type ClientConfig } from "../packages/gateway/src/config.js";
import type { OAuthState, OAuthStateStore, RegisteredApp } from "../packages/gateway/src/oauth.js";
import { mcpUrl, newToken } from "../packages/gateway/src/runtime.js";

const toolsProgram = join(resolve("dist"), "tools.mjs");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

/** Google's token service and calendar, as far as these tests need them. */
async function fakeGoogle() {
  const bearers: string[] = [];
  const refreshes: Array<Record<string, string>> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/token") {
        refreshes.push(Object.fromEntries(new URLSearchParams(body)));
        return res.end(JSON.stringify({ access_token: `access-${refreshes.length}`, expires_in: 3599, token_type: "Bearer" }));
      }
      if (req.url?.startsWith("/calendar/calendars/primary/events")) {
        bearers.push(req.headers.authorization ?? "");
        return res.end(JSON.stringify({ items: [{ id: "e1", summary: "Kickoff with Acme", start: { dateTime: "2026-11-20T10:00:00Z" }, end: { dateTime: "2026-11-20T11:00:00Z" } }] }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app: RegisteredApp = { id: "google", clientId: "g-id", clientSecret: "g-secret", authorizationEndpoint: `${base}/auth`, tokenEndpoint: `${base}/token` };
  return { base, app, bearers, refreshes };
}

function memoryStore(): OAuthStateStore {
  const states = new Map<string, OAuthState>();
  return { load: (k) => states.get(k), save: (k, s) => void states.set(k, s) };
}

function googleClient(base: string, access: string, extra: Record<string, unknown> = {}): ClientConfig {
  return {
    id: "acme",
    name: "Acme",
    connections: [
      {
        id: "google",
        name: "Google",
        command: BUILTIN_TOOLS_COMMAND,
        args: ["google"],
        env: { RINGKEEPER_ACCESS: access, RINGKEEPER_TOOLS_BASE_CALENDAR: `${base}/calendar` },
        oauth: { key: "acme/google", app: "google", scope: "openid email https://www.googleapis.com/auth/calendar.events.readonly" },
        ...extra,
      },
    ],
  };
}

async function start(client: ClientConfig, app: RegisteredApp, oauthStore: OAuthStateStore) {
  const token = newToken();
  const gateway = new Gateway({
    config: { clients: [client], options: { requireClientArg: false } },
    activeClientId: client.id,
    token,
    port: await freePort(),
    upstreamEnv: { oauthStore, apps: { google: app }, toolsProgram },
  });
  await gateway.start();
  cleanups.push(() => gateway.stop());
  const mcp = new Client({ name: "claude-code", version: "1" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(gateway.port)), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  cleanups.push(() => mcp.close());
  return { gateway, mcp };
}

const text = (r: unknown) => ((r as CallToolResult).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
const listEvents = { start: "2026-11-20", end: "2026-11-21" };

describe("a Google account in the gateway", () => {
  it("offers only the ticked things, and calls Google with the client's access token", async () => {
    const google = await fakeGoogle();
    const store = memoryStore();
    store.save("acme/google", { tokens: { access_token: "access-0", refresh_token: "refresh-1", expires_in: 3600, token_type: "Bearer" }, obtainedAt: Date.now() });
    const { mcp } = await start(googleClient(google.base, "calendar_read"), google.app, store);

    const res = (await mcp.callTool({ name: "ringkeeper_call_tool", arguments: { client: "Acme", tool: "list_events", arguments: listEvents } })) as CallToolResult;
    expect(res.isError, text(res)).toBeFalsy();
    expect(text(res)).toContain("Kickoff with Acme");
    expect(google.bearers).toEqual(["Bearer access-0"]);
    expect(google.refreshes).toEqual([]);

    const found = text(await mcp.callTool({ name: "ringkeeper_search_tools", arguments: { client: "Acme", query: "calendar mail event" } }));
    expect(found).toContain("list_events");
    expect(found).not.toContain("create_event");
    expect(found).not.toContain("search_mail");
  }, 60_000);

  it("restarts the program with a renewed token before the old one runs out", async () => {
    const google = await fakeGoogle();
    const store = memoryStore();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-18T12:00:00Z") });
    store.save("acme/google", { tokens: { access_token: "access-0", refresh_token: "refresh-1", expires_in: 3600, token_type: "Bearer" }, obtainedAt: Date.now() });
    const { mcp } = await start(googleClient(google.base, "calendar_read"), google.app, store);

    await mcp.callTool({ name: "ringkeeper_call_tool", arguments: { client: "Acme", tool: "list_events", arguments: listEvents } });
    // 59 minutes later: one minute of the old token left.
    vi.setSystemTime(new Date("2026-11-18T12:59:00Z"));
    const res = (await mcp.callTool({ name: "ringkeeper_call_tool", arguments: { client: "Acme", tool: "list_events", arguments: listEvents } })) as CallToolResult;
    expect(res.isError, text(res)).toBeFalsy();
    expect(google.bearers).toEqual(["Bearer access-0", "Bearer access-1"]);
    // Google keeps the permissions it granted: they aren't sent again.
    expect(google.refreshes).toEqual([{ client_id: "g-id", client_secret: "g-secret", grant_type: "refresh_token", refresh_token: "refresh-1" }]);
    expect(store.load("acme/google")!.tokens!.refresh_token).toBe("refresh-1");
  }, 60_000);

  it("without a sign-in, says to sign in instead of starting the program", async () => {
    const google = await fakeGoogle();
    const { gateway, mcp } = await start(googleClient(google.base, "calendar_read"), google.app, memoryStore());
    const res = (await mcp.callTool({ name: "ringkeeper_call_tool", arguments: { client: "Acme", tool: "list_events", arguments: listEvents } })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(gateway.connectionStatuses().find((s) => s.connectionId === "google")?.status).toBe("needs_signin");
    expect(google.bearers).toEqual([]);
  }, 60_000);
});
