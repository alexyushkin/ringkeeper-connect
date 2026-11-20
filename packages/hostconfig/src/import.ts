// Turn an AI app's connection entry into a Ringkeeper connection.
import { isDeepStrictEqual } from "node:util";
import { looksSecret, type ConnectionInput, type FieldInput } from "@ringkeeper/gateway";
import { SOURCE_LABELS, VARIABLE_SYNTAX, type SourceId } from "./sources.js";

export const RINGKEEPER_ENTRY = "ringkeeper-connect";

export interface Service {
  id: string;
  label: string;
}

/**
 * Services we can recognise by name or address. Ids match the catalog's, so an
 * extension or web connector for one can open its catalog tool. More specific
 * patterns first.
 */
const SERVICES: Array<Service & { match: RegExp }> = [
  { id: "n8n", label: "n8n", match: /n8n/i },
  { id: "airtable", label: "Airtable", match: /airtable/i },
  { id: "notion", label: "Notion", match: /notion/i },
  { id: "supabase", label: "Supabase", match: /supabase/i },
  { id: "neon", label: "Neon", match: /\bneon(tech|\.tech|-mcp|db)?\b|mcp\.neon/i },
  { id: "stripe", label: "Stripe", match: /stripe/i },
  { id: "paypal", label: "PayPal", match: /paypal/i },
  { id: "netlify", label: "Netlify", match: /netlify/i },
  { id: "apollo", label: "Apollo", match: /apollo\.io|\bapollo\b/i },
  { id: "leadfeeder", label: "Leadfeeder", match: /leadfeeder|dealfront/i },
  { id: "upwork", label: "Upwork", match: /upwork/i },
  { id: "retell", label: "Retell AI", match: /retell/i },
  { id: "elevenlabs", label: "ElevenLabs", match: /elevenlabs|eleven-labs/i },
  { id: "gohighlevel", label: "GoHighLevel", match: /gohighlevel|highlevel|leadconnector/i },
  { id: "pipedrive", label: "Pipedrive", match: /pipedrive/i },
  { id: "monday", label: "monday.com", match: /monday\.com|\bmonday\b/i },
  { id: "close", label: "Close", match: /close\.com|close-?crm|close-mcp/i },
  { id: "klaviyo", label: "Klaviyo", match: /klaviyo/i },
  { id: "meta-ads", label: "Meta Ads", match: /meta[-_ ]?ads|facebook[-_ ]?ads|mcp\.facebook\.com/i },
  { id: "resend", label: "Resend", match: /resend/i },
  { id: "wordpress-com", label: "WordPress.com", match: /wordpress\.com|wpcom/i },
  { id: "wordpress", label: "WordPress", match: /wordpress|wp-json/i },
  { id: "webflow", label: "Webflow", match: /webflow/i },
  { id: "wix", label: "Wix", match: /\bwix\b/i },
  { id: "trello", label: "Trello", match: /trello/i },
  { id: "basecamp", label: "Basecamp", match: /basecamp|37signals/i },
  { id: "canva", label: "Canva", match: /canva\b|canva\./i },
  { id: "calendly", label: "Calendly", match: /calendly/i },
  { id: "calcom", label: "Cal.com", match: /cal\.com|\bcalcom\b/i },
  { id: "tavily", label: "Tavily", match: /tavily/i },
  { id: "apify", label: "Apify", match: /apify/i },
  { id: "hubspot", label: "HubSpot", match: /hubspot/i },
  { id: "github", label: "GitHub", match: /github/i },
  { id: "slack", label: "Slack", match: /slack/i },
  { id: "linear", label: "Linear", match: /linear/i },
  { id: "asana", label: "Asana", match: /asana/i },
  { id: "atlassian", label: "Jira / Confluence", match: /atlassian|jira|confluence/i },
  { id: "shopify", label: "Shopify", match: /shopify/i },
  { id: "google", label: "Google", match: /google|gmail|gdrive|gsheets/i },
  { id: "zapier", label: "Zapier", match: /zapier/i },
  { id: "make", label: "Make", match: /\bmake\.com\b|integromat/i },
];

/** Guess which service a connection is for, from its name and how it runs. */
export function detectService(name: string, value: unknown): Service | undefined {
  const v = (value ?? {}) as Record<string, unknown>;
  const hay = [name, v.command, ...(Array.isArray(v.args) ? v.args : []), v.url].filter((x) => typeof x === "string").join(" ");
  const hit = SERVICES.find((s) => s.match.test(hay));
  return hit ? { id: hit.id, label: hit.label } : undefined;
}

export interface MapContext {
  env: NodeJS.ProcessEnv;
  home: string;
  pathSeparator: string;
}

/** Expand the variable syntax each app supports. Returns null if something can't be resolved here. */
export function expand(text: string, host: SourceId, ctx: MapContext): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  let value = text;
  const syntax = VARIABLE_SYNTAX[host];
  if (syntax === "cursor") {
    // ${input:...} is asked for by the app itself, so it can't be known here.
    value = value.replace(/\$\{(env:([A-Za-z_][A-Za-z0-9_]*)|input:[^}]+|userHome|pathSeparator|\/|workspaceFolder|workspaceFolderBasename)\}/g, (whole, token: string, envName?: string) => {
      if (envName) {
        const v = ctx.env[envName];
        if (v === undefined) unresolved.push(envName);
        return v ?? whole;
      }
      if (token === "userHome") return ctx.home;
      if (token === "pathSeparator" || token === "/") return ctx.pathSeparator;
      unresolved.push(token);
      return whole;
    });
  } else if (syntax === "shell") {
    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, envName: string, fallback?: string) => {
      const v = ctx.env[envName];
      if (v !== undefined) return v;
      if (fallback !== undefined) return fallback;
      unresolved.push(envName);
      return whole;
    });
  } else if (syntax === "continue") {
    // Continue's secrets live in its own account or .env files.
    value = value.replace(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) => {
      unresolved.push(name);
      return whole;
    });
  }
  return { value, unresolved };
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Each app writes a connection a little differently: turn it into one shape
 * ({ type, command, args, env, url, headers, disabled }) before mapping.
 */
export function normalizeEntry(host: SourceId, raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const v: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  // Cline (as its command-line tool writes it): { transport: { type, ... }, disabled, ... }.
  if (host === "cline" && v.transport && typeof v.transport === "object") Object.assign(v, v.transport as object);
  // Older Cline and Roo Code: transportType.
  if (v.type === undefined && typeof v.transportType === "string") v.type = v.transportType;
  // Windsurf, Devin and Antigravity: serverUrl.
  if (v.url === undefined && typeof v.serverUrl === "string") v.url = v.serverUrl;
  // Gemini CLI: httpUrl means streamable HTTP; a plain url there means SSE.
  if (host === "gemini-cli") {
    if (typeof v.httpUrl === "string") {
      v.url = v.httpUrl;
      v.type = "http";
    } else if (typeof v.url === "string" && v.type === undefined) v.type = "sse";
  }
  // Devin and Windsurf: transport "http" | "sse".
  if (v.type === undefined && (v.transport === "http" || v.transport === "sse")) v.type = v.transport;
  // Cline: a web address without a type is SSE.
  if ((host === "cline" || host === "roo-code") && v.type === undefined && typeof v.url === "string") v.type = "sse";
  // Zed: command can be { path, args, env }.
  if (host === "zed" && v.command && typeof v.command === "object") {
    const c = v.command as Record<string, unknown>;
    v.command = c.path;
    if (v.args === undefined) v.args = c.args;
    if (v.env === undefined) v.env = c.env;
  }
  // Continue: headers live under requestOptions.
  if (host === "continue" && v.headers === undefined) v.headers = asRecord(v.requestOptions).headers;
  // Codex: enabled = false, and keys taken from environment variables by name.
  if (host === "codex") {
    if (v.enabled === false) v.disabled = true;
    const headers: Record<string, unknown> = { ...asRecord(v.http_headers) };
    for (const [h, envName] of Object.entries(asRecord(v.env_http_headers))) if (typeof envName === "string") headers[h] = `\${env:${envName}}`;
    if (typeof v.bearer_token_env_var === "string") headers.Authorization = `Bearer \${env:${v.bearer_token_env_var}}`;
    if (Object.keys(headers).length) v.headers = headers;
    if (typeof v.url === "string" && v.type === undefined) v.type = "http";
  }
  // Type spellings: streamableHttp, streamable-http, http; stdio, local.
  if (typeof v.type === "string") {
    const t = v.type.toLowerCase();
    v.type = t === "streamablehttp" || t === "streamable-http" || t === "streamable_http" ? "http" : t === "local" ? "stdio" : t;
  }
  return v;
}

/** Long random-looking values are almost always keys even when the name doesn't say so. */
function valueLooksSecret(v: string): boolean {
  return v.length >= 20 && /^[A-Za-z0-9_\-.=+/:]+$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !/^https?:/i.test(v);
}

export interface Mapped {
  input?: ConnectionInput;
  /** Why it can't be brought in (plain language). */
  problem?: string;
  warnings: string[];
  service?: Service;
}

export function mapEntry(name: string, original: unknown, host: SourceId, ctx: MapContext): Mapped {
  const app = SOURCE_LABELS[host];
  const warnings: string[] = [];
  const raw = normalizeEntry(host, original);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { problem: `${name} in ${app} isn't set up in a way Ringkeeper Connect understands, so it was left there.`, warnings };
  }
  const v = raw as Record<string, unknown>;
  const service = detectService(name, v);
  if (v.disabled === true) warnings.push(`${name} is turned off in ${app}. It will be on in Ringkeeper Connect.`);

  const type = typeof v.type === "string" ? v.type.toLowerCase() : undefined;
  const fields = (obj: unknown): { fields: FieldInput[]; missing: string[] } => {
    const out: FieldInput[] = [];
    const missing: string[] = [];
    if (obj && typeof obj === "object") {
      for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof val !== "string") continue;
        const { value, unresolved } = expand(val, host, ctx);
        if (unresolved.length) {
          missing.push(k);
          out.push({ name: k, secret: true });
        } else {
          out.push({ name: k, value, secret: looksSecret(k) || valueLooksSecret(value) });
        }
      }
    }
    return { fields: out, missing };
  };

  if (type === "ws") {
    return { problem: `${name} uses a kind of connection Ringkeeper Connect doesn't support yet, so it was left in ${app}.`, warnings, service };
  }

  const isRemote = type === "http" || type === "streamable-http" || type === "sse" || (type === undefined && typeof v.url === "string" && !v.command);
  if (isRemote) {
    if (typeof v.url !== "string") return { problem: `${name} in ${app} has no web address, so it was left there.`, warnings, service };
    const url = expand(v.url, host, ctx);
    if (url.unresolved.length) {
      return { problem: `${name}'s web address uses ${url.unresolved.join(", ")}, which isn't set on this computer, so it was left in ${app}.`, warnings, service };
    }
    const h = fields(v.headers);
    if (h.missing.length) warnings.push(`${name} needs ${h.missing.join(" and ")}: add it in Ringkeeper Connect.`);
    if (v.oauth || v.headersHelper) warnings.push(`${name} signs in a way Ringkeeper Connect can't copy yet; you may need to sign in again.`);
    return {
      input: { kind: "remote", name, url: url.value, fields: h.fields, ...(type === "sse" ? { transport: "sse" as const } : {}) },
      warnings,
      service,
    };
  }

  if (typeof v.command !== "string" || !v.command.trim()) {
    return { problem: `${name} in ${app} doesn't say what to run, so it was left there.`, warnings, service };
  }
  const cmd = expand(v.command, host, ctx);
  const args: string[] = [];
  const argProblems: string[] = [...cmd.unresolved];
  for (const a of Array.isArray(v.args) ? v.args : []) {
    if (typeof a !== "string") continue;
    const e = expand(a, host, ctx);
    argProblems.push(...e.unresolved);
    args.push(e.value);
  }
  if (argProblems.some((p) => p.startsWith("workspaceFolder"))) {
    return { problem: `${name} only works inside a project in ${app}, so it was left there.`, warnings, service };
  }
  if (argProblems.length) {
    return {
      problem: `${name} relies on ${[...new Set(argProblems)].join(", ")}, which isn't set on this computer, so it was left in ${app}.`,
      warnings,
      service,
    };
  }
  const e = fields(v.env);
  if (e.missing.length) warnings.push(`${name} needs ${e.missing.join(" and ")}: add it in Ringkeeper Connect.`);
  return { input: { kind: "local", name, command: cmd.value, args, fields: e.fields }, warnings, service };
}

export interface FoundEntry {
  host: SourceId;
  name: string;
  value: unknown;
}

export interface Candidate extends Mapped {
  /** Stable key for the UI: one candidate can come from several apps. */
  key: string;
  name: string;
  sources: Array<{ host: SourceId; name: string }>;
}

/** What a connection does, whatever app it was written for: its mapped settings without the name. */
function essence(m: Mapped): string | undefined {
  if (!m.input) return undefined;
  const { name: _name, ...rest } = m.input;
  return JSON.stringify(rest);
}

/**
 * Merge what was found across apps: the same connection set up the same way
 * in several apps (even when each app writes it differently) becomes one;
 * same name but different settings stays separate, named after the app.
 */
export function buildCandidates(found: FoundEntry[], ctx: MapContext): Candidate[] {
  const out: Array<Candidate & { essence?: string; raw: unknown }> = [];
  for (const f of found) {
    if (f.name === RINGKEEPER_ENTRY) continue;
    const mapped = mapEntry(f.name, f.value, f.host, ctx);
    const ess = essence(mapped);
    const same = out.find(
      (c) => c.sources.some((s) => s.name === f.name) && ((ess !== undefined && c.essence === ess) || isDeepStrictEqual(c.raw, f.value)),
    );
    if (same) {
      same.sources.push({ host: f.host, name: f.name });
      continue;
    }
    const clash = out.some((c) => c.name === f.name);
    const name = clash ? `${f.name} (${SOURCE_LABELS[f.host]})` : f.name;
    if (mapped.input) mapped.input = { ...mapped.input, name };
    out.push({ ...mapped, key: `${f.host}:${f.name}`, name, sources: [{ host: f.host, name: f.name }], essence: ess, raw: f.value });
  }
  return out.map(({ essence: _e, raw: _r, ...c }) => c);
}
