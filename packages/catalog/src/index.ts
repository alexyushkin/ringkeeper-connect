// The catalog of services Ringkeeper Connect knows how to connect. The data
// lives in catalog.json (checked against each vendor's docs; see "checked");
// this file validates it and turns a user's answers into a connection.
import type { ConnectionInput, FieldInput } from "@ringkeeper/gateway/store";
import data from "../catalog.json" with { type: "json" };

export interface CatalogField {
  id: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** "Where to find this" link. */
  where?: { label: string; url: string };
  /** The value must match this (after trimming). */
  pattern?: string;
  patternHint?: string;
  /** Values that are clearly the wrong kind of key, each with its own explanation. */
  reject?: Array<{ pattern: string; message: string }>;
  transform?: "n8n-mcp-url";
}

interface OptionBase {
  id: string;
  label: string;
  recommended?: boolean;
  fields: CatalogField[];
  auth?: "oauth";
  /** Set by the app when this build doesn't have the registered app the option needs. */
  unavailable?: boolean;
  /** Set by the app: the apps this sign-in can go through (ours, and the user's own), the first being the default. */
  signInApps?: Array<{ id: string; name: string }>;
  /** Sign in through Ringkeeper Connect's own registered app with this vendor (it doesn't let apps register themselves). */
  app?: RegisteredAppId;
  /** Permissions to ask for, space-separated (always, on top of any ticked below). */
  scope?: string;
  /** What the user can let the AI do, one tick box each; each adds its permissions to the sign-in. */
  access?: AccessChoice[];
  /** A pasted key the app can check with the vendor ("Test connection"), and how. */
  check?: KeyCheck;
}

/** Keys the app knows how to check with their vendor. */
export const KEY_CHECKS = ["meta-token"] as const;
export type KeyCheck = (typeof KEY_CHECKS)[number];
/** The setting where the app keeps when a checked key stops working (ISO date; not secret). */
export const KEY_EXPIRES_SETTING = "RINGKEEPER_KEY_EXPIRES";

/** One tick box: a thing the AI may do, and the vendor permission it needs. */
export interface AccessChoice {
  id: string;
  label: string;
  /** The vendor permission (scope) it needs. */
  scope: string;
  /** Ticked to begin with. */
  default?: boolean;
  /** A warning shown next to it. */
  note?: string;
}

/** Ringkeeper Connect's own tools program (packages/tools): args[0] names the service. */
export const BUILTIN_COMMAND = "ringkeeper-tools";
/** The setting that tells the tools program which tick boxes were ticked (comma-separated). */
export const ACCESS_SETTING = "RINGKEEPER_ACCESS";

export interface RemoteOption extends OptionBase {
  kind: "remote";
  /** May contain {{FIELD}} placeholders. */
  url: string;
  /** Added to the address; empty values are left out. */
  query?: Record<string, string>;
  /** Sent with every request; may contain {{FIELD}} placeholders. */
  headers?: Record<string, string>;
}

/** Vendors Ringkeeper Connect has registered apps with. */
/** "meta" is always the user's own Meta app: Ringkeeper Connect has none (its secret would ship in every copy). */
export const REGISTERED_APPS = ["google", "microsoft", "meta"] as const;
export type RegisteredAppId = (typeof REGISTERED_APPS)[number];

export interface LocalOption extends OptionBase {
  kind: "local";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type CatalogOption = RemoteOption | LocalOption;

/** How "Add a tool" groups the tools, in this order. */
export const GROUPS = [
  "Data",
  "Automations",
  "CRM and sales",
  "Marketing and email",
  "Websites",
  "Payments",
  "Accounting",
  "Work and projects",
  "Scheduling",
  "Developers",
  "Voice and research",
  "Other",
] as const;

export interface CatalogService {
  id: string;
  name: string;
  group: (typeof GROUPS)[number];
  description: string;
  /** Short facts shown on the tile and before sign-in ("Paid plan", "Uses credits"). */
  tags?: string[];
  /** Not yet checked with a real sign-in. */
  beta?: boolean;
  notes?: string[];
  options: CatalogOption[];
}

export interface Catalog {
  version: 1;
  checked: string;
  services: CatalogService[];
}

export class CatalogInputError extends Error {}

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;
/** {{basic:USER:PASSWORD}}: the two answers as an HTTP Basic credential (base64 of user:password). */
const BASIC = /\{\{basic:([A-Z0-9_]+):([A-Z0-9_]+)\}\}/g;

/** Every field a template refers to. */
function refs(template: string): string[] {
  return [...[...template.matchAll(PLACEHOLDER)].map((m) => m[1]!), ...[...template.matchAll(BASIC)].flatMap((m) => [m[1]!, m[2]!])];
}

/** Checks the catalog's own consistency; used by the tests and at startup. */
export function validateCatalog(c: Catalog): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const s of c.services) {
    if (ids.has(s.id)) problems.push(`duplicate service ${s.id}`);
    ids.add(s.id);
    if (!s.options.length) problems.push(`${s.id}: no options`);
    if (s.options.filter((o) => o.recommended).length > 1) problems.push(`${s.id}: more than one recommended option`);
    if (!(GROUPS as readonly string[]).includes(s.group)) problems.push(`${s.id}: unknown group ${String(s.group)}`);
    for (const t of s.tags ?? []) if (!t.trim() || t.length > 24) problems.push(`${s.id}: tag "${t}" must be short`);
    for (const o of s.options) {
      const fieldIds = new Set(o.fields.map((f) => f.id));
      const templates = o.kind === "remote" ? [o.url, ...Object.values(o.query ?? {}), ...Object.values(o.headers ?? {})] : [o.command, ...o.args, ...Object.values(o.env ?? {})];
      for (const t of templates) for (const id of refs(t)) if (!fieldIds.has(id)) problems.push(`${s.id}/${o.id}: {{${id}}} has no field`);
      if (o.kind === "remote" && !o.url.includes("{{") && !o.url.startsWith("https://")) problems.push(`${s.id}/${o.id}: address must be https`);
      if (o.app && (o.auth !== "oauth" || !(REGISTERED_APPS as readonly string[]).includes(o.app))) problems.push(`${s.id}/${o.id}: registered app needs sign-in and a known app`);
      // A program can't register itself with a vendor: its sign-in is always through our app.
      if (o.kind === "local" && o.auth === "oauth" && !o.app) problems.push(`${s.id}/${o.id}: a program's sign-in needs a registered app`);
      if (o.access) {
        const seen = new Set<string>();
        for (const a of o.access) {
          if (seen.has(a.id) || !/^[a-z][a-z0-9_]*$/.test(a.id)) problems.push(`${s.id}/${o.id}: access "${a.id}" must be unique, lower case and plain`);
          seen.add(a.id);
          if (!a.scope.trim() || !a.label.trim()) problems.push(`${s.id}/${o.id}: access "${a.id}" needs a label and a permission`);
        }
        if (!o.access.some((a) => a.default)) problems.push(`${s.id}/${o.id}: tick at least one access to begin with`);
        if (o.kind !== "local" || o.command !== BUILTIN_COMMAND) problems.push(`${s.id}/${o.id}: tick boxes are only for Ringkeeper Connect's own tools`);
      }
      if (o.kind === "local" && o.command === BUILTIN_COMMAND && !o.args[0]) problems.push(`${s.id}/${o.id}: name the built-in service`);
      if (o.check && !(KEY_CHECKS as readonly string[]).includes(o.check)) problems.push(`${s.id}/${o.id}: unknown key check ${String(o.check)}`);
      if (o.check && !o.fields.some((f) => f.secret && f.required)) problems.push(`${s.id}/${o.id}: a key check needs a required secret field`);
      if (o.kind === "local") {
        // The command and arguments are saved as plain text: a secret goes in `env` (kept secret)
        // and, if the program wants it as an argument, is referred to there as ${NAME}.
        const secrets = new Set(o.fields.filter((f) => f.secret).map((f) => f.id));
        for (const t of [o.command, ...o.args]) for (const id of refs(t)) if (secrets.has(id)) problems.push(`${s.id}/${o.id}: secret {{${id}}} in the command or arguments`);
        for (const a of o.args) for (const m of a.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (!(m[1]! in (o.env ?? {}))) problems.push(`${s.id}/${o.id}: \${${m[1]}} isn't one of its settings`);
      }
      for (const f of o.fields) {
        if (f.where && !f.where.url.startsWith("https://")) problems.push(`${s.id}/${o.id}/${f.id}: link must be https`);
        for (const r of [f.pattern, ...(f.reject ?? []).map((x) => x.pattern)]) {
          if (!r) continue;
          try {
            new RegExp(r);
          } catch {
            problems.push(`${s.id}/${o.id}/${f.id}: bad pattern ${r}`);
          }
        }
      }
    }
  }
  return problems;
}

export const catalog: Catalog = data as Catalog;

export function findService(id: string): CatalogService | undefined {
  return catalog.services.find((s) => s.id === id);
}

/** n8n: accept the plain address or the full MCP address, and return the MCP address. */
function n8nMcpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new CatalogInputError("That n8n address doesn't look right. It should look like https://yourname.app.n8n.cloud");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new CatalogInputError("Use the n8n address that starts with https://");
  }
  return `${url.origin}/mcp-server/http`;
}

/** Check one answer; returns the cleaned value. */
export function checkField(field: CatalogField, raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) {
    if (field.required) throw new CatalogInputError(`Fill in "${field.label}".`);
    return "";
  }
  for (const r of field.reject ?? []) if (new RegExp(r.pattern).test(value)) throw new CatalogInputError(r.message);
  if (field.pattern && !new RegExp(field.pattern).test(value)) throw new CatalogInputError(field.patternHint ?? `"${field.label}" doesn't look right.`);
  if (field.transform === "n8n-mcp-url") return n8nMcpUrl(value);
  return value;
}

function fill(template: string, values: Record<string, string>): string {
  return template
    .replace(BASIC, (_, user: string, pass: string) => Buffer.from(`${values[user] ?? ""}:${values[pass] ?? ""}`, "utf8").toString("base64"))
    .replace(PLACEHOLDER, (_, id: string) => values[id] ?? "");
}

/**
 * Turn the user's answers into a connection for the client store. Keys stay
 * marked secret; headers that contain a secret become secret settings.
 */
export function buildConnection(serviceId: string, optionId: string, answers: Record<string, string>, name?: string, access?: string[]): ConnectionInput {
  const service = findService(serviceId);
  const option = service?.options.find((o) => o.id === optionId);
  if (!service || !option) throw new CatalogInputError("That service isn't in the catalog anymore. Update Ringkeeper Connect.");

  const values: Record<string, string> = {};
  for (const f of option.fields) values[f.id] = checkField(f, answers[f.id]);
  const secretIds = new Set(option.fields.filter((f) => f.secret).map((f) => f.id));
  const usesSecret = (t: string) => refs(t).some((id) => secretIds.has(id));
  const connName = (name ?? service.name).trim() || service.name;

  if (option.kind === "remote") {
    const url = new URL(fill(option.url, values));
    for (const [k, t] of Object.entries(option.query ?? {})) {
      const v = fill(t, values);
      if (v) url.searchParams.set(k, v);
    }
    const fields: FieldInput[] = Object.entries(option.headers ?? {}).map(([k, t]) => ({ name: k, value: fill(t, values), secret: usesSecret(t) }));
    return {
      kind: "remote",
      name: connName,
      url: url.toString(),
      fields,
      ...(option.auth ? { auth: option.auth } : {}),
      ...(option.app ? { oauthApp: option.app } : {}),
      ...(option.scope ? { scope: option.scope } : {}),
    };
  }
  const fields: FieldInput[] = Object.entries(option.env ?? {}).map(([k, t]) => ({ name: k, value: fill(t, values), secret: usesSecret(t) }));
  let scope = option.scope;
  if (option.access) {
    const chosen = chosenAccess(option.access, access);
    fields.push({ name: ACCESS_SETTING, value: chosen.map((a) => a.id).join(","), secret: false });
    // A pasted key has whatever permissions it was made with: only a sign-in asks for them.
    if (option.auth) scope = scopeFor(option.scope, chosen);
  }
  return {
    kind: "local",
    name: connName,
    command: fill(option.command, values),
    args: option.args.map((a) => fill(a, values)),
    fields,
    ...(option.auth ? { auth: option.auth } : {}),
    ...(option.app ? { oauthApp: option.app } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** The ticked boxes, in the catalog's order (the defaults when none were sent). */
export function chosenAccess(choices: AccessChoice[], ids: string[] | undefined): AccessChoice[] {
  const wanted = new Set(ids ?? choices.filter((a) => a.default).map((a) => a.id));
  for (const id of wanted) if (!choices.some((a) => a.id === id)) throw new CatalogInputError("That permission isn't offered anymore. Update Ringkeeper Connect.");
  const chosen = choices.filter((a) => wanted.has(a.id));
  if (!chosen.length) throw new CatalogInputError("Tick at least one thing the AI may do.");
  return chosen;
}

/** The permissions to sign in with: the fixed ones plus each ticked box's, without repeats. */
export function scopeFor(base: string | undefined, chosen: AccessChoice[]): string {
  return [...new Set([...(base ?? "").split(/\s+/), ...chosen.flatMap((a) => a.scope.split(/\s+/))].filter(Boolean))].join(" ");
}
