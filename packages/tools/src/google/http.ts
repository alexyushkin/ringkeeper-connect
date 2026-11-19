// Calling Google: one request with the connection's token, and Google's failures turned
// into plain language that says what to do. The token never appears in a message.
import { ToolError, type ToolContext } from "../types.js";
import { accessLabels, type AccessKey } from "./access.js";

export type Json = Record<string, any>;

/** Each API's short name (what ctx.base and the tests use) and its real address. */
export const BASES = {
  gmail: "https://gmail.googleapis.com/gmail/v1/users/me",
  drive: "https://www.googleapis.com/drive/v3",
  // Drive's and YouTube's uploads share this base: /drive/v3/files and /youtube/v3/videos.
  upload: "https://www.googleapis.com/upload",
  calendar: "https://www.googleapis.com/calendar/v3",
  sheets: "https://sheets.googleapis.com/v4/spreadsheets",
  docs: "https://docs.googleapis.com/v1",
  webmasters: "https://www.googleapis.com/webmasters/v3",
  analyticsadmin: "https://analyticsadmin.googleapis.com/v1beta",
  analyticsdata: "https://analyticsdata.googleapis.com/v1beta",
  youtube: "https://www.googleapis.com/youtube/v3",
  youtubeanalytics: "https://youtubeanalytics.googleapis.com/v2",
  googleads: "https://googleads.googleapis.com/v26",
} as const;
export type Api = keyof typeof BASES;

const TIMEOUT_MS = 30_000;

/** Python's quote(text, safe=""): every character but letters, digits and _.-~ escaped. */
export function quoteAll(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface CallOptions {
  params?: Record<string, unknown>;
  json?: unknown;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  /** What was asked for, for a 404 ("that message"). */
  what?: string;
  timeoutMs?: number;
  /** An absolute address (an upload session) instead of an API and a path. */
  url?: string;
  /** Words of its own for some refusals (Google Ads'); undefined falls to the usual ones. */
  refusal?: (status: number, body: unknown, challenge: string) => string | undefined;
}

function query(params: Record<string, unknown> | undefined): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null) continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, String(one));
  }
  const text = q.toString();
  return text ? `?${text}` : "";
}

/** Google's own explanation: {"error": {"message"}}, {"message"}, or {"error": "..."}. */
function explanation(body: any, fallback: string): string {
  const error = body?.error;
  if (error && typeof error === "object" && typeof error.message === "string") return error.message;
  if (typeof body?.message === "string") return body.message;
  if (typeof error === "string") return typeof body?.error_description === "string" ? body.error_description : error;
  return fallback || "no details";
}

function reasons(body: any): string[] {
  const error = body?.error;
  if (!error || typeof error !== "object") return [];
  const found: string[] = [];
  if (typeof error.status === "string") found.push(error.status);
  for (const e of Array.isArray(error.errors) ? error.errors : []) if (typeof e?.reason === "string") found.push(e.reason);
  for (const d of Array.isArray(error.details) ? error.details : []) if (typeof d?.reason === "string") found.push(d.reason);
  return found;
}

const RATE = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded", "RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED"]);
const DISABLED = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);

export class Google {
  constructor(
    readonly ctx: ToolContext,
    /** The access keys that allow this call, named when Google says the account wasn't given enough. */
    readonly needs: readonly AccessKey[],
  ) {}

  /** The same caller, for a call that needs other access (a refusal then names that). */
  as(needs: readonly AccessKey[]): Google {
    return new Google(this.ctx, needs);
  }

  base(api: Api): string {
    return this.ctx.base(api, BASES[api]).replace(/\/+$/, "");
  }

  /** The token never goes back to the AI, whatever Google or the network says. */
  private clean(text: string): string {
    const token = this.ctx.token;
    const cut = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    return token ? cut.split(token).join("[hidden]") : cut;
  }

  fail(text: string): ToolError {
    return new ToolError(this.clean(text));
  }

  /** The response, or a ToolError in plain language. */
  async raw(api: Api, method: string, path: string, o: CallOptions = {}): Promise<Response> {
    const url = o.url ?? `${this.base(api)}${path}${query(o.params)}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.ctx.token}`, ...o.headers };
    let body: string | Uint8Array | undefined = o.body;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      headers["Content-Type"] ??= "application/json";
    }
    let response: Response;
    try {
      // An upload session answers 308 for "send the next part": that isn't a redirect to follow.
      const redirect = o.url ? "manual" : "follow";
      // (The cast: the app's browser typings don't count a Uint8Array as a request body; Node's fetch takes it.)
      response = await this.ctx.fetch(url, { method, headers, body: body as RequestInit["body"], redirect, signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS) });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") throw this.fail("Google took too long to answer. Try again in a moment.");
      throw this.fail("Couldn't reach Google. Check this computer's internet connection and try again.");
    }
    if (response.status >= 400) throw await this.refused(response, o.what, o.refusal);
    return response;
  }

  /** Google's answer as an object ({} when empty, {"data": ...} when it isn't an object). */
  async json(api: Api, method: string, path: string, o: CallOptions = {}): Promise<Json> {
    const response = await this.raw(api, method, path, o);
    const text = await response.text();
    if (!text) return {};
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {};
    }
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Json) : { data: body };
  }

  private async refused(response: Response, what: string | undefined, refusal?: CallOptions["refusal"]): Promise<ToolError> {
    let body: any = undefined;
    try {
      body = JSON.parse(await response.text());
    } catch {
      // not JSON: Google's own words are then its status line
    }
    const status = response.status;
    const said = explanation(body, response.statusText);
    const why = reasons(body);
    const challenge = response.headers.get("www-authenticate") ?? "";
    const tick = accessLabels(this.needs);
    const own = refusal?.(status, body, challenge);
    if (own) return this.fail(own);
    if (status === 401) {
      return this.fail("The Google sign-in for this account has expired or was removed. Sign in to Google again in Ringkeeper Connect.");
    }
    if (status === 429 || why.some((r) => RATE.has(r))) {
      return this.fail("Google is limiting how many requests this account can make right now. Wait a minute and try again.");
    }
    if (status === 403) {
      const scope =
        /insufficient_scope/i.test(challenge) ||
        why.includes("insufficientPermissions") ||
        why.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
        /insufficient authentication scopes/i.test(said);
      if (scope) {
        return this.fail(`This Google account wasn't given ${tick}. Sign in to Google again in Ringkeeper Connect and tick ${this.needs.length > 1 ? "one of them" : "it"}.`);
      }
      if (why.some((r) => DISABLED.has(r))) {
        return this.fail(`Google says this service isn't turned on for the app this account signs in through: ${said}`);
      }
      return this.fail(`Google refused this: ${said}. This account may not have access to it.`);
    }
    if (status === 404) return this.fail(`Google couldn't find ${what ?? "that"}. Check the id, and that this account can see it.`);
    if (status === 400) return this.fail(`Google didn't accept that: ${said}`);
    if (status >= 500) return this.fail(`Google had a problem (${status}). Try again in a moment.`);
    return this.fail(`Google returned ${status}: ${said}`);
  }
}
