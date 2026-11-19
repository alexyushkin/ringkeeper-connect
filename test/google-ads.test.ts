// Google Ads in the Google account connection: the tick boxes, the tools against a stand-in
// Google Ads API (a fake fetch), the manager header, Google's refusals in plain words, pausing
// with the person's OK, and the sign-in that asks only for Google Ads when it's ticked later.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConnection, findService } from "../packages/catalog/src/index.js";
import { google, GOOGLE_ACCESS } from "../packages/tools/src/google.js";
import { ADS_API_VERSION, ADS_NOT_APPROVED, ADS_NOT_TICKED, MOST_ADS_PAUSED, adsErrorCodes } from "../packages/tools/src/google/ads.js";
import { BASES } from "../packages/tools/src/google/http.js";
import { allowedTools } from "../packages/tools/src/server.js";
import { ToolError, type ToolContext } from "../packages/tools/src/types.js";
import { CatalogActions, incrementalScope } from "../apps/desktop/src/main/catalog.js";
import { registeredApps } from "../apps/desktop/src/main/registered-apps.js";
import { GOOGLE_APIS } from "../apps/desktop/src/shared/api.js";
import { ClientStore, oauthKey, secretOAuthStore } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";

const TOKEN = "ya29.a0AfB_secret-google-token";
const ADWORDS = "https://www.googleapis.com/auth/adwords";

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}
type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
type Route = (req: Seen) => Reply | undefined;

function fakeAds(route: Route, approve?: ToolContext["approve"]) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const req: Seen = { method: init.method ?? "GET", url: new URL(String(input)), headers, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    seen.push(req);
    const reply = route(req) ?? { status: 404, json: { error: { code: 404, message: "Not found", status: "NOT_FOUND" } } };
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof globalThis.fetch;
  const ctx: ToolContext = { token: TOKEN, fetch, base: (name) => `https://fake.test/${name}`, ...(approve ? { approve } : {}) };
  return { ctx, seen };
}

const tool = (name: string) => google.tools.find((t) => t.name === name)!;
const path = (req: Seen) => req.url.pathname.replace(/^\/googleads/, "");

/** Google Ads' own error shape: GoogleAdsFailure in the details. */
const adsError = (status: number, code: Record<string, string>, message = "Request failed.") => ({
  status,
  json: {
    error: {
      code: status,
      message,
      status: status === 403 ? "PERMISSION_DENIED" : "INVALID_ARGUMENT",
      details: [{ "@type": `type.googleapis.com/google.ads.googleads.${ADS_API_VERSION}.errors.GoogleAdsFailure`, errors: [{ errorCode: code, message }] }],
    },
  },
});

async function failure(name: string, args: Record<string, unknown>, route: Route) {
  const { ctx } = fakeAds(route);
  try {
    await tool(name).run(args, ctx);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).not.toContain(TOKEN);
    return (err as Error).message;
  }
  throw new Error("expected a failure");
}

describe("Google Ads in the Google account", () => {
  it("is two tick boxes with Google's one Ads permission, off to begin with", () => {
    const access = findService("google")!.options[0]!.access!;
    expect(access.filter((a) => a.id.startsWith("ads_"))).toEqual([
      expect.objectContaining({ id: "ads_read", label: "Google Ads: reports", scope: ADWORDS }),
      expect.objectContaining({ id: "ads_pause", label: "Google Ads: pause campaigns", scope: ADWORDS }),
    ]);
    expect(access.filter((a) => a.id.startsWith("ads_") && a.default)).toEqual([]);
    expect(GOOGLE_ACCESS.ads_read.scope).toBe(ADWORDS);
    // Both ticked: the permission is asked for once.
    const conn = buildConnection("google", "signin", {}, undefined, ["ads_read", "ads_pause"]);
    expect(conn.scope).toBe(`openid email ${ADWORDS}`);
  });

  it("uses the current API version, with no developer token", () => {
    expect(BASES.googleads).toBe(`https://googleads.googleapis.com/${ADS_API_VERSION}`);
    expect(ADS_API_VERSION).toBe("v26");
  });

  it("offers reports with either tick box, and pausing only with its own", () => {
    const names = (keys: string[]) => allowedTools(google, new Set(keys)).map((t) => t.name).filter((n) => n.includes("ads"));
    expect(names(["ads_read"])).toEqual(["list_ads_accounts", "ads_report"]);
    expect(names(["ads_pause"])).toEqual(["list_ads_accounts", "ads_report", "ads_pause_campaigns"]);
    expect(names(["mail_read"])).toEqual([]);
  });

  it("says that ticking it later is an Edit, not removing the tool", () => {
    for (const id of ["google", "microsoft"]) {
      const notes = findService(id)!.notes!.join(" ");
      expect(notes, id).not.toMatch(/remove the tool and add it again/);
      expect(notes, id).toMatch(/use Edit on the tool/);
    }
  });

  it("is in the changelog, and this version has a section of its own", () => {
    const version = JSON.parse(fs.readFileSync("apps/desktop/package.json", "utf8")).version as string;
    const log = fs.readFileSync("CHANGELOG.md", "utf8").split(String.fromCharCode(13)).join("");
    const section = (v: string) => log.split(`\n## ${v}\n`)[1]?.split("\n## ")[0] ?? "";
    expect(section(version).trim().length).toBeGreaterThan(20);
    expect(section("0.2.0-beta.16")).toMatch(/Google Ads/);
    expect(section("0.2.0-beta.16")).toMatch(/Meta Ads with an access token/);
  });

  it("is in the registration doc and the own-app steps", () => {
    const doc = fs.readFileSync("docs/registered-apps.md", "utf8");
    expect(doc).toContain(ADWORDS);
    expect(doc).toMatch(/gcloud services enable .*googleads\.googleapis\.com/);
    expect(GOOGLE_APIS).toContainEqual(["Google Ads", "googleads.googleapis.com"]);
  });
});

describe("the Google Ads tools", () => {
  it("lists the reachable accounts by customer ID", async () => {
    const { ctx, seen } = fakeAds(() => ({ json: { resourceNames: ["customers/1234567890", "customers/9876543210"] } }));
    const r = (await tool("list_ads_accounts").run({}, ctx)) as any;
    expect(r.customer_ids).toEqual(["1234567890", "9876543210"]);
    expect(path(seen[0]!)).toBe("/customers:listAccessibleCustomers");
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // No developer token.
    expect(Object.keys(seen[0]!.headers)).not.toContain("developer-token");
  });

  it("runs a report, and reads on with the page token", async () => {
    const pages: Record<string, unknown> = {
      first: { results: [{ campaign: { id: "1", name: "Search - Brand" }, metrics: { clicks: "12" } }], nextPageToken: "PAGE2" },
      PAGE2: { results: [{ campaign: { id: "2", name: "Search - Leads" }, metrics: { clicks: "7" } }] },
    };
    const { ctx, seen } = fakeAds((req) => ({ json: pages[req.body?.pageToken ?? "first"] }));
    const query = "SELECT campaign.id, campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_30_DAYS";
    const first = (await tool("ads_report").run({ customer_id: "123-456-7890", query }, ctx)) as any;
    expect(path(seen[0]!)).toBe("/customers/1234567890/googleAds:search");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toEqual({ query });
    expect(first.rows).toHaveLength(1);
    expect(first.next_page).toBe("PAGE2");

    const second = (await tool("ads_report").run({ customer_id: "1234567890", query, next_page: first.next_page }, ctx)) as any;
    expect(seen[1]!.body).toEqual({ query, pageToken: "PAGE2" });
    expect(second.rows[0].campaign.name).toBe("Search - Leads");
    expect(second).not.toHaveProperty("next_page");
  });

  it("sends a manager's ID as login-customer-id, and only when given", async () => {
    const { ctx, seen } = fakeAds(() => ({ json: { results: [] } }));
    await tool("ads_report").run({ customer_id: "1234567890", manager_id: "111-222-3333", query: "SELECT customer.id FROM customer" }, ctx);
    await tool("ads_report").run({ customer_id: "1234567890", query: "SELECT customer.id FROM customer" }, ctx);
    expect(seen[0]!.headers["login-customer-id"]).toBe("1112223333");
    expect(seen[1]!.headers).not.toHaveProperty("login-customer-id");
  });

  it("turns away a customer ID that isn't 10 digits", async () => {
    const message = await failure("ads_report", { customer_id: "12345", query: "SELECT customer.id FROM customer" }, () => ({ json: {} }));
    expect(message).toMatch(/customer_id isn't in the expected form/);
  });

  it("says plainly when Google hasn't approved the app for live accounts", async () => {
    const query = { customer_id: "1234567890", query: "SELECT customer.id FROM customer" };
    expect(await failure("ads_report", query, () => adsError(403, { authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" }))).toBe(ADS_NOT_APPROVED);
    expect(await failure("ads_report", query, () => adsError(403, { authorizationError: "ACTION_NOT_PERMITTED" }))).toBe(ADS_NOT_APPROVED);
    expect(ADS_NOT_APPROVED).toBe(
      "Google hasn't approved this Google app for live ad accounts yet. In Google Cloud, open the Google Ads API page for the app's project and apply for Explorer access.",
    );
  });

  it("says to tick Google Ads when the sign-in doesn't include it", async () => {
    const scopeError = {
      status: 403,
      json: { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
      headers: { "www-authenticate": 'Bearer error="insufficient_scope"' },
    };
    expect(await failure("list_ads_accounts", {}, () => scopeError)).toBe(ADS_NOT_TICKED);
    expect(ADS_NOT_TICKED).toBe("Google Ads isn't turned on for this account. Edit the connection and tick Google Ads.");
  });

  it("explains a manager account, a bad query, and leaves other refusals to the usual words", async () => {
    const q = { customer_id: "1234567890", query: "SELECT campaign.nope FROM campaign" };
    expect(await failure("ads_report", q, () => adsError(403, { authorizationError: "USER_PERMISSION_DENIED" }))).toMatch(/give the manager's ID/);
    expect(await failure("ads_report", q, () => adsError(400, { queryError: "UNRECOGNIZED_FIELD" }, "Unrecognized field in the query: 'campaign.nope'."))).toBe(
      "Google Ads didn't accept that query: Unrecognized field in the query: 'campaign.nope'.",
    );
    expect(await failure("ads_report", q, () => ({ status: 429, json: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Too many requests" } } }))).toMatch(/limiting how many requests/);
    expect(adsErrorCodes(adsError(403, { authorizationError: "ACTION_NOT_PERMITTED" }).json)).toEqual(["ACTION_NOT_PERMITTED"]);
  });
});

describe("pausing Google Ads campaigns", () => {
  const campaigns: Record<string, { id: string; name: string; status: string }> = {
    "11": { id: "11", name: "Search - Brand", status: "ENABLED" },
    "22": { id: "22", name: "Search - Leads", status: "ENABLED" },
    "33": { id: "33", name: "Old promo", status: "PAUSED" },
  };
  const route: Route = (req) => {
    if (path(req).endsWith("/googleAds:search")) {
      const ids = String(req.body.query).match(/IN \(([^)]*)\)/)![1]!.split(",").map((s) => s.trim());
      return { json: { results: ids.filter((id) => campaigns[id]).map((id) => ({ campaign: campaigns[id], customer: { descriptiveName: "Acme Windows" } })) } };
    }
    if (path(req).endsWith("/campaigns:mutate")) return { json: { results: [] } };
    return undefined;
  };

  it("asks first, naming the account and campaigns, and pauses only on Allow, through the manager", async () => {
    const asked: string[] = [];
    const { ctx, seen } = fakeAds(route, async (m) => (asked.push(m), true));
    const r = (await tool("ads_pause_campaigns").run({ customer_id: "1234567890", manager_id: "1112223333", campaign_ids: ["11", "22", "33"] }, ctx)) as any;
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Pause these 2 campaigns in Google Ads \(Acme Windows\)\?/);
    expect(asked[0]).toContain("• Search - Brand (11)");
    expect(asked[0]).not.toContain("Old promo");
    const mutate = seen.find((s) => path(s).endsWith("/campaigns:mutate"))!;
    expect(path(mutate)).toBe("/customers/1234567890/campaigns:mutate");
    expect(mutate.headers["login-customer-id"]).toBe("1112223333");
    expect(mutate.body).toEqual({
      operations: [
        { updateMask: "status", update: { resourceName: "customers/1234567890/campaigns/11", status: "PAUSED" } },
        { updateMask: "status", update: { resourceName: "customers/1234567890/campaigns/22", status: "PAUSED" } },
      ],
    });
    expect(r.paused.map((c: { id: string }) => c.id)).toEqual(["11", "22"]);
    expect(r.already_paused).toEqual([{ id: "33", name: "Old promo" }]);
  });

  it("changes nothing when the person doesn't allow it, or no one can be asked", async () => {
    const declined = fakeAds(route, async () => false);
    await expect(tool("ads_pause_campaigns").run({ customer_id: "1234567890", campaign_ids: ["11"] }, declined.ctx)).rejects.toThrow(/didn't allow pausing/);
    expect(declined.seen.some((s) => path(s).endsWith(":mutate"))).toBe(false);
    const nobody = fakeAds(route);
    await expect(tool("ads_pause_campaigns").run({ customer_id: "1234567890", campaign_ids: ["11"] }, nobody.ctx)).rejects.toThrow(/needs your OK/);
    expect(nobody.seen.some((s) => path(s).endsWith(":mutate"))).toBe(false);
  });

  it("refuses a campaign that isn't in the account, and more than a handful at once", async () => {
    const { ctx, seen } = fakeAds(route, async () => true);
    await expect(tool("ads_pause_campaigns").run({ customer_id: "1234567890", campaign_ids: ["11", "99"] }, ctx)).rejects.toThrow("Google Ads has no campaign 99 in that ad account. Nothing was paused.");
    expect(seen.some((s) => path(s).endsWith(":mutate"))).toBe(false);
    const many = Array.from({ length: MOST_ADS_PAUSED + 1 }, (_, i) => String(100 + i));
    await expect(tool("ads_pause_campaigns").run({ customer_id: "1234567890", campaign_ids: many }, ctx)).rejects.toThrow(/too many items/);
  });
});

// ---- Ticking Google Ads on an account that's already signed in ------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
};

function setup() {
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-google-ads-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secrets = new SecretStore(join(dir, "secrets.json"), cipher);
  const store = new ClientStore(join(dir, "clients.json"), secrets);
  const opened: string[] = [];
  const actions = new CatalogActions({
    store,
    gateway: () => ({ applyConfig: () => {}, restartConnection: () => {} }) as never,
    oauthStore: secretOAuthStore(secrets),
    openExternal: (url) => opened.push(url),
    showSignInLink: () => {},
    onChange: () => {},
    apps: registeredApps({ RINGKEEPER_GOOGLE_CLIENT_ID: "ours.apps.googleusercontent.com" }, {}),
  });
  const acme = store.addClient("Acme");
  const { connectionId } = actions.add(acme.id, "google", "signin", {}, "Google", ["mail_read", "calendar_read"]);
  secrets.set(oauthKey(acme.id, connectionId), JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } }));
  /** Starts a sign-in, returns the address the browser was sent to, and stops waiting. */
  async function signInAddress(): Promise<URL> {
    const done = actions.signIn(acme.id, connectionId).catch(() => {});
    for (let i = 0; i < 100 && !opened.length; i++) await new Promise((r) => setTimeout(r, 10));
    actions.cancelSignIn();
    await done;
    return new URL(opened.splice(0)[0]!);
  }
  return { actions, acme, connectionId, signInAddress, store };
}

describe("ticking Google Ads later", () => {
  it("works out just the new permissions", () => {
    const G = "https://www.googleapis.com/auth/";
    expect(incrementalScope(`openid email ${G}gmail.readonly`, `openid email ${G}gmail.readonly ${ADWORDS}`)).toBe(`openid email ${ADWORDS}`);
    expect(incrementalScope(`openid email ${ADWORDS}`, `openid email ${ADWORDS}`)).toBeUndefined();
  });

  it("signs in once more for just Google Ads, keeping what was allowed before", async () => {
    const t = setup();
    expect(t.actions.editBuiltIn(t.acme.id, t.connectionId, "Google", ["mail_read", "calendar_read", "ads_read"])).toEqual({ needsSignIn: true });
    const url = await t.signInAddress();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(`openid email ${ADWORDS}`);
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("access_type")).toBe("offline");
    // The connection still asks for everything on renewal and in Edit.
    const conn = t.store.list()[0]!.connections[0]!;
    expect(conn.kind === "local" && conn.scope).toContain("gmail.readonly");
    expect(conn.kind === "local" && conn.scope).toContain(ADWORDS);
  });

  it("asks for everything on a first sign-in", async () => {
    const t = setup();
    const url = await t.signInAddress();
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
    expect(url.searchParams.get("include_granted_scopes")).toBeNull();
  });
});
