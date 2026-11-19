// "Use your own Google or Microsoft app": a Google app in the agency's own Google Cloud
// project (kept with its secret encrypted) or a Microsoft app in their own Entra directory
// (no secret), checked with the vendor before it's saved, offered when an account is added,
// and used for that account's sign-in and renewals.
import fs from "node:fs";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogActions } from "../apps/desktop/src/main/catalog.js";
import { OwnApps, OwnAppsError } from "../apps/desktop/src/main/own-apps.js";
import { registeredApps } from "../apps/desktop/src/main/registered-apps.js";
import { directAccessToken, type RegisteredApp } from "../packages/gateway/src/oauth.js";
import { ClientStore, ownAppSecretKey, secretOAuthStore } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";

const CLIENT_ID = "123-abc.apps.googleusercontent.com";
const SECRET = "GOCSPX-own-secret-value";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
};

/** A stand-in for Google's token service: knows one client, checks PKCE, hands out and renews tokens. */
async function fakeGoogle() {
  const seen: Array<Record<string, string>> = [];
  let challenge = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = Object.fromEntries(new URLSearchParams(body));
      seen.push(p);
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (p.client_id !== CLIENT_ID || p.client_secret !== SECRET) return reply(401, { error: "invalid_client", error_description: "The OAuth client was not found." });
      if (p.grant_type === "authorization_code") {
        if (p.code !== "the-code" || createHash("sha256").update(p.code_verifier ?? "").digest("base64url") !== challenge) return reply(400, { error: "invalid_grant" });
        return reply(200, { access_token: "own-access-1", refresh_token: "own-refresh", expires_in: 3599, token_type: "Bearer" });
      }
      if (p.grant_type === "refresh_token" && p.refresh_token === "own-refresh") return reply(200, { access_token: "own-access-2", expires_in: 3599, token_type: "Bearer" });
      reply(400, { error: "invalid_request" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints = { authorizationEndpoint: `${base}/auth`, tokenEndpoint: `${base}/token` };
  const browser = (opened: string[]) => (url: string) => {
    opened.push(url);
    const u = new URL(url);
    challenge = u.searchParams.get("code_challenge") ?? "";
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "the-code");
    back.searchParams.set("state", u.searchParams.get("state")!);
    void fetch(back).then((r) => r.text());
  };
  return { seen, endpoints, browser };
}

const MS_ID = "1a2b3c4d-1234-5678-9abc-1a2b3c4d5e6f";
const TENANTS = new Set(["organizations", "common", "contoso.onmicrosoft.com"]);

/**
 * A stand-in for Microsoft's sign-in service: knows one app (with the 127.0.0.1/callback return
 * address, any port) in the tenants above. A silent sign-in (prompt=none) with nobody signed in
 * comes back with login_required, as Microsoft's does; anything wrong stays on an error page.
 */
async function fakeMicrosoft() {
  const seen: Array<{ path: string; p: Record<string, string> }> = [];
  let challenge = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const [, tenant, , , what] = url.pathname.split("/");
      const p = req.method === "GET" ? Object.fromEntries(url.searchParams) : Object.fromEntries(new URLSearchParams(body));
      seen.push({ path: url.pathname, p });
      const page = (code: string) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><script>var cfg={"strServiceExceptionMessage":"${code}: something"};</script></html>`);
      };
      const json = (status: number, j: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(j));
      };
      if (!TENANTS.has(tenant!)) return page("AADSTS90002");
      if (what === "authorize") {
        const back = p.redirect_uri ? new URL(p.redirect_uri) : undefined;
        if (p.client_id !== MS_ID) return page("AADSTS50059");
        if (!back || back.hostname !== "127.0.0.1" || back.pathname !== "/callback") return page("AADSTS50011");
        back.searchParams.set("error", "login_required");
        back.searchParams.set("state", p.state ?? "");
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (p.client_id !== MS_ID) return json(400, { error: "unauthorized_client" });
      if (p.client_secret) return json(401, { error: "invalid_client", error_description: "AADSTS700025: Client is public" });
      if (p.grant_type === "authorization_code") {
        if (p.code !== "ms-code" || createHash("sha256").update(p.code_verifier ?? "").digest("base64url") !== challenge) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: "ms-access-1", refresh_token: "ms-refresh-1", expires_in: 3599, token_type: "Bearer" });
      }
      if (p.grant_type === "refresh_token" && p.refresh_token === "ms-refresh-1" && p.scope) {
        return json(200, { access_token: "ms-access-2", refresh_token: "ms-refresh-2", expires_in: 3599, token_type: "Bearer" });
      }
      json(400, { error: "invalid_grant" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const login = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = (opened: string[]) => (url: string) => {
    opened.push(url);
    const u = new URL(url);
    challenge = u.searchParams.get("code_challenge") ?? "";
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "ms-code");
    back.searchParams.set("state", u.searchParams.get("state")!);
    void fetch(back).then((r) => r.text());
  };
  return { seen, login, browser };
}

async function setup(ours: Record<string, RegisteredApp> = {}, openExternal: (url: string) => void = () => {}) {
  const google = await fakeGoogle();
  const microsoft = await fakeMicrosoft();
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-ownapps-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secrets = new SecretStore(join(dir, "secrets.json"), cipher);
  const store = new ClientStore(join(dir, "clients.json"), secrets);
  const apps: Record<string, RegisteredApp> = { ...ours };
  const restarted: string[] = [];
  const own = new OwnApps({ store, secrets, apps, endpoints: google.endpoints, microsoftLogin: microsoft.login, restart: (_c, id) => restarted.push(id) });
  const oauthStore = secretOAuthStore(secrets);
  const actions = new CatalogActions({
    store,
    gateway: () => ({ applyConfig: () => {}, restartConnection: (_c: string, id: string) => restarted.push(id) }) as never,
    oauthStore,
    openExternal,
    showSignInLink: () => {},
    onChange: () => {},
    apps,
    ownApps: () => own.list(),
  });
  return { dir, google, microsoft, secrets, store, apps, own, actions, oauthStore, restarted };
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

describe("your own Google apps", () => {
  it("checks the client with Google, then keeps its secret encrypted and out of the settings", async () => {
    const { own, apps, dir, google, secrets } = await setup();
    const added = await own.add({ name: "Acme Agency", clientId: ` ${CLIENT_ID} `, clientSecret: ` ${SECRET}\n` });
    expect(added).toEqual({ id: "google:acme_agency", vendor: "google", name: "Acme Agency", clientId: CLIENT_ID, usedBy: [] });
    // The check sent a code that can't work, so nothing was created at Google.
    expect(google.seen[0]).toMatchObject({ grant_type: "authorization_code", code: "ringkeeper-connect-check", client_id: CLIENT_ID });
    expect(apps["google:acme_agency"]).toMatchObject({ clientId: CLIENT_ID, clientSecret: SECRET, authParams: { access_type: "offline", prompt: "consent select_account" } });
    expect(secrets.get(ownAppSecretKey("google:acme_agency"))).toBe(SECRET);
    const onDisk = fs.readFileSync(join(dir, "clients.json"), "utf8") + fs.readFileSync(join(dir, "secrets.json"), "utf8");
    expect(onDisk).toContain(CLIENT_ID);
    expect(onDisk).not.toContain(SECRET);
    expect(JSON.stringify(own.list())).not.toContain(SECRET);
  });

  it("refuses what isn't a Google client, a client Google turns down, and the same client twice", async () => {
    const { own, apps } = await setup();
    expect(await errorOf(own.add({ name: "X", clientId: "123-abc", clientSecret: SECRET }))).toMatch(/ends with \.apps\.googleusercontent\.com/);
    expect(await errorOf(own.add({ name: "X", clientId: CLIENT_ID, clientSecret: "  " }))).toMatch(/Paste the client secret/);
    expect(await errorOf(own.add({ name: " ", clientId: CLIENT_ID, clientSecret: SECRET }))).toMatch(/Name this Google app/);
    expect(await errorOf(own.add({ name: "X", clientId: CLIENT_ID, clientSecret: "GOCSPX-wrong" }))).toBe(
      "Google didn't accept this client ID and secret. Copy both again from Google Cloud > Clients (the client's type must be Desktop app).",
    );
    expect(own.list()).toEqual([]);
    await own.add({ name: "First", clientId: CLIENT_ID, clientSecret: SECRET });
    expect(await errorOf(own.add({ name: "Second", clientId: CLIENT_ID, clientSecret: SECRET }))).toBe('That Google app is already set up, as "First".');
    expect(Object.keys(apps)).toEqual(["google:first"]);
  });

  it("says when Google can't be reached to check it", async () => {
    const { store, secrets } = await setup();
    const offline = new OwnApps({ store, secrets, apps: {}, fetchFn: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect(await errorOf(offline.add({ name: "X", clientId: CLIENT_ID, clientSecret: SECRET }))).toMatch(/Couldn't reach Google to check this app/);
  });

  it("survives a client called apps being removed, and comes back after a restart", async () => {
    const { own, store, secrets, dir } = await setup();
    await own.add({ name: "Ours", clientId: CLIENT_ID, clientSecret: SECRET });
    const c = store.addClient("apps");
    store.removeClient(c.id);
    expect(secrets.get(ownAppSecretKey("google:ours"))).toBe(SECRET);
    const again: Record<string, RegisteredApp> = {};
    const reopened = new SecretStore(join(dir, "secrets.json"), cipher);
    new OwnApps({ store: new ClientStore(join(dir, "clients.json"), reopened), secrets: reopened, apps: again });
    expect(again["google:ours"]).toMatchObject({ clientId: CLIENT_ID, clientSecret: SECRET });
  });

  it("is offered when a Google account is added, after Ringkeeper Connect's own app", async () => {
    const ours = registeredApps({ RINGKEEPER_GOOGLE_CLIENT_ID: "ours.apps.googleusercontent.com" }, {});
    const without = await setup();
    expect(without.actions.services().find((s) => s.id === "google")!.options[0]).toMatchObject({ unavailable: true });
    await without.own.add({ name: "Agency", clientId: CLIENT_ID, clientSecret: SECRET });
    const option = without.actions.services().find((s) => s.id === "google")!.options[0]!;
    expect(option.unavailable).toBeUndefined();
    expect(option.signInApps).toEqual([{ id: "google:agency", name: "Agency" }]);
    // Microsoft isn't offered through a Google app.
    expect(without.actions.services().find((s) => s.id === "microsoft")!.options[0]).toMatchObject({ unavailable: true });

    const both = await setup(ours);
    await both.own.add({ name: "Agency", clientId: CLIENT_ID, clientSecret: SECRET });
    expect(both.actions.services().find((s) => s.id === "google")!.options[0]!.signInApps).toEqual([
      { id: "google", name: "Ringkeeper Connect's Google app" },
      { id: "google:agency", name: "Agency" },
    ]);
  });

  it("signs a Google account in through the chosen app, renews through it, and won't drop an app in use", async () => {
    const opened: string[] = [];
    const t = await setup(registeredApps({ RINGKEEPER_GOOGLE_CLIENT_ID: "ours.apps.googleusercontent.com" }, {}), (url) => t.google.browser(opened)(url));
    await t.own.add({ name: "Agency", clientId: CLIENT_ID, clientSecret: SECRET });
    const acme = t.store.addClient("Acme");
    expect(() => t.actions.add(acme.id, "google", "signin", {}, "Google", ["mail_read"], "google:gone")).toThrow(/isn't set up anymore/);
    const added = t.actions.add(acme.id, "google", "signin", {}, "Google", ["mail_read"], "google:agency");
    const conn = t.store.toGatewayConfig().clients[0]!.connections[0]!;
    expect(conn).toMatchObject({ oauth: { app: "google:agency" }, needsSignIn: true });

    await t.actions.signIn(acme.id, added.connectionId);
    expect(new URL(opened[0]!).searchParams.get("client_id")).toBe(CLIENT_ID);
    // The secret goes to the token service, never into the browser's address.
    expect(opened[0]).not.toContain(SECRET);
    const key = conn.kind === "local" ? conn.oauth!.key : "";
    expect(t.oauthStore.load(key)!.tokens!.access_token).toBe("own-access-1");
    // An hour later: renewed through the same app.
    const renewed = await directAccessToken(t.oauthStore, key, t.apps["google:agency"]!, "", undefined, Date.now() + 3600_000);
    expect(renewed.token).toBe("own-access-2");
    expect(t.google.seen.at(-1)).toMatchObject({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: SECRET });

    expect(t.own.list()[0]!.usedBy).toEqual(["Acme > Google"]);
    expect(() => t.own.remove("google:agency")).toThrow("Acme > Google signs in through this app. Remove that tool first.");
    expect(await errorOf(t.own.update("google:agency", { clientId: "999-new.apps.googleusercontent.com", clientSecret: SECRET }))).toMatch(/Google ties each sign-in to its client ID/);
    // A new secret for the same client is fine; the tool restarts with it.
    await t.own.update("google:agency", { name: "Agency (renamed)", clientSecret: SECRET });
    expect(t.restarted).toContain(added.connectionId);
    expect(t.own.list()[0]!.name).toBe("Agency (renamed)");

    t.store.removeConnection(acme.id, added.connectionId);
    t.own.remove("google:agency");
    expect(t.own.list()).toEqual([]);
    expect(t.apps["google:agency"]).toBeUndefined();
    expect(t.secrets.has(ownAppSecretKey("google:agency"))).toBe(false);
  });
});

describe("your own Microsoft apps", () => {
  it("checks the app with Microsoft without signing anyone in, and keeps no secret", async () => {
    const { own, apps, microsoft, secrets } = await setup();
    const added = await own.add({ vendor: "microsoft", name: "Agency", clientId: ` ${MS_ID.toUpperCase()} ` });
    expect(added).toEqual({ id: "microsoft:agency", vendor: "microsoft", name: "Agency", clientId: MS_ID, tenant: "common", usedBy: [] });
    // A silent sign-in for any organization's account, back to Ringkeeper Connect's address.
    const asked = microsoft.seen[0]!;
    expect(asked.path).toBe("/organizations/oauth2/v2.0/authorize");
    expect(asked.p).toMatchObject({ client_id: MS_ID, prompt: "none", redirect_uri: "http://127.0.0.1:53682/callback" });
    expect(apps["microsoft:agency"]).toEqual({
      id: "microsoft:agency",
      clientId: MS_ID,
      authorizationEndpoint: `${microsoft.login}/common/oauth2/v2.0/authorize`,
      tokenEndpoint: `${microsoft.login}/common/oauth2/v2.0/token`,
      authParams: { prompt: "select_account" },
      scopeOnRefresh: true,
    });
    expect(secrets.has(ownAppSecretKey("microsoft:agency"))).toBe(false);
  });

  it("signs in to one organization's directory when it's given", async () => {
    const { own, apps, microsoft } = await setup();
    await own.add({ vendor: "microsoft", name: "Contoso only", clientId: MS_ID, tenant: " Contoso.onmicrosoft.com " });
    expect(microsoft.seen[0]!.path).toBe("/contoso.onmicrosoft.com/oauth2/v2.0/authorize");
    expect(apps["microsoft:contoso_only"]!.tokenEndpoint).toBe(`${microsoft.login}/contoso.onmicrosoft.com/oauth2/v2.0/token`);
    expect(own.list()[0]!.tenant).toBe("contoso.onmicrosoft.com");
  });

  it("refuses what isn't a Microsoft app ID, an app Microsoft doesn't know, an unknown directory and the same app twice", async () => {
    const { own, store, secrets } = await setup();
    expect(await errorOf(own.add({ vendor: "microsoft", name: "X", clientId: CLIENT_ID }))).toMatch(/isn't a Microsoft Application \(client\) ID/);
    expect(await errorOf(own.add({ vendor: "microsoft", name: "X", clientId: MS_ID, tenant: "not a tenant!" }))).toMatch(/isn't a directory \(tenant\) ID/);
    expect(await errorOf(own.add({ vendor: "microsoft", name: "X", clientId: "99999999-1234-5678-9abc-1a2b3c4d5e6f" }))).toMatch(
      /^Microsoft didn't accept this app\. .*http:\/\/127\.0\.0\.1\/callback/,
    );
    expect(await errorOf(own.add({ vendor: "microsoft", name: "X", clientId: MS_ID, tenant: "fabrikam.onmicrosoft.com" }))).toBe(
      `Microsoft doesn't know the directory "fabrikam.onmicrosoft.com". Copy the Directory (tenant) ID from the app's Overview page, or leave it empty for any account.`,
    );
    expect(await errorOf(own.add({ vendor: "dropbox", name: "X", clientId: MS_ID }))).toMatch(/your own Google, Microsoft or Meta app only/);
    expect(own.list()).toEqual([]);
    await own.add({ vendor: "microsoft", name: "First", clientId: MS_ID });
    expect(await errorOf(own.add({ vendor: "microsoft", name: "Second", clientId: MS_ID }))).toBe('That Microsoft app is already set up, as "First".');
    const offline = new OwnApps({ store, secrets, apps: {}, fetchFn: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect(await errorOf(offline.add({ vendor: "microsoft", name: "Y", clientId: "88888888-1234-5678-9abc-1a2b3c4d5e6f" }))).toMatch(/Couldn't reach Microsoft to check this app/);
  });

  it("is offered on the Microsoft 365 tile after Ringkeeper Connect's own app, and not on Google's", async () => {
    const without = await setup();
    await without.own.add({ vendor: "microsoft", name: "Agency", clientId: MS_ID });
    const tile = (id: string) => without.actions.services().find((s) => s.id === id)!.options[0]!;
    expect(tile("microsoft").unavailable).toBeUndefined();
    expect(tile("microsoft").signInApps).toEqual([{ id: "microsoft:agency", name: "Agency" }]);
    expect(tile("google")).toMatchObject({ unavailable: true });

    const both = await setup(registeredApps({ RINGKEEPER_MICROSOFT_CLIENT_ID: "11111111-2222-3333-4444-555555555555" }, {}));
    await both.own.add({ vendor: "microsoft", name: "Agency", clientId: MS_ID });
    expect(both.actions.services().find((s) => s.id === "microsoft")!.options[0]!.signInApps).toEqual([
      { id: "microsoft", name: "Ringkeeper Connect's Microsoft app" },
      { id: "microsoft:agency", name: "Agency" },
    ]);
  });

  it("signs a Microsoft account in through the chosen app, renews through it, and won't move an app in use", async () => {
    const opened: string[] = [];
    const t = await setup({}, (url) => t.microsoft.browser(opened)(url));
    await t.own.add({ vendor: "microsoft", name: "Agency", clientId: MS_ID });
    const acme = t.store.addClient("Acme");
    const added = t.actions.add(acme.id, "microsoft", "signin", {}, "Microsoft 365", ["mail_read"], "microsoft:agency");
    const conn = t.store.toGatewayConfig().clients[0]!.connections[0]!;
    expect(conn).toMatchObject({ oauth: { app: "microsoft:agency" }, needsSignIn: true });

    await t.actions.signIn(acme.id, added.connectionId);
    const signInPage = new URL(opened[0]!);
    expect(signInPage.origin + signInPage.pathname).toBe(`${t.microsoft.login}/common/oauth2/v2.0/authorize`);
    expect(signInPage.searchParams.get("client_id")).toBe(MS_ID);
    expect(signInPage.searchParams.get("scope")).toContain("Mail.Read");
    const key = conn.kind === "local" ? conn.oauth!.key : "";
    const scope = conn.kind === "local" ? (conn.oauth!.scope ?? "") : "";
    expect(t.oauthStore.load(key)!.tokens!.access_token).toBe("ms-access-1");
    // An hour later: renewed through the same app, asking for the same permissions again.
    const renewed = await directAccessToken(t.oauthStore, key, t.apps["microsoft:agency"]!, scope, undefined, Date.now() + 3600_000);
    expect(renewed.token).toBe("ms-access-2");
    const refresh = t.microsoft.seen.at(-1)!;
    expect(refresh.path).toBe("/common/oauth2/v2.0/token");
    expect(refresh.p).toMatchObject({ grant_type: "refresh_token", client_id: MS_ID });
    expect(refresh.p.scope).toContain("Mail.Read");
    expect(refresh.p.client_secret).toBeUndefined();

    expect(t.own.list()[0]!.usedBy).toEqual(["Acme > Microsoft 365"]);
    expect(() => t.own.remove("microsoft:agency")).toThrow("Acme > Microsoft 365 signs in through this app. Remove that tool first.");
    expect(await errorOf(t.own.update("microsoft:agency", { tenant: "contoso.onmicrosoft.com" }))).toMatch(/Microsoft ties each sign-in to its directory/);
    expect(await errorOf(t.own.update("microsoft:agency", { clientId: "99999999-1234-5678-9abc-1a2b3c4d5e6f" }))).toMatch(/Microsoft ties each sign-in to its client ID/);
    await t.own.update("microsoft:agency", { name: "Agency (renamed)", tenant: "" });
    expect(t.own.list()[0]).toMatchObject({ name: "Agency (renamed)", tenant: "common" });

    t.store.removeConnection(acme.id, added.connectionId);
    t.own.remove("microsoft:agency");
    expect(t.own.list()).toEqual([]);
    expect(t.apps["microsoft:agency"]).toBeUndefined();
  });
});
