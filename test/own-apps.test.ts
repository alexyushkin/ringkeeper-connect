// "Use your own Google app": a Google app in the agency's own Google Cloud project, kept
// with its secret encrypted, checked with Google before it's saved, offered when a Google
// account is added, and used for that account's sign-in and renewals.
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

async function setup(ours: Record<string, RegisteredApp> = {}, openExternal: (url: string) => void = () => {}) {
  const google = await fakeGoogle();
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-ownapps-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secrets = new SecretStore(join(dir, "secrets.json"), cipher);
  const store = new ClientStore(join(dir, "clients.json"), secrets);
  const apps: Record<string, RegisteredApp> = { ...ours };
  const restarted: string[] = [];
  const own = new OwnApps({ store, secrets, apps, endpoints: google.endpoints, restart: (_c, id) => restarted.push(id) });
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
  return { dir, google, secrets, store, apps, own, actions, oauthStore, restarted };
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
