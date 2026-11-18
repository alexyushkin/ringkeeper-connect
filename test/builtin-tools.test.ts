// Ringkeeper Connect's own tools (a Google account): the tick boxes, the sign-in
// straight with the vendor through our registered app, and renewing it.
import fs from "node:fs";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCESS_SETTING, CatalogInputError, buildConnection, findService, validateCatalog, type Catalog } from "../packages/catalog/src/index.js";
import { CatalogActions } from "../apps/desktop/src/main/catalog.js";
import { registeredApps } from "../apps/desktop/src/main/registered-apps.js";
import { NeedsSignInError, directAccessToken, signInDirect, type OAuthState, type OAuthStateStore, type RegisteredApp } from "../packages/gateway/src/oauth.js";
import { ClientStore, secretOAuthStore } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";
import { allowedTools } from "../packages/tools/src/server.js";

const G = "https://www.googleapis.com/auth/";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir() {
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-builtin-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
};
function memoryStore(): OAuthStateStore & { states: Map<string, OAuthState> } {
  const states = new Map<string, OAuthState>();
  return { states, load: (k) => states.get(k), save: (k, s) => void states.set(k, s) };
}

/** A stand-in for Google's sign-in: checks PKCE, hands out tokens, renews them (or refuses to). */
async function fakeVendor() {
  const seen: Array<Record<string, string>> = [];
  let challenge = "";
  let refusal: string | undefined;
  let n = 0;
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
      if (refusal) return reply(400, { error: refusal });
      if (p.grant_type === "authorization_code") {
        if (p.code !== "the-code" || createHash("sha256").update(p.code_verifier ?? "").digest("base64url") !== challenge) return reply(400, { error: "invalid_grant" });
        return reply(200, { access_token: `access-${++n}`, refresh_token: "refresh-1", expires_in: 3599, token_type: "Bearer" });
      }
      if (p.grant_type === "refresh_token" && p.refresh_token === "refresh-1") return reply(200, { access_token: `access-${++n}`, expires_in: 3599, token_type: "Bearer" });
      reply(400, { error: "invalid_request" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app: RegisteredApp = {
    ...registeredApps({ RINGKEEPER_GOOGLE_CLIENT_ID: "g-id", RINGKEEPER_GOOGLE_CLIENT_SECRET: "g-secret" }, {}).google!,
    authorizationEndpoint: `${base}/auth`,
    tokenEndpoint: `${base}/token`,
  };
  /** Plays the browser: reads the sign-in address, "allows", and comes back with a code. */
  const browser = (opened: string[]) => (url: string) => {
    opened.push(url);
    const u = new URL(url);
    challenge = u.searchParams.get("code_challenge") ?? "";
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "the-code");
    back.searchParams.set("state", u.searchParams.get("state")!);
    void fetch(back).then((r) => r.text());
  };
  return { app, seen, browser, refuse: (code: string) => (refusal = code) };
}

describe("the Google account tool in the catalog", () => {
  const option = () => findService("google")!.options[0]!;

  it("runs our own tools program, signs in through our Google app, and offers Ringkeeper's 18 permissions", () => {
    const o = option();
    expect(o).toMatchObject({ kind: "local", command: "ringkeeper-tools", args: ["google"], auth: "oauth", app: "google", scope: "openid email" });
    expect(o.access!.map((a) => a.id)).toEqual([
      "mail_read", "mail_drafts", "mail_send", "mail_trash", "drive_files", "drive_read_all",
      "calendar_read", "calendar_write", "sheets_read", "sheets_write", "docs_read", "docs_write",
      "search_console_read", "analytics_read", "youtube_read", "youtube_upload", "youtube_manage", "youtube_analytics",
    ]);
    for (const a of o.access!) expect(a.scope, a.id).toMatch(/^https:\/\/www\.googleapis\.com\/auth\/[a-z.-]+$/);
  });

  it("asks only for what's ticked (the defaults when nothing was sent), plus who the account is", () => {
    const byDefault = buildConnection("google", "signin", {}, "Acme Google");
    expect(byDefault).toMatchObject({ kind: "local", name: "Acme Google", command: "ringkeeper-tools", args: ["google"], auth: "oauth", oauthApp: "google" });
    expect(byDefault.kind === "local" && byDefault.fields).toEqual([{ name: ACCESS_SETTING, value: "mail_read,mail_drafts,drive_files,calendar_read,sheets_read,docs_read", secret: false }]);

    const chosen = buildConnection("google", "signin", {}, undefined, ["sheets_write", "mail_send"]);
    // In the catalog's order, whatever order they were ticked in.
    expect(chosen.kind === "local" && chosen.fields[0]!.value).toBe("mail_send,sheets_write");
    expect(chosen.scope).toBe(`openid email ${G}gmail.send ${G}spreadsheets`);
  });

  it("refuses nothing ticked, or a permission it doesn't offer", () => {
    expect(() => buildConnection("google", "signin", {}, undefined, [])).toThrow(new CatalogInputError("Tick at least one thing the AI may do."));
    expect(() => buildConnection("google", "signin", {}, undefined, ["mail_read", "everything"])).toThrow(/isn't offered anymore/);
  });

  it("validation keeps tick boxes to our own tools, and a program's sign-in to a registered app", () => {
    const bad: Catalog = {
      version: 1,
      checked: "x",
      services: [
        {
          id: "x",
          name: "X",
          group: "Other",
          description: "",
          options: [
            { id: "a", label: "a", kind: "local", command: "npx", args: ["x@1"], auth: "oauth", fields: [] },
            { id: "b", label: "b", kind: "remote", url: "https://x", auth: "oauth", fields: [], access: [{ id: "r", label: "Read", scope: "read", default: true }] },
            { id: "c", label: "c", kind: "local", command: "ringkeeper-tools", args: ["x"], auth: "oauth", app: "google", fields: [], access: [{ id: "r", label: "Read", scope: "read" }] },
          ],
        },
      ],
    };
    expect(validateCatalog(bad)).toEqual([
      "x/a: a program's sign-in needs a registered app",
      "x/b: tick boxes are only for Ringkeeper Connect's own tools",
      "x/c: tick at least one access to begin with",
    ]);
  });
});

describe("signing in straight with Google through our app", () => {
  it("signs in with PKCE, asks for a lasting sign-in on the account the user picks, and saves the tokens", async () => {
    const vendor = await fakeVendor();
    const store = memoryStore();
    const opened: string[] = [];
    await signInDirect({ label: "Google account for Acme", store, key: "k", openBrowser: vendor.browser(opened), app: vendor.app, scope: `openid email ${G}gmail.readonly`, timeoutMs: 10_000 });

    const asked = new URL(opened[0]!).searchParams;
    expect(Object.fromEntries(asked)).toMatchObject({
      client_id: "g-id",
      response_type: "code",
      scope: `openid email ${G}gmail.readonly`,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent select_account",
    });
    expect(asked.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // The desktop app's "secret" goes to the token request, never into the browser.
    expect(opened[0]).not.toContain("g-secret");
    expect(vendor.seen[0]).toMatchObject({ grant_type: "authorization_code", client_id: "g-id", client_secret: "g-secret" });
    expect(store.states.get("k")!.tokens).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
  });

  it("uses the saved token while it lasts, renews it near the end without repeating the permissions, and asks for a new sign-in once Google withdraws it", async () => {
    const vendor = await fakeVendor();
    const store = memoryStore();
    store.save("k", { tokens: { access_token: "access-0", refresh_token: "refresh-1", expires_in: 3600, token_type: "Bearer" }, obtainedAt: 1_000_000 });

    expect(await directAccessToken(store, "k", vendor.app, "openid email", undefined, 1_000_000 + 60_000)).toEqual({ token: "access-0", expiresAt: 1_000_000 + 3_600_000 });
    expect(vendor.seen).toEqual([]);

    const now = 1_000_000 + 3_600_000 - 60_000;
    const fresh = await directAccessToken(store, "k", vendor.app, "openid email", undefined, now);
    expect(fresh).toEqual({ token: "access-1", expiresAt: now + 3_599_000 });
    expect(vendor.seen[0]).toEqual({ client_id: "g-id", client_secret: "g-secret", grant_type: "refresh_token", refresh_token: "refresh-1" });
    // Google doesn't send a new refresh token; the old one is kept.
    expect(store.states.get("k")!.tokens).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });

    vendor.refuse("invalid_grant");
    await expect(directAccessToken(store, "k", vendor.app, "openid email", undefined, now + 3_600_000)).rejects.toBeInstanceOf(NeedsSignInError);
    await expect(directAccessToken(memoryStore(), "nobody", vendor.app, undefined)).rejects.toBeInstanceOf(NeedsSignInError);
  });

  it("Microsoft repeats the permissions when renewing", async () => {
    const vendor = await fakeVendor();
    const ms = { ...registeredApps({ RINGKEEPER_MICROSOFT_CLIENT_ID: "ms-id" }, {}).microsoft!, tokenEndpoint: vendor.app.tokenEndpoint };
    const store = memoryStore();
    store.save("k", { tokens: { access_token: "a", refresh_token: "refresh-1", expires_in: 60, token_type: "Bearer" }, obtainedAt: 0 });
    await directAccessToken(store, "k", ms, "offline_access Mail.Read", undefined, 10_000);
    expect(vendor.seen[0]).toMatchObject({ grant_type: "refresh_token", scope: "offline_access Mail.Read" });
  });
});

describe("adding a Google account for a client", () => {
  function setup(apps: Record<string, RegisteredApp>, openExternal: (url: string) => void = () => {}) {
    const dir = tempDir();
    const secrets = new SecretStore(join(dir, "secrets.json"), cipher);
    const store = new ClientStore(join(dir, "clients.json"), secrets);
    // As the app does: sign-ins are kept with the other secrets.
    const oauthStore = secretOAuthStore(secrets);
    const restarted: string[] = [];
    const gateway = { applyConfig: () => {}, restartConnection: (_c: string, id: string) => restarted.push(id) };
    const actions = new CatalogActions({
      store,
      gateway: () => gateway as never,
      oauthStore,
      openExternal,
      showSignInLink: () => {},
      onChange: () => {},
      apps,
    });
    return { store, actions, restarted, oauthStore };
  }

  it("isn't offered by a build without our Google app", () => {
    const { actions } = setup({});
    expect(actions.services().find((s) => s.id === "google")!.options[0]).toMatchObject({ unavailable: true });
  });

  it("adds the connection, signs in through our app, and then runs with a fresh token", async () => {
    const vendor = await fakeVendor();
    // The sign-in goes to the vendor through the browser; with the fake vendor, the "browser" answers by itself.
    const opened: string[] = [];
    const { store, actions, restarted, oauthStore } = setup({ google: vendor.app }, vendor.browser(opened));
    const acme = store.addClient("Acme");
    const added = actions.add(acme.id, "google", "signin", {}, "Google", ["mail_read", "calendar_write"]);
    expect(added.needsSignIn).toBe(true);
    const before = store.toGatewayConfig().clients[0]!.connections[0]!;
    expect(before).toMatchObject({ kind: "local", command: "ringkeeper-tools", args: ["google"], needsSignIn: true, oauth: { app: "google", scope: `openid email ${G}gmail.readonly ${G}calendar.events` } });
    expect(before.kind === "local" && before.env).toEqual({ [ACCESS_SETTING]: "mail_read,calendar_write" });

    await actions.signIn(acme.id, added.connectionId);
    expect(new URL(opened[0]!).searchParams.get("scope")).toBe(`openid email ${G}gmail.readonly ${G}calendar.events`);
    expect(restarted).toEqual([added.connectionId]);
    expect(store.list()[0]!.connections[0]).toMatchObject({ signedIn: true });
    expect(store.toGatewayConfig().clients[0]!.connections[0]).toMatchObject({ needsSignIn: false });
    const after = store.toGatewayConfig().clients[0]!.connections[0]!;
    expect(after.kind === "local" && after.oauth && oauthStore.load(after.oauth.key)?.tokens?.access_token).toBe("access-1");
  });

  it("the tools program offers a tool when any one of the permissions that allow it was ticked", () => {
    const service = {
      id: "t",
      name: "T",
      tools: [
        { name: "send_mail", description: "", inputSchema: { type: "object" as const, properties: {} }, needs: ["mail_send", "mail_drafts"], run: async () => "" },
        { name: "read_mail", description: "", inputSchema: { type: "object" as const, properties: {} }, needs: ["mail_read"], run: async () => "" },
      ],
    };
    expect(allowedTools(service, new Set(["mail_drafts"])).map((t) => t.name)).toEqual(["send_mail"]);
    expect(allowedTools(service, new Set(["mail_read"])).map((t) => t.name)).toEqual(["read_mail"]);
    expect(allowedTools(service, new Set())).toEqual([]);
  });
});
