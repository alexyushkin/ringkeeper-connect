// Google Ads, in the Google account connection. Ported from Ringkeeper
// (src/ringkeeper/adapters/vendors/ads.py): list_accounts (customers:listAccessibleCustomers),
// report (googleAds:search, in Google Ads Query Language, with paging), and pausing
// campaigns, which asks the person first, each time, in Ringkeeper Connect.
//
// There's no developer token: Google dropped them, and access now belongs to the Google
// Cloud project that owns the app the account signs in through. A client reached through
// a manager account needs the manager's ID, sent as login-customer-id.
//
// Left out on purpose, as Ringkeeper holds them behind a typed name: creating campaigns,
// ad groups, ads and keywords, starting anything, and changing budgets or bids.
import { ToolError } from "../types.js";
import type { Google, Json } from "./http.js";
import { arg, s, tool, type Schema } from "./schema.js";

/** Google Ads API version (checked November 2026: v26 answers, v27 doesn't exist yet). */
export const ADS_API_VERSION = "v26";
/** The most campaigns one pause takes. */
export const MOST_ADS_PAUSED = 20;
/** The most rows one answer shows; the rest of Google's page is left out, with a note. */
export const MOST_ADS_ROWS = 1000;

export const ADS_NOT_APPROVED =
  "Google hasn't approved this Google app for live ad accounts yet. In Google Cloud, open the Google Ads API page for the app's project and apply for Explorer access.";
export const ADS_NOT_TICKED = "Google Ads isn't turned on for this account. Edit the connection and tick Google Ads.";

/** Every Google Ads error code in an answer: errors[].errorCode is {"authorizationError": "…"} and the like. */
export function adsErrorCodes(body: unknown): string[] {
  const details = (body as Json)?.error?.details;
  const codes: string[] = [];
  for (const d of Array.isArray(details) ? details : []) {
    for (const e of Array.isArray(d?.errors) ? d.errors : []) {
      for (const v of Object.values((e?.errorCode ?? {}) as Json)) if (typeof v === "string") codes.push(v);
    }
    if (typeof d?.reason === "string") codes.push(d.reason);
  }
  return codes;
}

/** Google Ads' refusals that need words of their own; anything else falls to the usual ones. */
export function adsRefusal(status: number, body: unknown, challenge: string): string | undefined {
  const codes = adsErrorCodes(body);
  if (codes.some((c) => c === "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" || c === "ACTION_NOT_PERMITTED")) return ADS_NOT_APPROVED;
  const message = String((body as Json)?.error?.message ?? "");
  if (status === 403 && (codes.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || /insufficient_scope/i.test(challenge) || /insufficient authentication scopes/i.test(message))) {
    return ADS_NOT_TICKED;
  }
  if (codes.includes("USER_PERMISSION_DENIED")) {
    return "This Google account can't reach that ad account directly. If it's under a manager account, give the manager's ID too.";
  }
  if (codes.includes("CUSTOMER_NOT_ENABLED")) return "That Google Ads account isn't active (it may be cancelled or not finished setting up).";
  if (codes.includes("NOT_ADS_USER")) return "This Google account has no Google Ads access. Sign in with an account that has, or ask the client to add it in Google Ads.";
  if (codes.some((c) => /QUERY|FIELD|EXPECTED|UNRECOGNIZED|INVALID_/.test(c)) && status === 400) {
    const said = (body as Json)?.error?.details?.[0]?.errors?.[0]?.message ?? message;
    return `Google Ads didn't accept that query: ${said}`;
  }
  return undefined;
}

const CUSTOMER: Schema = s.str({ pattern: "^\\d{3}-?\\d{3}-?\\d{4}$", description: "The ad account's 10-digit customer ID (dashes are fine), from list_ads_accounts." });
const MANAGER: Schema = s.str({
  pattern: "^\\d{3}-?\\d{3}-?\\d{4}$",
  description: "For an ad account reached through a manager account: the manager's 10-digit ID.",
});
const digits = (v: string) => v.replace(/-/g, "");

/** The headers a call needs: the manager's ID when the account is reached through one. */
function managerHeader(a: Json): Record<string, string> {
  const manager = arg.opt(a, "manager_id");
  return manager ? { "login-customer-id": digits(manager) } : {};
}

async function search(g: Google, customer: string, query: string, headers: Record<string, string>, pageToken?: string): Promise<Json> {
  return g.json("googleads", "POST", `/customers/${customer}/googleAds:search`, {
    json: { query, ...(pageToken ? { pageToken } : {}) },
    headers,
    what: "that ad account",
    refusal: adsRefusal,
  });
}

export const adsTools = [
  tool({
    name: "list_ads_accounts",
    description: "The Google Ads accounts this Google account can reach directly, by customer ID. An account under a manager account is reached with the manager's ID (manager_id) in the other tools.",
    needs: ["ads_read", "ads_pause"],
    async run(_a, g) {
      const found = await g.json("googleads", "GET", "/customers:listAccessibleCustomers", { refusal: adsRefusal });
      const ids = ((found.resourceNames ?? []) as string[]).map((r) => String(r).split("/").pop()!);
      return {
        customer_ids: ids,
        note: ids.length
          ? "For names and currencies, run ads_report with SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer, for each ID."
          : "This Google account can't reach any Google Ads account directly.",
      };
    },
  }),
  tool({
    name: "ads_report",
    description:
      "A Google Ads report in Google Ads Query Language (GAQL), e.g. SELECT campaign.id, campaign.name, metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS. " +
      "Money in *_micros fields is millionths of the account's currency. Add LIMIT to keep it short. When there's more, next_page reads on.",
    needs: ["ads_read", "ads_pause"],
    properties: {
      customer_id: CUSTOMER,
      query: s.str({ minLength: 10, maxLength: 10_000, description: "The GAQL query." }),
      manager_id: MANAGER,
      next_page: s.str({ minLength: 1, maxLength: 4000, description: "next_page from the last answer, with the same query." }),
    },
    required: ["customer_id", "query"],
    async run(a, g) {
      const found = await search(g, digits(arg.str(a, "customer_id")), arg.str(a, "query"), managerHeader(a), arg.opt(a, "next_page"));
      const results = (found.results ?? []) as Json[];
      const out: Json = { rows: results.slice(0, MOST_ADS_ROWS) };
      if (results.length > MOST_ADS_ROWS) out.left_out = `Google sent ${results.length} rows; only the first ${MOST_ADS_ROWS} are here. Add LIMIT or narrow the query.`;
      if (typeof found.nextPageToken === "string" && found.nextPageToken) {
        out.next_page = found.nextPageToken;
        out.note = "More follow: call again with the same query and next_page to read on.";
      }
      if (!results.length) out.note = "No rows: nothing matched (or nothing ran in these dates).";
      return out;
    },
  }),
  tool({
    name: "ads_pause_campaigns",
    description: `Pause Google Ads campaigns (up to ${MOST_ADS_PAUSED} at once). Ringkeeper Connect asks the person to allow it first; if they don't, nothing changes. It can't start anything.`,
    needs: ["ads_pause"],
    properties: {
      customer_id: CUSTOMER,
      campaign_ids: s.list(s.str({ pattern: "^\\d{1,20}$" }), { minItems: 1, maxItems: MOST_ADS_PAUSED, description: "Campaign IDs, from ads_report." }),
      manager_id: MANAGER,
    },
    required: ["customer_id", "campaign_ids"],
    async run(a, g) {
      const customer = digits(arg.str(a, "customer_id"));
      const headers = managerHeader(a);
      const ids = [...new Set(arg.strs(a, "campaign_ids")!)];
      // Their names, so the person knows what they're allowing. IDs are digits only.
      const found = await search(g, customer, `SELECT campaign.id, campaign.name, campaign.status, customer.descriptive_name FROM campaign WHERE campaign.id IN (${ids.join(", ")})`, headers);
      const rows = ((found.results ?? []) as Json[]).map((r) => ({ id: String(r.campaign?.id ?? ""), name: r.campaign?.name as string | undefined, status: r.campaign?.status, account: r.customer?.descriptiveName as string | undefined }));
      const missing = ids.filter((id) => !rows.some((r) => r.id === id));
      if (missing.length) throw new ToolError(`Google Ads has no campaign ${missing.join(", ")} in that ad account. Nothing was paused.`);
      const toPause = rows.filter((r) => r.status !== "PAUSED");
      const already = rows.filter((r) => r.status === "PAUSED").map(({ id, name }) => ({ id, name }));
      if (!toPause.length) return { paused: [], already_paused: already };
      if (!g.ctx.approve) throw new ToolError("Pausing needs your OK in Ringkeeper Connect, and it couldn't ask. Nothing was paused.");
      const where = rows[0]?.account ? ` (${rows[0].account})` : "";
      const lines = toPause.map((r) => `• ${r.name ?? "(no name)"} (${r.id})`).join("\n");
      const allowed = await g.ctx.approve(
        `Pause ${toPause.length === 1 ? "this campaign" : `these ${toPause.length} campaigns`} in Google Ads${where}?\n\n${lines}\n\nThey stop showing until someone turns them back on in Google Ads.`,
      );
      if (!allowed) throw new ToolError("The person didn't allow pausing, so nothing was paused. Don't try again unless they ask.");
      await g.json("googleads", "POST", `/customers/${customer}/campaigns:mutate`, {
        json: { operations: toPause.map((r) => ({ updateMask: "status", update: { resourceName: `customers/${customer}/campaigns/${r.id}`, status: "PAUSED" } })) },
        headers,
        what: "those campaigns",
        refusal: adsRefusal,
      });
      return { paused: toPause.map(({ id, name }) => ({ id, name })), already_paused: already };
    },
  }),
];
