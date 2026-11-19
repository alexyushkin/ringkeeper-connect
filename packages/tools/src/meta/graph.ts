// Calling Meta's Marketing API (the Graph API) with the connection's access token, and
// Meta's failures in plain language. The token goes in the Authorization header, never
// in an address, and never appears in a message.
import { ToolError, type ToolContext } from "../types.js";

export type Json = Record<string, any>;
/** Meta's current Graph API version (checked November 2026: v28.0 doesn't exist yet). */
export const META_GRAPH = "https://graph.facebook.com/v27.0";
const TIMEOUT_MS = 30_000;

/** Meta's "too many calls" codes (API, app, account and ads-management limits). */
const THROTTLED = new Set([4, 17, 32, 613, 80000, 80003, 80004, 80014]);
/** Codes that mean the token lacks a permission or this person can't reach the account. */
const NOT_ALLOWED = new Set([10, 200, 294, 299]);

function query(params: Record<string, unknown> | undefined): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    q.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const text = q.toString();
  return text ? `?${text}` : "";
}

export class MetaGraph {
  constructor(readonly ctx: ToolContext) {}

  base(): string {
    return this.ctx.base("meta", META_GRAPH).replace(/\/+$/, "");
  }

  /** The token never goes back to the AI, whatever Meta or the network says. */
  private clean(text: string): string {
    const token = this.ctx.token;
    const cut = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    return token ? cut.split(token).join("[hidden]") : cut;
  }

  fail(text: string): ToolError {
    return new ToolError(this.clean(text));
  }

  async call(method: "GET" | "POST", path: string, params?: Record<string, unknown>, what?: string): Promise<Json> {
    if (!this.ctx.token) throw this.fail("Meta Ads has no access token. Add one in Ringkeeper Connect with Edit on this tool.");
    let response: Response;
    try {
      response = await this.ctx.fetch(`${this.base()}${path}${query(params)}`, {
        method,
        headers: { Authorization: `Bearer ${this.ctx.token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") throw this.fail("Meta took too long to answer. Try again in a moment, or ask for a shorter date range.");
      throw this.fail("Couldn't reach Meta. Check this computer's internet connection and try again.");
    }
    const text = await response.text();
    let body: Json = {};
    try {
      const parsed = text ? JSON.parse(text) : {};
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { data: parsed };
    } catch {
      // not JSON: only the status says what happened
    }
    if (response.status >= 400 || body.error) throw this.refused(response.status, body.error, what);
    return body;
  }

  private refused(status: number, error: Json | undefined, what: string | undefined): ToolError {
    const code = typeof error?.code === "number" ? error.code : 0;
    const sub = typeof error?.error_subcode === "number" ? error.error_subcode : 0;
    const said = (typeof error?.error_user_msg === "string" && error.error_user_msg) || (typeof error?.message === "string" && error.message) || `status ${status}`;
    if (code === 190 || code === 102 || status === 401) {
      return this.fail(
        sub === 463 || /expired/i.test(said)
          ? "This Meta access token has expired. Make a new one and paste it in Ringkeeper Connect with Edit on this tool."
          : "Meta didn't accept this access token: it may have been revoked or changed. Make a new one and paste it in Ringkeeper Connect with Edit on this tool.",
      );
    }
    if (THROTTLED.has(code) || status === 429) return this.fail("Meta is limiting how many requests this ad account can take right now. Wait a few minutes and try again.");
    if (NOT_ALLOWED.has(code) || (code >= 200 && code < 300) || status === 403) {
      return this.fail(
        `Meta didn't allow this: ${said}. Check that the token has ads_read (and ads_management for pausing), and that its system user or person is assigned to this ad account in Meta Business Settings.`,
      );
    }
    if (code === 803 || (code === 100 && /does not exist|cannot be loaded|Unknown path/i.test(said)) || status === 404) {
      return this.fail(`Meta couldn't find ${what ?? "that"}. Check the id, and that this token can see it.`);
    }
    if (code === 100 || status === 400) return this.fail(`Meta didn't accept that: ${said}`);
    if (code === 1 || code === 2 || status >= 500) return this.fail(`Meta had a problem (${said}). Try again in a moment.`);
    return this.fail(`Meta returned an error: ${said}`);
  }
}

/** A list as a tool answers it: the items, and next_page when Meta has more. */
export function listed(answer: Json): Json {
  const out: Json = { data: Array.isArray(answer.data) ? answer.data : [] };
  const after = answer.paging?.cursors?.after;
  if (typeof answer.paging?.next === "string" && typeof after === "string") {
    out.next_page = after;
    out.note = "More follow: call again with next_page to read on.";
  }
  return out;
}
