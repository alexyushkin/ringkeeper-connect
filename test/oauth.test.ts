// Sign-in end to end, against a fake vendor that behaves like the real ones:
// discovery, dynamic client registration, PKCE, rotating refresh tokens
// (reuse revokes, like Notion), and a 401 + resource_metadata challenge.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Gateway } from "../packages/gateway/src/gateway.js";
import { spikeDefaultConfig } from "../packages/gateway/src/spike-config.js";
import { mcpUrl, newToken } from "../packages/gateway/src/runtime.js";
import { SignInError, signIn, type OAuthState, type OAuthStateStore } from "../packages/gateway/src/oauth.js";
import type { ClientConfig } from "../packages/gateway/src/config.js";

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

function memoryStore(): OAuthStateStore & { data: Map<string, OAuthState> } {
  const data = new Map<string, OAuthState>();
  return { data, load: (k) => data.get(k), save: (k, s) => void data.set(k, structuredClone(s)) };
}

/** The vendor: an OAuth server in front of a real MCP server (a Ringkeeper gateway). */
async function fakeVendor(opts: { denyConsent?: boolean } = {}) {
  const innerToken = newToken();
  const inner = new Gateway({ config: spikeDefaultConfig(join(dist, "fixture-server.mjs")), activeClientId: "acme", token: innerToken, port: await freePort() });
  await inner.start();
  cleanups.push(() => inner.stop());

  const state = {
    clients: new Map<string, string[]>(),
    codes: new Map<string, { challenge: string; redirect: string }>(),
    validAccess: new Set<string>(),
    currentRefresh: undefined as string | undefined,
    revoked: false,
    refreshCount: 0,
  };
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const issue = () => {
    const access = `at_${randomBytes(6).toString("hex")}`;
    const refresh = `rt_${randomBytes(6).toString("hex")}`;
    state.validAccess.add(access);
    state.currentRefresh = refresh;
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 };
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const readBody = async (req: http.IncomingMessage) => {
    let s = "";
    for await (const c of req) s += c;
    return s;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      const meta = JSON.parse(await readBody(req));
      const id = `client_${state.clients.size + 1}`;
      state.clients.set(id, meta.redirect_uris);
      return json(res, 201, { ...meta, client_id: id });
    }
    if (url.pathname === "/authorize") {
      // The user approves in the browser (or not).
      const redirect = url.searchParams.get("redirect_uri")!;
      const okClient = state.clients.get(url.searchParams.get("client_id") ?? "")?.includes(redirect);
      if (!okClient || url.searchParams.get("code_challenge_method") !== "S256") return json(res, 400, { error: "invalid_request" });
      const back = new URL(redirect);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      if (opts.denyConsent) back.searchParams.set("error", "access_denied");
      else {
        const code = randomBytes(8).toString("hex");
        state.codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("grant_type") === "authorization_code") {
        const c = state.codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!c || createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return json(res, 400, { error: "invalid_grant" });
        state.codes.delete(form.get("code")!);
        return json(res, 200, issue());
      }
      if (form.get("grant_type") === "refresh_token") {
        state.refreshCount++;
        if (state.revoked || form.get("refresh_token") !== state.currentRefresh) {
          state.revoked = true; // reuse of an old refresh token revokes the grant
          return json(res, 400, { error: "invalid_grant" });
        }
        return json(res, 200, issue());
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/mcp") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!state.validAccess.has(token)) {
        res
          .writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` })
          .end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      const proxied = http.request(
        { host: "127.0.0.1", port: inner.port, path: "/mcp", method: req.method, headers: { ...req.headers, host: `127.0.0.1:${inner.port}`, authorization: `Bearer ${innerToken}` } },
        (pres) => {
          res.writeHead(pres.statusCode ?? 500, pres.headers);
          pres.pipe(res);
        },
      );
      req.pipe(proxied);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  cleanups.push(() => server.closeAllConnections());
  return { base, url: `${base}/mcp`, state };
}

/** Plays the user's browser: follow the vendor's redirect back to Ringkeeper's loopback address. */
async function browser(url: string) {
  const r = await fetch(url, { redirect: "manual" });
  const back = r.headers.get("location");
  if (back) await fetch(back);
}

async function gatewayWith(conn: ClientConfig["connections"][number], store: OAuthStateStore) {
  const token = newToken();
  const g = new Gateway({
    config: { clients: [{ id: "initech", name: "Initech", connections: [conn] }], options: { requireClientArg: false } },
    activeClientId: "initech",
    token,
    port: await freePort(),
    upstreamEnv: { oauthStore: store },
  });
  await g.start();
  cleanups.push(() => g.stop());
  const host = new Client({ name: "claude-code", version: "1" });
  await host.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(g.port)), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  cleanups.push(() => host.close());
  return { g, host };
}

describe("signing in to a web connection", () => {
  it("signs in through the browser, saves the tokens, and the connection works", async () => {
    const vendor = await fakeVendor();
    const store = memoryStore();
    await signIn({ serverUrl: vendor.url, label: "Notion for Initech", store, key: "initech/notion/~oauth", openBrowser: (u) => void browser(u) });
    const saved = store.load("initech/notion/~oauth")!;
    expect(saved.tokens?.access_token).toMatch(/^at_/);
    expect(saved.client).toMatchObject({ client_id: "client_1" });
    expect(saved.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const { g, host } = await gatewayWith({ kind: "remote", id: "notion", name: "Notion", url: vendor.url, oauth: { key: "initech/notion/~oauth" } }, store);
    expect((await host.listTools()).tools.map((t) => t.name)).toContain("notion__ringkeeper_list_clients");
    expect(g.connectionStatuses()[0]).toMatchObject({ status: "ready" });
  });

  it("refreshes an expired sign-in by itself and keeps the new refresh token", async () => {
    const vendor = await fakeVendor();
    const store = memoryStore();
    await signIn({ serverUrl: vendor.url, label: "Notion for Initech", store, key: "k", openBrowser: (u) => void browser(u) });
    const firstRefresh = store.load("k")!.tokens!.refresh_token;
    vendor.state.validAccess.clear(); // the access token expires

    const { host } = await gatewayWith({ kind: "remote", id: "notion", name: "Notion", url: vendor.url, oauth: { key: "k" } }, store);
    expect((await host.listTools()).tools.length).toBeGreaterThan(0);
    expect(vendor.state.refreshCount).toBe(1);
    expect(store.load("k")!.tokens!.refresh_token).not.toBe(firstRefresh);
    expect(store.load("k")!.tokens!.refresh_token).toBe(vendor.state.currentRefresh);
  });

  it("asks the user to sign in again when the vendor has revoked it, without opening a browser", async () => {
    const vendor = await fakeVendor();
    const store = memoryStore();
    await signIn({ serverUrl: vendor.url, label: "Notion for Initech", store, key: "k", openBrowser: (u) => void browser(u) });
    vendor.state.validAccess.clear();
    vendor.state.revoked = true;

    const { g, host } = await gatewayWith({ kind: "remote", id: "notion", name: "Notion", url: vendor.url, oauth: { key: "k" } }, store);
    await host.listTools();
    expect(g.connectionStatuses()[0]).toMatchObject({
      status: "needs_signin",
      problem: "Notion for Initech needs you to sign in again. Choose Sign in under Initech > Notion in Ringkeeper Connect.",
    });
  });

  it("a connection that was never signed in says so, and isn't started", async () => {
    const store = memoryStore();
    const { g } = await gatewayWith({ kind: "remote", id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", oauth: { key: "k" }, needsSignIn: true }, store);
    expect(g.connectionStatuses()[0]).toMatchObject({ status: "needs_signin", problem: expect.stringMatching(/needs you to sign in\. Choose Sign in/) });
  });

  it("explains a cancelled sign-in in plain words", async () => {
    const vendor = await fakeVendor({ denyConsent: true });
    await expect(
      signIn({ serverUrl: vendor.url, label: "Notion for Initech", store: memoryStore(), key: "k", openBrowser: (u) => void browser(u) }),
    ).rejects.toThrow(new SignInError("Sign-in to Notion for Initech was cancelled."));
  });

  it("explains a service whose sign-in can't be used", async () => {
    const plain = http.createServer((_req, res) => res.writeHead(404).end());
    const port = await freePort();
    await new Promise<void>((r) => plain.listen(port, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>((r) => plain.close(() => r())));
    await expect(
      signIn({ serverUrl: `http://127.0.0.1:${port}/mcp`, label: "Stripe for Initech", store: memoryStore(), key: "k", openBrowser: () => {} }),
    ).rejects.toThrow(/doesn't offer a sign-in that Ringkeeper Connect can use. Use a key instead/);
  });
});
