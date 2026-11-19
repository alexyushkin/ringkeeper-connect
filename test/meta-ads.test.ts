// Meta Ads signed in through the agency's own Meta app (a Marketing API app), running Ringkeeper
// Connect's own Meta Ads tools: Meta's own ads server lets in only the AI apps Meta approved, and
// Ringkeeper Connect ships no Meta app (its secret would be in every copy). The sign-in comes back through an https page that hands
// it to this computer, and the first token is swapped for one lasting about 60 days.
import fs from "node:fs";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogActionError, CatalogActions } from "../apps/desktop/src/main/catalog.js";
import { OwnApps, OwnAppsError } from "../apps/desktop/src/main/own-apps.js";
import { META_RETURN_PAGE } from "../apps/desktop/src/shared/api.js";
import type { RegisteredApp } from "../packages/gateway/src/oauth.js";
import { ClientStore, oauthKey, ownAppSecretKey, secretOAuthStore } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";

const APP_ID = "1234567890123456";
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
};

/** A stand-in for Meta's Graph API token address (asked with GET, as Meta documents it). */
async function fakeMeta() {
  const seen: Array<Record<string, string>> = [];
  let challenge = "";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = Object.fromEntries(url.searchParams);
    seen.push({ method: req.method ?? "", path: url.pathname, ...p });
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const refused = { error: { message: "Error validating client secret.", type: "OAuthException", code: 1 } };
    if (req.method !== "GET" || url.pathname !== "/oauth/access_token") return reply(404, {});
    if (p.client_id !== APP_ID || p.client_secret !== APP_SECRET) return reply(400, refused);
    if (p.grant_type === "client_credentials") return reply(200, { access_token: `${APP_ID}|app-token`, token_type: "bearer" });
    if (p.grant_type === "authorization_code") {
      const pkce = createHash("sha256").update(p.code_verifier ?? "").digest("base64url") === challenge;
      if (p.code !== "meta-code" || !pkce || p.redirect_uri !== META_RETURN_PAGE) return reply(400, { error: { message: "Invalid verification code format.", code: 100 } });
      return reply(200, { access_token: "short-lived", token_type: "bearer", expires_in: 5400 });
    }
    if (p.grant_type === "fb_exchange_token" && p.fb_exchange_token === "short-lived") return reply(200, { access_token: "lasting", token_type: "bearer", expires_in: 5183944 });
    reply(400, { error: { message: "Unsupported grant type", code: 100 } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const graph = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** The browser: Facebook's dialog approves, and the https return page hands the code to the port in the state. */
  const browser = (opened: string[]) => (address: string) => {
    opened.push(address);
    const u = new URL(address);
    challenge = u.searchParams.get("code_challenge") ?? "";
    const state = u.searchParams.get("state")!;
    const port = /^(\d+)\./.exec(state)![1];
    void fetch(`http://127.0.0.1:${port}/callback?code=meta-code&state=${encodeURIComponent(state)}`).then((r) => r.text());
  };
  return { seen, graph, browser };
}

async function setup(openExternal: (url: string) => void = () => {}) {
  const meta = await fakeMeta();
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-meta-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secrets = new SecretStore(join(dir, "secrets.json"), cipher);
  const store = new ClientStore(join(dir, "clients.json"), secrets);
  const apps: Record<string, RegisteredApp> = {};
  const own = new OwnApps({ store, secrets, apps, meta: { graph: meta.graph, dialog: `${meta.graph}/dialog/oauth` } });
  const oauthStore = secretOAuthStore(secrets);
  const actions = new CatalogActions({
    store,
    gateway: () => ({ applyConfig: () => {}, restartConnection: () => {} }) as never,
    oauthStore,
    openExternal,
    showSignInLink: () => {},
    onChange: () => {},
    apps,
    ownApps: () => own.list(),
  });
  return { dir, meta, secrets, store, apps, own, actions, oauthStore };
}

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(OwnAppsError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("your own Meta app", () => {
  it("checks the App ID and secret with Meta, keeps the secret encrypted, and signs in Meta's way", async () => {
    const { own, apps, meta, dir, secrets } = await setup();
    const added = await own.add({ vendor: "meta", name: "Agency", clientId: ` ${APP_ID} `, clientSecret: ` ${APP_SECRET}\n` });
    expect(added).toEqual({ id: "meta:agency", vendor: "meta", name: "Agency", clientId: APP_ID, usedBy: [] });
    // The check asked for the app's own token, which Meta gives only for the right pair; it isn't kept.
    expect(meta.seen[0]).toMatchObject({ method: "GET", grant_type: "client_credentials", client_id: APP_ID });
    expect(apps["meta:agency"]).toMatchObject({
      clientId: APP_ID,
      clientSecret: APP_SECRET,
      returnPage: META_RETURN_PAGE,
      scopeSeparator: ",",
      tokenByGet: true,
      longLivedExchange: true,
    });
    expect(secrets.get(ownAppSecretKey("meta:agency"))).toBe(APP_SECRET);
    const onDisk = fs.readFileSync(join(dir, "clients.json"), "utf8");
    expect(onDisk).toContain(APP_ID);
    expect(onDisk).not.toContain(APP_SECRET);
    expect(fs.readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain(APP_SECRET);
  });

  it("refuses what isn't a Meta App ID or secret, and a pair Meta turns down", async () => {
    const { own } = await setup();
    expect(await errorOf(own.add({ vendor: "meta", name: "X", clientId: "abc", clientSecret: APP_SECRET }))).toMatch(/isn't a Meta App ID/);
    expect(await errorOf(own.add({ vendor: "meta", name: "X", clientId: APP_ID, clientSecret: "" }))).toMatch(/Paste the App secret too/);
    expect(await errorOf(own.add({ vendor: "meta", name: "X", clientId: APP_ID, clientSecret: "not-a-secret" }))).toMatch(/isn't a Meta App secret/);
    expect(await errorOf(own.add({ vendor: "meta", name: "X", clientId: APP_ID, clientSecret: "ffffffffffffffffffffffffffffffff" }))).toBe(
      "Meta didn't accept this App ID and App secret. Copy both again from App settings > Basic on Meta for Developers.",
    );
    expect(own.list()).toEqual([]);
  });
});

describe("Meta Ads", () => {
  it("is offered only with your own Meta app, and says how to get one", async () => {
    const t = await setup();
    const tile = () => t.actions.services().find((s) => s.id === "meta_ads")!.options.find((o) => o.id === "signin")!;
    expect(tile()).toMatchObject({ unavailable: true, kind: "local", command: "ringkeeper-tools", args: ["meta-ads"], app: "meta" });
    expect(tile()).not.toHaveProperty("url");
    const acme = t.store.addClient("Acme");
    expect(() => t.actions.add(acme.id, "meta_ads", "signin", {}, "Meta Ads")).toThrow('Meta Ads signs in through your own Meta app. Set one up under "Your own apps" first.');
    await t.own.add({ vendor: "meta", name: "Agency", clientId: APP_ID, clientSecret: APP_SECRET });
    expect(tile().unavailable).toBeUndefined();
    expect(tile().signInApps).toEqual([{ id: "meta:agency", name: "Agency" }]);
  });

  it("signs in through your Meta app via the return page, swaps for a lasting sign-in, and won't drop the app in use", async () => {
    const opened: string[] = [];
    const t = await setup((url) => t.meta.browser(opened)(url));
    await t.own.add({ vendor: "meta", name: "Agency", clientId: APP_ID, clientSecret: APP_SECRET });
    const acme = t.store.addClient("Acme");
    const added = t.actions.add(acme.id, "meta_ads", "signin", {}, "Meta Ads");
    await t.actions.signIn(acme.id, added.connectionId);

    const dialog = new URL(opened[0]!);
    expect(dialog.origin + dialog.pathname).toBe(`${t.meta.graph}/dialog/oauth`);
    expect(dialog.searchParams.get("client_id")).toBe(APP_ID);
    expect(dialog.searchParams.get("redirect_uri")).toBe(META_RETURN_PAGE);
    // Only what a Marketing API app has: none of the ads server's own permissions.
    expect(dialog.searchParams.get("scope")).toBe("business_management,ads_read");
    expect(dialog.searchParams.get("state")).toMatch(/^\d{4,5}\./);
    // The secret goes only to Meta's token address, never into the browser.
    expect(opened[0]).not.toContain(APP_SECRET);

    const conn = t.store.toGatewayConfig().clients[0]!.connections[0]!;
    expect(conn).toMatchObject({ command: "ringkeeper-tools", args: ["meta-ads"], env: { RINGKEEPER_ACCESS: "ads_read" }, oauth: { app: "meta:agency" } });
    expect(conn.kind).not.toBe("remote");
    const key = conn.kind !== "remote" ? conn.oauth!.key : "";
    expect(t.oauthStore.load(key)!.tokens).toMatchObject({ access_token: "lasting", expires_in: 5183944 });
    expect(t.meta.seen.map((s) => s.grant_type)).toEqual(["client_credentials", "authorization_code", "fb_exchange_token"]);

    expect(t.own.list()[0]!.usedBy).toEqual(["Acme > Meta Ads"]);
    expect(() => t.own.remove("meta:agency")).toThrow("Acme > Meta Ads signs in through this app. Remove that tool first.");
  });

  it("turns a Meta Ads tool brought in from an AI app into the built-in tools, signed in through your Meta app", async () => {
    const opened: string[] = [];
    const t = await setup((url) => t.meta.browser(opened)(url));
    const acme = t.store.addClient("Acme");
    const brought = t.store.addConnection(acme.id, { kind: "remote", name: "Meta Ads", url: "https://mcp.facebook.com/ads/", auth: "oauth", fields: [] });
    // No Meta app yet: says what to do instead of trying a sign-in that can't work.
    await expect(t.actions.signIn(acme.id, brought.id)).rejects.toThrow(CatalogActionError);
    await expect(t.actions.signIn(acme.id, brought.id)).rejects.toThrow(/Set one up under "Your own apps", then click Sign in again. Or remove it and add Meta Ads with an access token instead./);
    expect(opened).toEqual([]);

    await t.own.add({ vendor: "meta", name: "Agency", clientId: APP_ID, clientSecret: APP_SECRET });
    await t.actions.signIn(acme.id, brought.id);
    const conn = t.store.list()[0]!.connections[0]!;
    expect(conn).toMatchObject({ kind: "local", command: "ringkeeper-tools", args: ["meta-ads"], name: "Meta Ads", oauthApp: "meta:agency", signedIn: true });
    expect(conn.scope).toBe("business_management ads_read");
    expect(conn.fields).toContainEqual(expect.objectContaining({ name: "RINGKEEPER_ACCESS", value: "ads_read" }));
    expect(new URL(opened[0]!).searchParams.get("redirect_uri")).toBe(META_RETURN_PAGE);
  });
  it("edits a signed-in Meta Ads tool as a sign-in: ticking pausing asks for ads_management, with no token field", async () => {
    const t = await setup();
    await t.own.add({ vendor: "meta", name: "Agency", clientId: APP_ID, clientSecret: APP_SECRET });
    const acme = t.store.addClient("Acme");
    const added = t.actions.add(acme.id, "meta_ads", "signin", {}, "Meta Ads");
    t.oauthStore.save(oauthKey(acme.id, added.connectionId), { tokens: { access_token: "lasting", token_type: "bearer", expires_in: 5183944 }, obtainedAt: Date.now() });
    expect(t.actions.editBuiltIn(acme.id, added.connectionId, "Meta Ads", ["ads_read"])).toEqual({ needsSignIn: false });
    expect(t.actions.editBuiltIn(acme.id, added.connectionId, "Meta Ads", ["ads_read", "ads_pause"])).toEqual({ needsSignIn: true });
    const conn = t.store.list()[0]!.connections[0]!;
    expect(conn.scope).toBe("business_management ads_read ads_management");
    expect(conn.fields.map((f) => f.name)).toEqual(["RINGKEEPER_ACCESS"]);
  });
});
