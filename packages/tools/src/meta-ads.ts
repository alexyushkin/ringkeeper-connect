// Meta Ads with a pasted access token: ad accounts, campaigns, ad sets, ads and their
// reports, through Meta's Marketing API, plus pausing (which asks the person first, each
// time, in Ringkeeper Connect). Meta's own ads server only takes its own sign-ins, so a
// token an agency already has goes here instead.
//
// Left out on purpose: creating anything, changing budgets, bids or targeting, deleting,
// and turning ads back on.
import { ToolError, type BuiltinService, type BuiltinTool, type ToolContext } from "./types.js";
import { object as checkArgs, s, type Args, type Schema } from "./google/schema.js";
import { MetaGraph, listed, type Json } from "./meta/graph.js";

export const META_ADS_ACCESS = {
  ads_read: { label: "Read ad accounts, campaigns and reports", scope: "ads_read" },
  ads_pause: { label: "Pause campaigns, ad sets and ads (asks you first, each time)", scope: "ads_management" },
} as const;
export type MetaAdsAccessKey = keyof typeof META_ADS_ACCESS;

/** The setting that holds the pasted token (the catalog's field). */
export const META_TOKEN_SETTING = "META_ACCESS_TOKEN";
/** The most objects one pause takes, so a mistaken call can't stop a whole account. */
export const MOST_PAUSED = 20;

const OBJECT_ID = "^[0-9]{1,30}$";
const ACCOUNT_ID = "^(act_)?[0-9]{1,30}$";
const DATE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

const ACCOUNT_STATUS: Record<number, string> = {
  1: "active",
  2: "disabled",
  3: "unsettled",
  7: "pending risk review",
  8: "pending settlement",
  9: "in grace period",
  100: "pending closure",
  101: "closed",
  201: "any active",
  202: "any closed",
};

export const DATE_PRESETS = [
  "today",
  "yesterday",
  "this_month",
  "last_month",
  "this_quarter",
  "maximum",
  "last_3d",
  "last_7d",
  "last_14d",
  "last_28d",
  "last_30d",
  "last_90d",
  "last_week_mon_sun",
  "last_week_sun_sat",
  "last_quarter",
  "last_year",
  "this_week_mon_today",
  "this_week_sun_today",
  "this_year",
] as const;

const EFFECTIVE_STATUSES = ["ACTIVE", "PAUSED", "DELETED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ARCHIVED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES"];

const DEFAULT_INSIGHTS = ["spend", "impressions", "reach", "frequency", "clicks", "ctr", "cpc", "cpm", "actions", "cost_per_action_type", "purchase_roas"];

const MONEY_NOTE = "Budgets and amount_spent are in the account currency's smallest unit (cents for USD): divide by 100. Insights spend is in the currency itself.";

const LIMIT: Schema = s.int({ minimum: 1, maximum: 200, default: 50, description: "The most items to return." });
const NEXT: Schema = s.str({ minLength: 1, maxLength: 2000, description: "next_page from the last answer, to read on." });
const ACCOUNT: Schema = s.str({ pattern: ACCOUNT_ID, description: "The ad account's id, e.g. act_1234567890 (from list_ad_accounts)." });
const STATUSES: Schema = s.list(s.oneOf(EFFECTIVE_STATUSES), { maxItems: 12, description: "Only items in these states, e.g. [\"ACTIVE\"]. All when left out." });

/** "act_123" or "123" → "act_123". */
export function accountPath(id: string): string {
  return id.startsWith("act_") ? id : `act_${id}`;
}

interface Def {
  name: string;
  description: string;
  needs: MetaAdsAccessKey[];
  properties: Record<string, Schema>;
  required?: string[];
  run(a: Args, g: MetaGraph, ctx: ToolContext): Promise<unknown>;
}

function tool(def: Def): BuiltinTool {
  const schema: Schema = { type: "object", properties: def.properties, required: def.required ?? [] };
  return {
    name: def.name,
    description: def.description,
    inputSchema: { type: "object", properties: def.properties, ...(def.required?.length ? { required: def.required } : {}) },
    needs: def.needs,
    run: async (args, ctx) => def.run(checkArgs(schema, args ?? {}, ""), new MetaGraph(ctx), ctx),
  };
}

/** Which one of a few parents a list reads under: exactly one must be given. */
function parent(a: Args, names: Array<[string, (v: string) => string]>, what: string): string {
  const given = names.filter(([k]) => typeof a[k] === "string");
  if (given.length !== 1) throw new ToolError(`Give exactly one of ${names.map(([k]) => k).join(", ")} to say whose ${what} to list.`);
  const [key, path] = given[0]!;
  return path(String(a[key]));
}

const listAccounts = tool({
  name: "list_ad_accounts",
  description: "The ad accounts this token can reach: id (use it in the other tools), name, status, currency, time zone and amount spent.",
  needs: ["ads_read", "ads_pause"],
  properties: { limit: LIMIT, next_page: NEXT },
  async run(a, g) {
    const answer = await g.call("GET", "/me/adaccounts", {
      fields: "id,name,account_status,currency,timezone_name,amount_spent,business{id,name}",
      limit: a.limit,
      after: a.next_page,
    });
    const out = listed(answer);
    out.data = (out.data as Json[]).map((x) => ({ ...x, account_status: ACCOUNT_STATUS[x.account_status as number] ?? x.account_status }));
    out.money = MONEY_NOTE;
    return out;
  },
});

const listCampaigns = tool({
  name: "list_campaigns",
  description: "Campaigns in one ad account: id, name, status, objective, budgets and dates.",
  needs: ["ads_read", "ads_pause"],
  properties: { account_id: ACCOUNT, statuses: STATUSES, limit: LIMIT, next_page: NEXT },
  required: ["account_id"],
  async run(a, g) {
    const answer = await g.call(
      "GET",
      `/${accountPath(String(a.account_id))}/campaigns`,
      {
        fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,created_time",
        effective_status: a.statuses,
        limit: a.limit,
        after: a.next_page,
      },
      "that ad account",
    );
    return { ...listed(answer), money: MONEY_NOTE };
  },
});

const listAdSets = tool({
  name: "list_ad_sets",
  description: "Ad sets in one ad account or one campaign: id, name, status, budgets, optimization goal and dates. Give account_id or campaign_id.",
  needs: ["ads_read", "ads_pause"],
  properties: {
    account_id: ACCOUNT,
    campaign_id: s.str({ pattern: OBJECT_ID, description: "Only this campaign's ad sets." }),
    statuses: STATUSES,
    limit: LIMIT,
    next_page: NEXT,
  },
  async run(a, g) {
    const under = parent(a, [["account_id", (v) => accountPath(v)], ["campaign_id", (v) => v]], "ad sets");
    const answer = await g.call(
      "GET",
      `/${under}/adsets`,
      {
        fields: "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,budget_remaining,optimization_goal,billing_event,bid_strategy,start_time,end_time",
        effective_status: a.statuses,
        limit: a.limit,
        after: a.next_page,
      },
      "that account or campaign",
    );
    return { ...listed(answer), money: MONEY_NOTE };
  },
});

const listAds = tool({
  name: "list_ads",
  description: "Ads in one ad account, campaign or ad set: id, name, status, and the creative's title, text and picture. Give account_id, campaign_id or ad_set_id.",
  needs: ["ads_read", "ads_pause"],
  properties: {
    account_id: ACCOUNT,
    campaign_id: s.str({ pattern: OBJECT_ID, description: "Only this campaign's ads." }),
    ad_set_id: s.str({ pattern: OBJECT_ID, description: "Only this ad set's ads." }),
    statuses: STATUSES,
    limit: LIMIT,
    next_page: NEXT,
  },
  async run(a, g) {
    const under = parent(
      a,
      [
        ["account_id", (v) => accountPath(v)],
        ["campaign_id", (v) => v],
        ["ad_set_id", (v) => v],
      ],
      "ads",
    );
    const answer = await g.call(
      "GET",
      `/${under}/ads`,
      {
        fields: "id,name,campaign_id,adset_id,status,effective_status,created_time,creative{id,name,title,body,thumbnail_url,object_story_id}",
        effective_status: a.statuses,
        limit: a.limit,
        after: a.next_page,
      },
      "that account, campaign or ad set",
    );
    return listed(answer);
  },
});

const insights = tool({
  name: "get_insights",
  description:
    "Performance report for an ad account, campaign, ad set or ad: spend, impressions, reach, clicks, CTR, CPC, CPM, results (actions) and ROAS by default. " +
    "Choose the dates with date_preset, or since and until. Split it with level (one row per campaign, ad set or ad), time_increment (1 = per day, 7 = per week, monthly) and breakdowns (age, gender, country, publisher_platform, platform_position, device_platform…).",
  needs: ["ads_read", "ads_pause"],
  properties: {
    object_id: s.str({ pattern: ACCOUNT_ID, description: "An ad account (act_…), campaign, ad set or ad id." }),
    level: s.oneOf(["account", "campaign", "adset", "ad"], { description: "One row per account, campaign, ad set or ad." }),
    date_preset: s.oneOf([...DATE_PRESETS], { description: "A named range, e.g. last_7d. Ignored when since and until are given." }),
    since: s.str({ pattern: DATE, description: "First day, YYYY-MM-DD (in the ad account's time zone)." }),
    until: s.str({ pattern: DATE, description: "Last day, YYYY-MM-DD." }),
    time_increment: s.str({ pattern: "^([1-9]|[1-8][0-9]|90|monthly|all_days)$", description: "1 for a row per day, 7 per week, monthly, or all_days (the default)." }),
    fields: s.list(s.str({ pattern: "^[a-z0-9_]{1,60}$" }), { maxItems: 40, description: `Metrics to return. Default: ${DEFAULT_INSIGHTS.join(", ")}.` }),
    breakdowns: s.list(s.str({ pattern: "^[a-z0-9_]{1,60}$" }), { maxItems: 4, description: "e.g. [\"age\", \"gender\"] or [\"publisher_platform\"]." }),
    sort: s.str({ pattern: "^[a-z0-9_]{1,60}_(ascending|descending)$", description: "e.g. spend_descending." }),
    limit: LIMIT,
    next_page: NEXT,
  },
  required: ["object_id"],
  async run(a, g) {
    const id = String(a.object_id);
    const since = a.since as string | undefined;
    const until = a.until as string | undefined;
    if (!!since !== !!until) throw new ToolError("Give both since and until, or neither.");
    if (since && until && since > until) throw new ToolError("since has to be on or before until.");
    const fields = (a.fields as string[] | undefined) ?? DEFAULT_INSIGHTS;
    const params: Record<string, unknown> = {
      fields: [...new Set([...fields, "date_start", "date_stop"])].join(","),
      level: a.level,
      time_increment: a.time_increment,
      breakdowns: (a.breakdowns as string[] | undefined)?.join(","),
      sort: a.sort,
      limit: a.limit,
      after: a.next_page,
    };
    if (since && until) params.time_range = { since, until };
    else params.date_preset = a.date_preset ?? "last_30d";
    const answer = await g.call("GET", `/${id}/insights`, params, "that account, campaign, ad set or ad");
    const out = listed(answer);
    if (!(out.data as Json[]).length) out.note = "Meta has no results for these dates: nothing ran, or nothing was spent.";
    return out;
  },
});

const pause = tool({
  name: "pause",
  description: `Pause campaigns, ad sets or ads (up to ${MOST_PAUSED} at once). Ringkeeper Connect asks the person to allow it first; if they don't, nothing changes. It can't turn anything back on.`,
  needs: ["ads_pause"],
  properties: {
    ids: s.list(s.str({ pattern: OBJECT_ID }), { minItems: 1, maxItems: MOST_PAUSED, description: "Campaign, ad set or ad ids." }),
  },
  required: ["ids"],
  async run(a, g, ctx) {
    const ids = [...new Set(a.ids as string[])];
    // What each one is, by name, so the person knows what they're allowing.
    const found: Json[] = [];
    for (const id of ids) {
      const x = await g.call("GET", `/${id}`, { fields: "id,name,status,effective_status,account_id" }, `${id}`);
      found.push(x);
    }
    const toPause = found.filter((x) => x.status !== "PAUSED");
    const already = found.filter((x) => x.status === "PAUSED").map((x) => ({ id: x.id, name: x.name }));
    if (!toPause.length) return { paused: [], already_paused: already };
    if (!ctx.approve) throw new ToolError("Pausing needs your OK in Ringkeeper Connect, and it couldn't ask. Nothing was paused.");
    const lines = toPause.map((x) => `• ${x.name ?? "(no name)"} (${x.id})`).join("\n");
    const allowed = await ctx.approve(`Pause ${toPause.length === 1 ? "this" : `these ${toPause.length}`} in Meta Ads?\n\n${lines}\n\nAds stop showing until someone turns them back on in Meta Ads Manager.`);
    if (!allowed) throw new ToolError("The person didn't allow pausing, so nothing was paused. Don't try again unless they ask.");
    const paused: Json[] = [];
    for (const x of toPause) {
      await g.call("POST", `/${x.id}`, { status: "PAUSED" }, `${x.id}`);
      paused.push({ id: x.id, name: x.name });
    }
    return { paused, already_paused: already };
  },
});

export const metaAds: BuiltinService = {
  id: "meta-ads",
  name: "Meta Ads",
  tokenSetting: META_TOKEN_SETTING,
  tools: [listAccounts, listCampaigns, listAdSets, listAds, insights, pause],
};
