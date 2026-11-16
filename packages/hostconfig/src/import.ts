// Turn an AI app's connection entry into a Ringkeeper connection.
import { isDeepStrictEqual } from "node:util";
import { looksSecret, type ConnectionInput, type FieldInput } from "@ringkeeper/gateway";
import { HOST_LABELS, type HostId } from "./hosts.js";

export const RINGKEEPER_ENTRY = "ringkeeper-connect";

export interface Service {
  id: string;
  label: string;
}

const SERVICES: Array<Service & { match: RegExp }> = [
  { id: "n8n", label: "n8n", match: /n8n/i },
  { id: "airtable", label: "Airtable", match: /airtable/i },
  { id: "notion", label: "Notion", match: /notion/i },
  { id: "supabase", label: "Supabase", match: /supabase/i },
  { id: "stripe", label: "Stripe", match: /stripe/i },
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
export function expand(text: string, host: HostId, ctx: MapContext): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  let value = text;
  if (host === "cursor") {
    value = value.replace(/\$\{(env:([A-Za-z_][A-Za-z0-9_]*)|userHome|pathSeparator|\/|workspaceFolder|workspaceFolderBasename)\}/g, (whole, token: string, envName?: string) => {
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
  } else if (host === "claude-code") {
    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, envName: string, fallback?: string) => {
      const v = ctx.env[envName];
      if (v !== undefined) return v;
      if (fallback !== undefined) return fallback;
      unresolved.push(envName);
      return whole;
    });
  }
  return { value, unresolved };
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

export function mapEntry(name: string, raw: unknown, host: HostId, ctx: MapContext): Mapped {
  const app = HOST_LABELS[host];
  const warnings: string[] = [];
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
  host: HostId;
  name: string;
  value: unknown;
}

export interface Candidate extends Mapped {
  /** Stable key for the UI: one candidate can come from several apps. */
  key: string;
  name: string;
  sources: Array<{ host: HostId; name: string }>;
}

/**
 * Merge what was found across apps: the same connection set up identically
 * in two apps becomes one; same name but different settings stays separate,
 * named after the app.
 */
export function buildCandidates(found: FoundEntry[], ctx: MapContext): Candidate[] {
  const out: Candidate[] = [];
  for (const f of found) {
    if (f.name === RINGKEEPER_ENTRY) continue;
    const same = out.find((c) => c.sources.some((s) => s.name === f.name) && isDeepStrictEqual(rawOf(found, c.sources[0]!), f.value));
    if (same) {
      same.sources.push({ host: f.host, name: f.name });
      continue;
    }
    const clash = out.some((c) => c.name === f.name);
    const mapped = mapEntry(f.name, f.value, f.host, ctx);
    const name = clash ? `${f.name} (${HOST_LABELS[f.host]})` : f.name;
    if (mapped.input) mapped.input = { ...mapped.input, name };
    out.push({ ...mapped, key: `${f.host}:${f.name}`, name, sources: [{ host: f.host, name: f.name }] });
  }
  return out;
}

function rawOf(found: FoundEntry[], src: { host: HostId; name: string }): unknown {
  return found.find((f) => f.host === src.host && f.name === src.name)?.value;
}
