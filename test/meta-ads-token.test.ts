// Meta Ads with a pasted access token: the catalog option, the built-in tools against a
// stand-in Meta (a fake fetch), "Test connection", pausing that waits for the person's OK,
// and the warning a week before a token runs out.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConnection, findService, KEY_EXPIRES_SETTING, validateCatalog, catalog } from "../packages/catalog/src/index.js";
import { metaAds, META_ADS_ACCESS, MOST_PAUSED } from "../packages/tools/src/meta-ads.js";
import { checkMetaToken, REFUSED } from "../packages/tools/src/meta/check.js";
import { allowedTools } from "../packages/tools/src/server.js";
import { ToolError, type ToolContext } from "../packages/tools/src/types.js";
import { CatalogActionError, CatalogActions, type KeyCheckResult } from "../apps/desktop/src/main/catalog.js";
import { Approvals, approvalText } from "../apps/desktop/src/main/approvals.js";
import { KEY_EXPIRES_SETTING as SHARED_EXPIRES } from "../apps/desktop/src/shared/api.js";
import { keyExpiryWarning } from "../apps/desktop/src/shared/key-expiry.js";
import { ClientStore, secretOAuthStore } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";

const TOKEN = "EAAGm0PX4ZCpsBAKZBsecrettokenvalue1234567890abcdef";
const GRAPH = "https://fake.test/meta";

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}
type Reply = { status?: number; json?: unknown };
type Route = (req: Seen) => Reply | undefined;

function fakeMeta(route: Route, approve?: ToolContext["approve"]) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "";
    const req: Seen = { method: init.method ?? "GET", url: new URL(String(input)), headers, body };
    seen.push(req);
    const reply = route(req) ?? { status: 400, json: { error: { message: "Unsupported get request.", code: 100, error_subcode: 33 } } };
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200 });
  }) as typeof globalThis.fetch;
  const ctx: ToolContext = { token: TOKEN, fetch, base: (name) => `https://fake.test/${name}`, ...(approve ? { approve } : {}) };
  return { ctx, seen, fetch };
}

const tool = (name: string) => {
  const t = metaAds.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const path = (req: Seen) => req.url.pathname.replace(/^\/meta/, "");

async function failure(name: string, args: Record<string, unknown>, route: Route) {
  const { ctx, seen } = fakeMeta(route);
  try {
    await tool(name).run(args, ctx);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).not.toContain(TOKEN);
    return { message: (err as Error).message, seen };
  }
  throw new Error("expected a failure");
}

describe("the Meta Ads catalog entry", () => {
  const service = findService("meta_ads")!;
  const token = service.options.find((o) => o.id === "token")!;

  it("offers an access token first, recommended, next to signing in through your own Meta app", () => {
    expect(validateCatalog(catalog)).toEqual([]);
    expect(service.options.map((o) => o.id)).toEqual(["token", "signin"]);
    expect(token).toMatchObject({ label: "Use an access token", recommended: true, kind: "local", command: "ringkeeper-tools", args: ["meta-ads"], check: "meta-token" });
    expect(service.options.find((o) => o.id === "signin")?.recommended).toBeUndefined();
    const field = token.fields[0]!;
    expect(field).toMatchObject({ id: "META_ACCESS_TOKEN", secret: true, required: true });
    expect(field.help).toMatch(/System User token/);
    expect(field.help).toMatch(/ads_read/);
    expect(field.help).toMatch(/ads_management/);
    expect(field.help).toMatch(/about 60 days/);
    expect(field.where?.url).toBe("https://business.facebook.com/settings/system-users");
  });

  it("has a tick box for each of the tools' access keys: reading on, pausing off", () => {
    expect(token.access!.map((a) => a.id).sort()).toEqual(Object.keys(META_ADS_ACCESS).sort());
    expect(token.access!.find((a) => a.id === "ads_read")?.default).toBe(true);
    expect(token.access!.find((a) => a.id === "ads_pause")?.default).toBeFalsy();
  });

  it("saves the token as a secret setting, with what's ticked, and no sign-in", () => {
    const conn = buildConnection("meta_ads", "token", { META_ACCESS_TOKEN: ` ${TOKEN} ` }, "Meta Ads");
    expect(conn).toMatchObject({ kind: "local", command: "ringkeeper-tools", args: ["meta-ads"] });
    expect(conn.fields).toContainEqual({ name: "META_ACCESS_TOKEN", value: TOKEN, secret: true });
    expect(conn.fields).toContainEqual({ name: "RINGKEEPER_ACCESS", value: "ads_read", secret: false });
    expect(conn).not.toHaveProperty("auth");
    expect(conn).not.toHaveProperty("scope");
    // Not in the plain list of arguments.
    expect(JSON.stringify((conn as { args: string[] }).args)).not.toContain(TOKEN);
  });

  it("turns away something that isn't a token", () => {
    expect(() => buildConnection("meta_ads", "token", { META_ACCESS_TOKEN: "hello" })).toThrow(/doesn't look like a Meta access token/);
    expect(() => buildConnection("meta_ads", "token", {})).toThrow('Fill in "Access token".');
  });

  it("keeps the window's name for the expiry setting the same as the catalog's", () => {
    expect(SHARED_EXPIRES).toBe(KEY_EXPIRES_SETTING);
  });
});

describe("the Meta Ads tools", () => {
  it("offers pausing only when it's ticked", () => {
    expect(allowedTools(metaAds, new Set(["ads_read"])).map((t) => t.name)).toEqual(["list_ad_accounts", "list_campaigns", "list_ad_sets", "list_ads", "get_insights"]);
    expect(allowedTools(metaAds, new Set(["ads_read", "ads_pause"])).map((t) => t.name)).toContain("pause");
    // Nothing that creates, changes budgets or deletes.
    expect(metaAds.tools.map((t) => t.name).filter((n) => /create|budget|delete|update|resume|enable/.test(n))).toEqual([]);
  });

  it("lists ad accounts with the token in the header only, words for statuses, and next_page", async () => {
    const { ctx, seen } = fakeMeta(() => ({
      json: { data: [{ id: "act_1", name: "Mass Home Comfort", account_status: 1, currency: "USD" }], paging: { cursors: { after: "CURSOR2" }, next: "https://graph.facebook.com/v27.0/me/adaccounts?after=CURSOR2" } },
    }));
    const r = (await tool("list_ad_accounts").run({}, ctx)) as any;
    expect(r.data).toEqual([{ id: "act_1", name: "Mass Home Comfort", account_status: "active", currency: "USD" }]);
    expect(r.next_page).toBe("CURSOR2");
    expect(r.money).toMatch(/smallest unit/);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.url.toString()).not.toContain(TOKEN);
    expect(path(seen[0]!)).toBe("/me/adaccounts");
    expect(seen[0]!.url.searchParams.get("limit")).toBe("50");
  });

  it("reads on from next_page, and says nothing about more on the last page", async () => {
    const { ctx, seen } = fakeMeta(() => ({ json: { data: [{ id: "c9" }], paging: { cursors: { after: "END" } } } }));
    const r = (await tool("list_campaigns").run({ account_id: "123", next_page: "CURSOR2", statuses: ["ACTIVE", "PAUSED"] }, ctx)) as any;
    expect(path(seen[0]!)).toBe("/act_123/campaigns");
    expect(seen[0]!.url.searchParams.get("after")).toBe("CURSOR2");
    expect(seen[0]!.url.searchParams.get("effective_status")).toBe('["ACTIVE","PAUSED"]');
    expect(r).not.toHaveProperty("next_page");
  });

  it("lists ad sets and ads under exactly one parent", async () => {
    const { ctx, seen } = fakeMeta(() => ({ json: { data: [] } }));
    await tool("list_ad_sets").run({ campaign_id: "555" }, ctx);
    await tool("list_ads").run({ ad_set_id: "777" }, ctx);
    expect(seen.map(path)).toEqual(["/555/adsets", "/777/ads"]);
    expect((await failure("list_ads", { account_id: "act_1", campaign_id: "555" }, () => ({ json: {} }))).message).toMatch(/exactly one of account_id, campaign_id, ad_set_id/);
    expect((await failure("list_ad_sets", {}, () => ({ json: {} }))).message).toMatch(/exactly one/);
  });

  it("reports insights for a date range with breakdowns, per day", async () => {
    const { ctx, seen } = fakeMeta(() => ({ json: { data: [{ spend: "12.50", impressions: "900", date_start: "2026-11-01", date_stop: "2026-11-01", age: "25-34" }] } }));
    const r = (await tool("get_insights").run({ object_id: "act_1", since: "2026-11-01", until: "2026-11-07", breakdowns: ["age", "gender"], time_increment: "1", level: "campaign" }, ctx)) as any;
    const q = seen[0]!.url.searchParams;
    expect(path(seen[0]!)).toBe("/act_1/insights");
    expect(JSON.parse(q.get("time_range")!)).toEqual({ since: "2026-11-01", until: "2026-11-07" });
    expect(q.get("date_preset")).toBeNull();
    expect(q.get("breakdowns")).toBe("age,gender");
    expect(q.get("time_increment")).toBe("1");
    expect(q.get("level")).toBe("campaign");
    expect(q.get("fields")).toContain("spend");
    expect(q.get("fields")).toContain("date_start");
    expect(r.data[0].spend).toBe("12.50");
  });

  it("defaults to the last 30 days, and turns away half a date range", async () => {
    const { ctx, seen } = fakeMeta(() => ({ json: { data: [] } }));
    const r = (await tool("get_insights").run({ object_id: "120200000000" }, ctx)) as any;
    expect(seen[0]!.url.searchParams.get("date_preset")).toBe("last_30d");
    expect(r.note).toMatch(/no results/);
    expect((await failure("get_insights", { object_id: "act_1", since: "2026-11-01" }, () => ({ json: {} }))).message).toBe("Give both since and until, or neither.");
    expect((await failure("get_insights", { object_id: "act_1", since: "2026-11-09", until: "2026-11-01" }, () => ({ json: {} }))).message).toMatch(/on or before/);
  });

  it("says in plain words when the token expired, lacks a permission, or Meta is busy", async () => {
    const expired = await failure("list_ad_accounts", {}, () => ({ status: 400, json: { error: { message: `Error validating access token: Session has expired. ${TOKEN}`, code: 190, error_subcode: 463 } } }));
    expect(expired.message).toBe("This Meta access token has expired. Make a new one and paste it in Ringkeeper Connect with Edit on this tool.");
    const revoked = await failure("list_ad_accounts", {}, () => ({ status: 400, json: { error: { message: "Invalid OAuth access token", code: 190 } } }));
    expect(revoked.message).toMatch(/didn't accept this access token/);
    const perm = await failure("list_campaigns", { account_id: "1" }, () => ({ status: 403, json: { error: { message: "(#200) Missing Permissions", code: 200 } } }));
    expect(perm.message).toMatch(/Check that the token has ads_read/);
    const busy = await failure("list_campaigns", { account_id: "1" }, () => ({ status: 400, json: { error: { message: "User request limit reached", code: 17 } } }));
    expect(busy.message).toMatch(/limiting how many requests/);
    const missing = await failure("list_ads", { campaign_id: "9" }, () => ({ status: 400, json: { error: { message: "Object with ID '9' does not exist, cannot be loaded due to missing permissions", code: 100, error_subcode: 33 } } }));
    expect(missing.message).toMatch(/couldn't find that account, campaign or ad set/);
  });
});

describe("pausing", () => {
  const objects: Record<string, { id: string; name: string; status: string }> = {
    "111": { id: "111", name: "Winter windows", status: "ACTIVE" },
    "222": { id: "222", name: "Gutter leads", status: "ACTIVE" },
    "333": { id: "333", name: "Old promo", status: "PAUSED" },
  };
  const route: Route = (req) => {
    const id = path(req).slice(1);
    if (req.method === "GET" && objects[id]) return { json: objects[id] };
    if (req.method === "POST" && objects[id]) return { json: { success: true } };
    return undefined;
  };

  it("asks first, naming what it will pause, and pauses only on Allow", async () => {
    const asked: string[] = [];
    const { ctx, seen } = fakeMeta(route, async (m) => (asked.push(m), true));
    const r = (await tool("pause").run({ ids: ["111", "222", "333", "111"] }, ctx)) as any;
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Pause these 2 in Meta Ads\?/);
    expect(asked[0]).toContain("• Winter windows (111)");
    expect(asked[0]).toContain("• Gutter leads (222)");
    expect(asked[0]).not.toContain("Old promo");
    const posts = seen.filter((s) => s.method === "POST");
    expect(posts.map((p) => [path(p), p.url.searchParams.get("status")])).toEqual([
      ["/111", "PAUSED"],
      ["/222", "PAUSED"],
    ]);
    expect(r).toEqual({ paused: [{ id: "111", name: "Winter windows" }, { id: "222", name: "Gutter leads" }], already_paused: [{ id: "333", name: "Old promo" }] });
  });

  it("changes nothing when the person doesn't allow it", async () => {
    const { ctx, seen } = fakeMeta(route, async () => false);
    await expect(tool("pause").run({ ids: ["111"] }, ctx)).rejects.toThrow(/didn't allow pausing, so nothing was paused/);
    expect(seen.filter((s) => s.method === "POST")).toEqual([]);
  });

  it("refuses when no one can be asked, and takes at most a handful at once", async () => {
    const { ctx, seen } = fakeMeta(route);
    await expect(tool("pause").run({ ids: ["111"] }, ctx)).rejects.toThrow(/needs your OK in Ringkeeper Connect/);
    expect(seen.filter((s) => s.method === "POST")).toEqual([]);
    const many = Array.from({ length: MOST_PAUSED + 1 }, (_, i) => String(1000 + i));
    await expect(tool("pause").run({ ids: many }, fakeMeta(route, async () => true).ctx)).rejects.toThrow(/too many items/);
  });

  it("doesn't ask when everything is already paused", async () => {
    let asked = 0;
    const { ctx } = fakeMeta(route, async () => (asked++, true));
    expect(await tool("pause").run({ ids: ["333"] }, ctx)).toEqual({ paused: [], already_paused: [{ id: "333", name: "Old promo" }] });
    expect(asked).toBe(0);
  });
});

describe("Test connection for a Meta token", () => {
  const graph = (opts: { accounts?: number; debug?: unknown; me?: Reply }) =>
    fakeMeta((req) => {
      const p = path(req);
      if (p === "/me") return opts.me ?? { json: { id: "61596694862012" } };
      if (p === "/me/adaccounts") {
        const page = Number(req.url.searchParams.get("after") ?? 0);
        const total = opts.accounts ?? 1;
        const data = Array.from({ length: Math.max(0, Math.min(100, total - page)) }, (_, i) => ({ id: `act_${page + i}` }));
        return { json: { data, ...(page + 100 < total ? { paging: { next: `${GRAPH}/me/adaccounts?fields=id&limit=100&after=${page + 100}` } } : {}) } };
      }
      if (p === "/debug_token" && req.method === "POST") return { json: opts.debug ?? { data: { is_valid: true, type: "SYSTEM_USER", expires_at: 0, data_access_expires_at: 0, scopes: ["ads_read", "ads_management"] } } };
      return undefined;
    });

  it("says how many ad accounts a System User token reaches, and that it doesn't run out", async () => {
    const { fetch, seen } = graph({ accounts: 1 });
    const r = await checkMetaToken(` ${TOKEN} `, fetch, GRAPH);
    expect(r).toEqual({ ok: true, accounts: 1, expiresAt: null, canPause: true, message: "Works: 1 ad account." });
    // The token goes in a header or a request body, never an address.
    for (const s of seen) expect(s.url.toString()).not.toContain(TOKEN);
    expect(seen.find((s) => path(s) === "/debug_token")!.body).toContain(`input_token=${TOKEN}`);
    // Meta answers a POST to /debug_token as a read only when it says so.
    expect(seen.find((s) => path(s) === "/debug_token")!.body).toContain("method=get");
  });

  it("counts every page of ad accounts, and gives a personal token's end date", async () => {
    const expires = Date.parse("2027-01-15T12:00:00Z") / 1000;
    const { fetch } = graph({ accounts: 230, debug: { data: { is_valid: true, type: "USER", expires_at: expires, data_access_expires_at: expires + 86400 * 30, scopes: ["ads_read"] } } });
    const r = await checkMetaToken(TOKEN, fetch, GRAPH);
    expect(r).toMatchObject({ ok: true, accounts: 230, expiresAt: "2027-01-15T12:00:00.000Z", canPause: false });
    expect(r.message).toBe("Works: 230 ad accounts. This token stops working on January 15, 2027.");
  });

  it("says what to do when a token reaches no ad accounts", async () => {
    const r = await checkMetaToken(TOKEN, graph({ accounts: 0 }).fetch, GRAPH);
    expect(r.message).toMatch(/^Works: 0 ad accounts\. Assign the client's ad accounts/);
  });

  it("gives the same plain message for a token Meta refuses or that can't read ads", async () => {
    const refused = graph({ me: { status: 400, json: { error: { message: "Invalid OAuth access token", code: 190 } } } });
    expect(await checkMetaToken(TOKEN, refused.fetch, GRAPH)).toEqual({ ok: false, message: REFUSED });
    expect(REFUSED).toBe("Meta didn't accept this token. Check it has ads_read and hasn't expired.");
    const pagesOnly = graph({ debug: { data: { is_valid: true, expires_at: 0, scopes: ["pages_show_list"] } } });
    expect(await checkMetaToken(TOKEN, pagesOnly.fetch, GRAPH)).toEqual({ ok: false, message: REFUSED });
    const noAccounts = fakeMeta((req) => (path(req) === "/me" ? { json: { id: "1" } } : { status: 403, json: { error: { code: 200, message: "(#200) Missing Permissions" } } }));
    expect(await checkMetaToken(TOKEN, noAccounts.fetch, GRAPH)).toEqual({ ok: false, message: REFUSED });
  });

  it("says when Meta can't be reached", async () => {
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkMetaToken(TOKEN, offline, GRAPH)).toEqual({ ok: false, message: "Couldn't reach Meta. Check this computer's internet connection and try again." });
  });
});

// ---- In the app: adding, testing and replacing the token -------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
};

function app(check: (key: string) => KeyCheckResult) {
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-meta-token-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secrets = new SecretStore(join(dir, "secrets.json"), cipher);
  const store = new ClientStore(join(dir, "clients.json"), secrets);
  const checked: string[] = [];
  const restarted: string[] = [];
  const actions = new CatalogActions({
    store,
    gateway: () => ({ applyConfig: () => {}, restartConnection: (_c: string, id: string) => restarted.push(id) }) as never,
    oauthStore: secretOAuthStore(secrets),
    openExternal: () => {},
    showSignInLink: () => {},
    onChange: () => {},
    checkKey: async (_kind, key) => (checked.push(key), check(key)),
  });
  const acme = store.addClient("Acme");
  const saved = () => store.toGatewayConfig().clients[0]!.connections[0]!;
  return { dir, store, actions, acme, checked, restarted, saved };
}

const works = (expiresAt: string | null = null): KeyCheckResult => ({ ok: true, message: "Works: 1 ad account.", expiresAt, reached: true });
const refused: KeyCheckResult = { ok: false, message: REFUSED, expiresAt: null, reached: true };

describe("adding Meta Ads with a token in the app", () => {
  it("checks the token first and keeps it encrypted, with when it runs out", async () => {
    const t = app(() => works("2027-01-15T12:00:00.000Z"));
    const added = await t.actions.addChecked(t.acme.id, "meta_ads", "token", { META_ACCESS_TOKEN: TOKEN }, "Meta Ads", ["ads_read", "ads_pause"]);
    expect(added.needsSignIn).toBe(false);
    expect(t.checked).toEqual([TOKEN]);
    const conn = t.saved();
    expect(conn.kind === "local" && conn.env).toMatchObject({ META_ACCESS_TOKEN: TOKEN, RINGKEEPER_ACCESS: "ads_read,ads_pause", [KEY_EXPIRES_SETTING]: "2027-01-15T12:00:00.000Z" });
    // Only encrypted on disk: never in the plain clients file.
    expect(fs.readFileSync(join(t.dir, "clients.json"), "utf8")).not.toContain(TOKEN);
    expect(fs.readFileSync(join(t.dir, "secrets.json"), "utf8")).not.toContain(TOKEN);
  });

  it("doesn't add a token Meta refused, and says why", async () => {
    const t = app(() => refused);
    await expect(t.actions.addChecked(t.acme.id, "meta_ads", "token", { META_ACCESS_TOKEN: TOKEN }, "Meta Ads")).rejects.toThrow(REFUSED);
    expect(t.store.list()[0]!.connections).toEqual([]);
  });

  it("adds it unchecked when Meta can't be reached", async () => {
    const t = app(() => ({ ok: false, message: "Couldn't reach Meta.", expiresAt: null, reached: false }));
    await t.actions.addChecked(t.acme.id, "meta_ads", "token", { META_ACCESS_TOKEN: TOKEN }, "Meta Ads");
    const conn = t.saved();
    expect(conn.kind === "local" && conn.env?.[KEY_EXPIRES_SETTING]).toBeFalsy();
  });

  it("tests a typed token, or the saved one when the field is left empty", async () => {
    const t = app(() => works());
    expect(await t.actions.testKey("meta_ads", "token", { META_ACCESS_TOKEN: TOKEN })).toMatchObject({ ok: true, message: "Works: 1 ad account." });
    expect((await t.actions.testKey("meta_ads", "token", {})).message).toBe("Paste the access token first.");
    expect((await t.actions.testKey("meta_ads", "token", { META_ACCESS_TOKEN: "short" })).message).toMatch(/doesn't look like a Meta access token/);
    const { connectionId } = await t.actions.addChecked(t.acme.id, "meta_ads", "token", { META_ACCESS_TOKEN: TOKEN }, "Meta Ads");
    t.checked.length = 0;
    await t.actions.testKey("", "", {}, { clientId: t.acme.id, connectionId });
    expect(t.checked).toEqual([TOKEN]);
    await expect(t.actions.testKey("google", "signin", {})).rejects.toBeInstanceOf(CatalogActionError);
  });

  it("replaces the token with Edit, checking the new one and its end date", async () => {
    let next: KeyCheckResult = works("2026-11-25T00:00:00.000Z");
    const t = app(() => next);
    const { connectionId } = await t.actions.addChecked(t.acme.id, "meta_ads", "token", { META_ACCESS_TOKEN: TOKEN }, "Meta Ads");
    const NEW = `${TOKEN}NEW`;

    next = refused;
    await expect(t.actions.editBuiltInChecked(t.acme.id, connectionId, "Meta Ads", undefined, { META_ACCESS_TOKEN: NEW })).rejects.toThrow(REFUSED);
    let conn = t.saved();
    expect(conn.kind === "local" && conn.env?.META_ACCESS_TOKEN).toBe(TOKEN);

    next = works(null);
    await t.actions.editBuiltInChecked(t.acme.id, connectionId, "Meta Ads", ["ads_read", "ads_pause"], { META_ACCESS_TOKEN: NEW });
    conn = t.saved();
    expect(conn.kind === "local" && conn.env).toMatchObject({ META_ACCESS_TOKEN: NEW, RINGKEEPER_ACCESS: "ads_read,ads_pause" });
    // A System User token doesn't run out: the old end date is gone.
    expect(conn.kind === "local" && conn.env?.[KEY_EXPIRES_SETTING]).toBeFalsy();
    expect(t.restarted).toContain(connectionId);

    // Saving without a new token keeps the saved one, unchecked.
    t.checked.length = 0;
    await t.actions.editBuiltInChecked(t.acme.id, connectionId, "Acme ads", ["ads_read"], { META_ACCESS_TOKEN: "  " });
    conn = t.saved();
    expect(conn.kind === "local" && conn.env?.META_ACCESS_TOKEN).toBe(NEW);
    expect(t.checked).toEqual([]);
  });
});

describe("the warning before a token runs out", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");
  const conn = (when?: string) => ({ fields: when ? [{ name: KEY_EXPIRES_SETTING, value: when }] : [] });

  it("says nothing more than a week ahead, or for a token that doesn't run out", () => {
    expect(keyExpiryWarning(conn("2026-11-27T12:00:00Z"), now)).toBeNull();
    expect(keyExpiryWarning(conn(), now)).toBeNull();
    expect(keyExpiryWarning(conn("not a date"), now)).toBeNull();
  });

  it("warns within a week, and after", () => {
    expect(keyExpiryWarning(conn("2026-11-25T12:00:00Z"), now)).toBe("This access token stops working on November 25. Paste a new one with Edit before then.");
    expect(keyExpiryWarning(conn("2026-11-18T12:00:00Z"), now)).toBe("This access token stopped working on November 18. Paste a new one with Edit.");
  });
});

describe("asking the person to allow it", () => {
  const q = { clientName: "Acme", connectionName: "Meta Ads", message: "Pause this in Meta Ads?\n\n• Winter windows (111)" };

  it("shows the client, what will change, and Allow / Don't allow", () => {
    expect(approvalText(q)).toEqual({
      message: "Acme: Pause this in Meta Ads?",
      detail: "• Winter windows (111)\n\nYour AI app asked for this through Meta Ads. Nothing changes unless you click Allow.",
      buttons: ["Allow", "Don't allow"],
    });
  });

  it("allows only on Allow, and asks one question at a time", async () => {
    const shown: string[] = [];
    let open = 0;
    let most = 0;
    const approvals = new Approvals({
      async ask(text) {
        open++;
        most = Math.max(most, open);
        shown.push(text.message);
        await new Promise((r) => setTimeout(r, 5));
        open--;
        return shown.length === 1 ? 0 : 1;
      },
    });
    const [first, second] = await Promise.all([approvals.approve(q), approvals.approve({ ...q, clientName: "Globex" })]);
    expect([first, second]).toEqual([true, false]);
    expect(most).toBe(1);
    expect(shown).toEqual(["Acme: Pause this in Meta Ads?", "Globex: Pause this in Meta Ads?"]);
  });

  it("counts no answer in time as Don't allow, and closes the question", async () => {
    let closed = false;
    const approvals = new Approvals(
      {
        ask: (_text, signal) =>
          new Promise<number>((resolve) => {
            signal.addEventListener("abort", () => {
              closed = true;
              resolve(1);
            });
          }),
      },
      20,
    );
    expect(await approvals.approve(q)).toBe(false);
    expect(closed).toBe(true);
    const broken = new Approvals({ ask: async () => Promise.reject(new Error("no window")) });
    expect(await broken.approve(q)).toBe(false);
  });
});
