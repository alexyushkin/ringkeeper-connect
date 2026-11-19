// Calling Microsoft Graph: one request with the connection's token, Microsoft's failures
// in plain language, and a tool builder shaped like Ringkeeper's operation table
// (adapters/vendors/microsoft.py): a method, a path under /v1.0, and the values it takes.
// The token never appears in a message, and neither does a file's signed download link.
import { ToolError, type BuiltinTool, type ToolContext } from "../types.js";
import { object as checkArgs, s, type Args, type Schema } from "../google/schema.js";
import { accessLabels, type MicrosoftAccessKey } from "./access.js";

export type Json = Record<string, any>;
export const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** More people than this in one email or invitation is a mailing, not a message. */
export const MOST_PEOPLE = 50;

/** A value that goes into the path: one segment, nothing that climbs out of it (Ringkeeper's SEGMENT_CHARS). */
export const SEGMENT_PATTERN = "^[A-Za-z0-9_\\-.:@~+=!,]{1,1000}$";

function query(params: Record<string, unknown> | undefined): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    q.append(k, String(v));
  }
  const text = q.toString();
  return text ? `?${text}` : "";
}

export interface CallOptions {
  params?: Record<string, unknown>;
  json?: unknown;
  headers?: Record<string, string>;
  /** What was asked for, for a 404 ("that message"). */
  what?: string;
}

const THROTTLED = new Set(["activityLimitReached", "TooManyRequests", "ApplicationThrottled", "ErrorServerBusy", "throttledRequest"]);
const NO_MAILBOX = new Set(["MailboxNotEnabledForRESTAPI", "MailboxNotSupportedForRESTAPI", "ErrorMailboxNotEnabledForRESTAPI"]);

export class Graph {
  constructor(
    readonly ctx: ToolContext,
    /** The access keys that allow this call, named when Microsoft says the account wasn't given enough. */
    readonly needs: readonly MicrosoftAccessKey[],
  ) {}

  base(): string {
    return this.ctx.base("graph", GRAPH).replace(/\/+$/, "");
  }

  /** The token never goes back to the AI, whatever Microsoft or the network says. */
  private clean(text: string): string {
    const token = this.ctx.token;
    const cut = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    return token ? cut.split(token).join("[hidden]") : cut;
  }

  fail(text: string): ToolError {
    return new ToolError(this.clean(text));
  }

  private async send(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
    try {
      return await this.ctx.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") throw this.fail("Microsoft took too long to answer. Try again in a moment.");
      throw this.fail("Couldn't reach Microsoft. Check this computer's internet connection and try again.");
    }
  }

  /** The response, or a ToolError in plain language. */
  async raw(method: string, path: string, o: CallOptions = {}, redirect: "follow" | "manual" = "follow"): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.ctx.token}`, ...o.headers };
    let body: string | undefined;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      headers["Content-Type"] ??= "application/json";
    }
    const response = await this.send(`${this.base()}${path}${query(o.params)}`, { method, headers, body, redirect });
    if (response.status >= 400) throw await this.refused(response, o.what);
    return response;
  }

  /** Microsoft's answer as an object ({} when empty). */
  async json(method: string, path: string, o: CallOptions = {}): Promise<Json> {
    const response = await this.raw(method, path, o);
    const text = await response.text();
    if (!text) return {};
    try {
      const body = JSON.parse(text);
      return body && typeof body === "object" && !Array.isArray(body) ? (body as Json) : { value: body };
    } catch {
      return {};
    }
  }

  /**
   * A file's content. Graph answers /content with a signed link to the file: that's
   * followed once, without the connection's token, and never shown.
   */
  async download(path: string, what: string): Promise<Buffer> {
    const first = await this.raw("GET", path, { what }, "manual");
    if (first.status < 300) return Buffer.from(await first.arrayBuffer());
    const link = first.headers.get("location") ?? "";
    if (!/^https?:\/\//i.test(link)) throw this.fail(`Microsoft didn't send ${what}. Try again in a moment.`);
    const file = await this.send(link, { method: "GET", redirect: "follow" }, DOWNLOAD_TIMEOUT_MS);
    if (file.status >= 400) throw this.fail(`Microsoft didn't send ${what} (${file.status}). Try again in a moment.`);
    return Buffer.from(await file.arrayBuffer());
  }

  private async refused(response: Response, what: string | undefined): Promise<ToolError> {
    let body: any = undefined;
    try {
      body = JSON.parse(await response.text());
    } catch {
      // not JSON: Microsoft's own words are then its status line
    }
    const status = response.status;
    const error = body?.error;
    const code = typeof error?.code === "string" ? error.code : "";
    const inner = typeof error?.innerError?.code === "string" ? error.innerError.code : "";
    const said = (typeof error?.message === "string" && error.message) || (typeof error === "string" && (body?.error_description || error)) || response.statusText || "no details";
    if (status === 401) {
      return this.fail("The Microsoft sign-in for this account has expired or was removed. Sign in to Microsoft again in Ringkeeper Connect.");
    }
    if (status === 429 || THROTTLED.has(code) || THROTTLED.has(inner)) {
      return this.fail("Microsoft is limiting how many requests this account can make right now. Wait a minute and try again.");
    }
    if (NO_MAILBOX.has(code)) {
      return this.fail("This Microsoft account has no Outlook mailbox that apps can reach. Its Microsoft 365 plan may not include Exchange Online.");
    }
    if (status === 403) {
      const tick = accessLabels(this.needs);
      return this.fail(
        `Microsoft refused this: ${said}. If this account wasn't allowed ${tick} at sign-in, sign in to Microsoft again in Ringkeeper Connect and allow it. For a work or school account, its IT admin may also need to approve Ringkeeper Connect.`,
      );
    }
    if (status === 404) return this.fail(`Microsoft couldn't find ${what ?? "that"}. Check the id, and that this account can see it.`);
    if (status === 409) return this.fail(`Microsoft says that clashes with what's already there: ${said}`);
    if (status === 400 || status === 422) return this.fail(`Microsoft didn't accept that: ${said}`);
    if (status === 413) return this.fail("That's too large for Microsoft to take in one go.");
    if (status >= 500) return this.fail(`Microsoft had a problem (${status}). Try again in a moment.`);
    return this.fail(`Microsoft returned ${status}: ${said}`);
  }
}

/** Graph's bookkeeping out of an answer, and the signed download links (never shown). */
export function tidy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tidy);
  if (!value || typeof value !== "object") return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value as Json)) {
    if (k.startsWith("@odata.") || k === "@microsoft.graph.downloadUrl" || k === "@content.downloadUrl") continue;
    out[k] = tidy(v);
  }
  return out;
}

/** A list as a tool answers it: the items, and next_page when Microsoft has more. */
export function listed(answer: Json): Json {
  const out = tidy(answer) as Json;
  const next = answer["@odata.nextLink"];
  if (typeof next === "string") {
    try {
      out.next_page = new URL(next).search.replace(/^\?/, "");
      out.note = "More follow: call again with next_page to read on.";
    } catch {
      // a link that can't be read: say nothing about more
    }
  }
  return out;
}

// --- Arguments -------------------------------------------------------------------------

export const ODATA = {
  select: s.str({ maxLength: 2000, description: "The fields to return, comma-separated (Graph's $select), e.g. id,subject,from." }),
  filter: s.str({ maxLength: 2000, description: "Graph's $filter, e.g. isRead eq false." }),
  orderby: s.str({ maxLength: 500, description: "Graph's $orderby, e.g. receivedDateTime desc." }),
  top: s.int({ minimum: 1, maximum: 999, description: "The most items to return (Graph's $top)." }),
  skip: s.int({ minimum: 0, description: "Items to skip (Graph's $skip)." }),
} satisfies Record<string, Schema>;
export const NEXT_PAGE: Schema = s.str({ minLength: 1, maxLength: 4000, description: "next_page from the last answer, to read on. The other values are then ignored." });
export type OdataName = keyof typeof ODATA;

export const TEXT_BODY: Schema = {
  type: "object",
  description: '{"contentType": "Text" or "HTML", "content": "..."}',
  properties: { contentType: s.oneOf(["Text", "HTML", "text", "html"]), content: s.str({ maxLength: 200_000 }) },
  required: ["content"],
};
export const PERSON: Schema = {
  type: "object",
  description: '{"emailAddress": {"address": "anna@acme.example", "name": "Anna"}}',
  properties: {
    emailAddress: { type: "object", properties: { address: s.address(), name: s.str({ maxLength: 300 }) }, required: ["address"] },
  },
  required: ["emailAddress"],
};
export const PEOPLE: Schema = s.list(PERSON, { maxItems: MOST_PEOPLE });

/** How many people a call reaches: the recipient lists in the body, or in its `message`. */
export function peopleIn(body: Json, keys: readonly string[]): number {
  const places = [body, body.message && typeof body.message === "object" ? (body.message as Json) : {}];
  return places.reduce((n, place) => n + keys.reduce((m, k) => m + (Array.isArray(place[k]) ? (place[k] as unknown[]).length : 0), 0), 0);
}

export interface OpDef {
  name: string;
  description: string;
  needs: MicrosoftAccessKey[];
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Under /v1.0, with {placeholders}: each is a required argument, one path segment. */
  path: string;
  /** Descriptions of the path values. */
  ids?: Record<string, string>;
  /** Query values: the argument's name, and its name in the address when that differs (select → $select). */
  query?: Record<string, Schema>;
  queryNames?: Record<string, string>;
  /** Body fields: sent as the JSON body. */
  body?: Record<string, Schema>;
  /** A body field's name at Microsoft when it can't be an argument's (conflictBehavior → @microsoft.graph.conflictBehavior). */
  bodyNames?: Record<string, string>;
  /** Values the tool itself reads (paging a long message, which pages of a file). */
  local?: Record<string, Schema>;
  /** Required arguments besides the path values. */
  required?: string[];
  /** What a 404 calls it ("that message"). */
  what?: string;
  /** A list Microsoft answers in pages: next_page reads on. */
  pages?: boolean;
  /** Extra headers (Prefer). */
  headers?: Record<string, string>;
  /** The query as sent, from what the call gave (a default $select, a $filter it builds). */
  prepare?(params: Json, a: Args): Json;
  /** A check of the body before anything is sent; throws ToolError for one that can't go. */
  check?(body: Json, a: Args): void;
  /** The answer as the AI reads it. Without it: a list with next_page, or the answer tidied. */
  after?(answer: Json, a: Args, g: Graph, path: string): unknown | Promise<unknown>;
}

const ODATA_NAMES: Record<string, string> = { select: "$select", filter: "$filter", orderby: "$orderby", top: "$top", skip: "$skip", search: "$search", expand: "$expand" };
const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** A Graph operation as a BuiltinTool: its arguments checked (and defaulted) before Microsoft is called. */
export function op(def: OpDef): BuiltinTool {
  const ids = [...def.path.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  const properties: Record<string, Schema> = {};
  for (const id of ids) properties[id] = { type: "string", pattern: SEGMENT_PATTERN, description: def.ids?.[id] ?? `The ${id.replace(/_id$/, "").replace(/_/g, " ")}'s id.` };
  Object.assign(properties, def.query ?? {}, def.body ?? {}, def.local ?? {});
  if (def.pages) properties.next_page = NEXT_PAGE;
  const required = [...ids, ...(def.required ?? [])];
  const schema: Schema = { type: "object", properties, required };
  return {
    name: def.name,
    description: def.description,
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
    needs: def.needs,
    async run(args, ctx) {
      const a = checkArgs(schema, args ?? {}, "");
      for (const id of ids) if (/^\.+$/.test(String(a[id]))) throw new ToolError(`${id} isn't in the expected form.`);
      const path = def.path.replace(PLACEHOLDER, (_m, id: string) => String(a[id]));
      const g = new Graph(ctx, def.needs);
      let params: Json = {};
      if (typeof a.next_page === "string") {
        params = Object.fromEntries(new URLSearchParams(a.next_page));
      } else {
        for (const name of Object.keys(def.query ?? {})) {
          if (a[name] === undefined) continue;
          params[def.queryNames?.[name] ?? ODATA_NAMES[name] ?? name] = a[name];
        }
        if (def.prepare) params = def.prepare(params, a);
      }
      let json: Json | undefined;
      if (def.body) {
        json = {};
        for (const name of Object.keys(def.body)) if (a[name] !== undefined) json[def.bodyNames?.[name] ?? name] = a[name];
        def.check?.(json, a);
        if (def.method === "PATCH" && !Object.keys(json).length) throw new ToolError("Say what to change.");
      }
      // A calendar read's times in the zone asked for (Graph's Prefer header).
      const zone: Record<string, string> = typeof a.time_zone === "string" ? { Prefer: `outlook.timezone="${a.time_zone.replace(/["\\\r\n]/g, "")}"` } : {};
      const answer = await g.json(def.method, path, { params, json, what: def.what, headers: { ...def.headers, ...zone } });
      if (def.after) return def.after(answer, a, g, path);
      if (!Object.keys(answer).length) return { done: true };
      return Array.isArray(answer.value) ? listed(answer) : tidy(answer);
    },
  };
}
