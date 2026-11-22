// The user's clients and their connections. Saved to clients.json without
// any secret values; secrets go to the SecretStore and are referenced by key.
import fs from "node:fs";
import { readJson, writeJsonAtomic } from "../runtime.js";
import { EVERY_CLIENT_ID, type ConnectionConfig, type GatewayConfig } from "../config.js";
import { DEFAULT_DYNAMIC_HOSTS } from "../meta-tools.js";
import { DEFAULT_GUARD, isActionChoice, isClientGuard, type ActionChoice, type ClientGuard } from "../guard.js";
import type { SecretStore } from "./secrets.js";
import { signInEndsAt, type OAuthState, type OAuthStateStore } from "../oauth.js";
import type { CopyClient, CopyConnection, CopyField, CopyPayload } from "./copy.js";

// ---------- stored shapes ----------

/** A plain value, or a reference to a value kept in the SecretStore. */
export type StoredValue = { value: string } | { secret: string };

interface StoredBase {
  id: string;
  name: string;
  /** Which of its actions the AI apps get. Left out: all of them. */
  actions?: ActionChoice;
  /** Turned off: kept with its keys, not offered to the AI apps. */
  off?: true;
  /**
   * Copied from another client's tools (the name of that client) when this client was started
   * from it: not offered until the user has checked its settings are this client's and saved.
   */
  copiedFrom?: string;
}
export interface StoredLocalConnection extends StoredBase {
  kind: "local";
  command: string;
  args: string[];
  env: Record<string, StoredValue>;
  /** Signs in through a registered app (built-in tools): the program gets a fresh access token. */
  auth?: "oauth";
  oauthApp?: string;
  scope?: string;
}
export interface StoredRemoteConnection extends StoredBase {
  kind: "remote";
  url: string;
  /** "sse" for older servers; Streamable HTTP otherwise. */
  transport?: "sse";
  /** Signs in with OAuth instead of (or as well as) keys. */
  auth?: "oauth";
  /** Sign in through Ringkeeper Connect's registered app with this vendor (Google, Microsoft), and these permissions. */
  oauthApp?: string;
  scope?: string;
  headers: Record<string, StoredValue>;
}
export type StoredConnection = StoredLocalConnection | StoredRemoteConnection;

export interface StoredClient {
  id: string;
  name: string;
  connections: StoredConnection[];
  /** How much the AI may do for this client. Left out means the default (ask before deleting). */
  guard?: ClientGuard;
  /** Kept at the top of the list. */
  pinned?: true;
  /** Finished with for now: kept with its keys, but not in the list, never active, its tools not offered. */
  archived?: true;
  /** When it last became the active client (ms since 1970), for "Recent". */
  lastUsedAt?: number;
}

export interface Settings {
  /** Require a client name on every tool call in dynamic mode (decided in M2: on). */
  requireClientArg: boolean;
  /** Hosts that honour tools/list_changed; everything else gets fixed mode. */
  dynamicHosts: string[];
  /** The first-run setup (connecting AI apps) was completed or skipped. */
  setupDone: boolean;
  /** Start in the background when the user logs in, so AI apps can reach it. */
  startAtLogin: boolean;
  /** A keyboard shortcut, from anywhere, that opens the list of clients to switch to. Left out means on. */
  switchShortcut?: boolean;
  /** The "bring in what your apps already use" wizard was offered for an empty first client. */
  bringInOffered: boolean;
  /**
   * Catalog tools the user picked in the wizard (from Claude Desktop extensions
   * or web connectors) that still need a sign-in or key, per client.
   */
  pendingTools: Array<{ clientId: string; toolId: string }>;
  /** A tool was just signed in to for the first time: the window asks "Did it work?" until it's answered. */
  feedbackAsk?: { clientId: string; connectionId: string; serviceId: string };
  /** The answer per service in Add a tool, so each is asked about once: worked, had a problem, or no thanks. */
  toolFeedback?: Record<string, "worked" | "problem" | "skipped">;
  /**
   * The user's own registered apps (a Google app in their own Google Cloud project, or a
   * Microsoft app in their own Entra directory), for agencies past the 100 accounts Google
   * allows our app, a client whose IT admin only trusts their own apps, or their own name on
   * the sign-in. A Google app's secret is kept encrypted with the keys (ownAppSecretKey), not here.
   */
  ownApps?: OwnAppRecord[];
}

export interface OwnAppRecord {
  /** "google:<slug>", "microsoft:<slug>" or "meta:<slug>": what a connection's oauthApp names. */
  id: string;
  vendor: OwnAppVendor;
  name: string;
  clientId: string;
  /** Microsoft only: the directory it signs in to ("common" for any account). */
  tenant?: string;
}

export type OwnAppVendor = "google" | "microsoft" | "meta";

/** "Google", "Microsoft" or "Meta", from an app id ("google", "microsoft:agency"…), for messages. */
export function vendorName(appId: string): string {
  const vendor = appId.split(":")[0];
  return vendor === "microsoft" ? "Microsoft" : vendor === "meta" ? "Meta" : "Google";
}

/** Where an own app's client secret is kept. "~" never appears in a client's id, so removing a client can't touch it. */
export function ownAppSecretKey(appId: string): string {
  return `~apps/${appId}/secret`;
}

interface StoreFile {
  version: 1;
  activeClientId: string | null;
  clients: StoredClient[];
  /** Tools every client gets (id EVERY_CLIENT_ID). Not a client: never active, never in the list. */
  everyClient?: StoredClient;
  settings: Settings;
}

/** The name the tools for every client go by in messages ("Add a tool for every client"). */
export const EVERY_CLIENT_NAME = "every client";

/** The choice and switch a connection keeps through an edit. */
function kept(c: StoredConnection): { actions?: ActionChoice; off?: true; copiedFrom?: string } {
  return {
    ...(c.actions ? { actions: Array.isArray(c.actions) ? [...c.actions] : c.actions } : {}),
    ...(c.off ? { off: true as const } : {}),
    ...(c.copiedFrom ? { copiedFrom: c.copiedFrom } : {}),
  };
}

/** What a copy holds, shown before anything is brought in. */
export interface CopyPreview {
  clients: Array<{ name: string; tools: number; archived: boolean; /** A client with this name is here already. */ exists: boolean }>;
  everyClient: Array<{ name: string; exists: boolean }>;
  ownApps: Array<{ name: string; exists: boolean }>;
}

/** What bringing in a copy did. */
export interface CopyResult {
  /** Clients added, by the name they got here. */
  clients: string[];
  /** Clients added under a new name because the name was taken. */
  renamed: Array<{ from: string; to: string }>;
  /** Tools for every client added; ones already here by name are left out. */
  everyClient: string[];
  ownApps: string[];
}

export const DEFAULT_SETTINGS: Settings = { requireClientArg: true, dynamicHosts: [...DEFAULT_DYNAMIC_HOSTS], setupDone: false, startAtLogin: true, bringInOffered: false, pendingTools: [] };

// ---------- inputs and views (what the UI sends and sees) ----------

/** One environment variable or header. `value` undefined on update means "keep what's saved". */
export interface FieldInput {
  name: string;
  value?: string;
  secret: boolean;
}

export type ConnectionInput =
  | { kind: "local"; name: string; command: string; args: string[]; auth?: "oauth"; oauthApp?: string; scope?: string; fields: FieldInput[] }
  | { kind: "remote"; name: string; url: string; transport?: "sse"; auth?: "oauth"; oauthApp?: string; scope?: string; fields: FieldInput[] };

/** Secret values are never included; `isSet` says whether one is saved. */
export interface FieldView {
  name: string;
  secret: boolean;
  value?: string;
  isSet: boolean;
}

export type ConnectionView =
  | {
      kind: "local";
      id: string;
      name: string;
      command: string;
      args: string[];
      auth?: "oauth";
      oauthApp?: string;
      scope?: string;
      signedIn?: boolean;
      fields: FieldView[];
      missingKeys: string[];
      actions?: ActionChoice;
      off?: boolean;
      copiedFrom?: string;
      signInEndsAt?: number;
    }
  | {
      kind: "remote";
      id: string;
      name: string;
      url: string;
      transport?: "sse";
      auth?: "oauth";
      oauthApp?: string;
      scope?: string;
      /** For OAuth connections: a sign-in is saved. */
      signedIn?: boolean;
      fields: FieldView[];
      missingKeys: string[];
      /** Which of its actions the AI apps get. Left out: all of them. */
      actions?: ActionChoice;
      /** Turned off by the user. */
      off?: boolean;
      /** Copied from this client's tools and not checked yet: not offered until it's saved. */
      copiedFrom?: string;
      /** When the saved sign-in has to be done again (ms), where the service said so and it lasts more than a day. */
      signInEndsAt?: number;
    };

export interface ClientView {
  id: string;
  name: string;
  active: boolean;
  connections: ConnectionView[];
  /** How much the AI may do for this client. */
  guard: ClientGuard;
  pinned: boolean;
  archived: boolean;
  lastUsedAt?: number;
}

export class StoreError extends Error {}

/** Where a connection's OAuth sign-in is kept in the SecretStore. Deleted with the connection. */
/** The registered app and permissions of a sign-in connection, when it has them. */
function appOf(c: { oauthApp?: string; scope?: string } | { kind: string }): { oauthApp?: string; scope?: string } {
  const x = c as { oauthApp?: string; scope?: string };
  return { ...(x.oauthApp ? { oauthApp: x.oauthApp } : {}), ...(x.scope ? { scope: x.scope } : {}) };
}

export function oauthKey(clientId: string, connectionId: string): string {
  return `${clientId}/${connectionId}/~oauth`;
}

/** OAuth sign-ins stored encrypted, next to the keys. */
export function secretOAuthStore(secrets: SecretStore): OAuthStateStore {
  return {
    load: (key) => {
      const raw = secrets.get(key);
      return raw ? (JSON.parse(raw) as OAuthState) : undefined;
    },
    save: (key, state) => secrets.set(key, JSON.stringify(state)),
  };
}

/** Names that are almost always secrets; used to default the "keep secret" box. */
export function looksSecret(fieldName: string): boolean {
  return /key|token|secret|password|passwd|auth|credential|bearer|cookie|session/i.test(fieldName);
}

export function slug(name: string, fallback: string, max = 20): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop accents: "Ü" → "U"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max)
    .replace(/_+$/g, "");
  return s || fallback;
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Whether every permission in `scope` is already in `granted`. */
function within(scope: string | undefined, granted: string | undefined): boolean {
  const had = new Set((granted ?? "").split(/\s+/).filter(Boolean));
  return (scope ?? "").split(/\s+/).filter(Boolean).every((s) => had.has(s));
}

function fieldsOf(c: StoredConnection): Record<string, StoredValue> {
  return c.kind === "local" ? c.env : c.headers;
}

export class ClientStore {
  private data: StoreFile;
  private listeners = new Set<() => void>();

  constructor(
    private readonly path: string,
    private readonly secrets: SecretStore,
  ) {
    if (fs.existsSync(path)) {
      const file = readJson<StoreFile>(path);
      if (!file || file.version !== 1 || !Array.isArray(file.clients)) {
        // Never overwrite a file we can't read: the user's setup may be in it.
        throw new StoreError(
          `Ringkeeper Connect couldn't read your clients file (${path}). Nothing was changed. Restore it from a backup, or move it aside to start fresh.`,
        );
      }
      this.data = { ...file, settings: { ...DEFAULT_SETTINGS, ...(file.settings ?? {}) } };
    } else {
      this.data = { version: 1, activeClientId: null, clients: [], settings: { ...DEFAULT_SETTINGS } };
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(): void {
    writeJsonAtomic(this.path, this.data);
    for (const l of this.listeners) l();
  }

  // ---------- reading ----------

  get activeClientId(): string | null {
    return this.data.activeClientId;
  }

  get settings(): Settings {
    return { ...this.data.settings, dynamicHosts: [...this.data.settings.dynamicHosts] };
  }

  list(): ClientView[] {
    return this.data.clients.map((c) => this.viewClient(c));
  }

  /** The tools every client gets, shaped like a client so the same screens and actions work on them. */
  everyClient(): ClientView {
    return this.viewClient(this.data.everyClient ?? { id: EVERY_CLIENT_ID, name: EVERY_CLIENT_NAME, connections: [] });
  }

  /** The clients and, last, the tools for every client: everything that holds connections. */
  listAll(): ClientView[] {
    return [...this.list(), this.everyClient()];
  }

  /** One client, or the tools for every client, by id. */
  view(id: string): ClientView | undefined {
    return this.listAll().find((c) => c.id === id);
  }

  private viewClient(c: StoredClient): ClientView {
    return {
      id: c.id,
      name: c.name,
      active: c.id === this.data.activeClientId,
      connections: c.connections.map((conn) => this.viewConnection(conn)),
      guard: isClientGuard(c.guard) ? c.guard : DEFAULT_GUARD,
      pinned: !!c.pinned,
      archived: !!c.archived,
      ...(typeof c.lastUsedAt === "number" ? { lastUsedAt: c.lastUsedAt } : {}),
    };
  }

  private owners(): StoredClient[] {
    return this.data.everyClient ? [...this.data.clients, this.data.everyClient] : this.data.clients;
  }

  private oauthKeyFor(conn: StoredConnection): string {
    const owner = this.owners().find((c) => c.connections.includes(conn));
    return oauthKey(owner?.id ?? "", conn.id);
  }

  /** When a connection's saved sign-in ends, where that's known (see signInEndsAt). Never fails a view. */
  private signInEnds(conn: StoredConnection): { signInEndsAt?: number } {
    if (conn.auth !== "oauth") return {};
    try {
      const raw = this.secrets.get(this.oauthKeyFor(conn));
      const at = raw ? signInEndsAt(JSON.parse(raw) as OAuthState) : undefined;
      return at ? { signInEndsAt: at } : {};
    } catch {
      return {};
    }
  }

  private viewConnection(conn: StoredConnection): ConnectionView {
    const fields: FieldView[] = Object.entries(fieldsOf(conn)).map(([name, v]) =>
      "secret" in v ? { name, secret: true, isSet: this.secrets.has(v.secret) } : { name, secret: false, value: v.value, isSet: true },
    );
    const missingKeys = fields.filter((f) => !f.isSet).map((f) => f.name);
    return conn.kind === "local"
      ? {
          kind: "local",
          id: conn.id,
          name: conn.name,
          command: conn.command,
          args: [...conn.args],
          ...(conn.auth ? { auth: conn.auth, signedIn: this.secrets.has(this.oauthKeyFor(conn)) } : {}),
          ...appOf(conn),
          fields,
          missingKeys,
          ...kept(conn),
          ...this.signInEnds(conn),
        }
      : {
          kind: "remote",
          id: conn.id,
          name: conn.name,
          url: conn.url,
          ...(conn.transport ? { transport: conn.transport } : {}),
          ...(conn.auth ? { auth: conn.auth, signedIn: this.secrets.has(this.oauthKeyFor(conn)) } : {}),
          ...appOf(conn),
          fields,
          missingKeys,
          ...kept(conn),
          ...this.signInEnds(conn),
        };
  }

  /**
   * The gateway's view: every connection with its secrets filled in. Kept in
   * memory only. Connections with a missing key carry `missingKeys` instead of
   * being started.
   */
  toGatewayConfig(): GatewayConfig {
    const every = this.data.everyClient?.connections ?? [];
    return {
      options: { requireClientArg: this.data.settings.requireClientArg, dynamicHosts: [...this.data.settings.dynamicHosts] },
      clients: this.data.clients.filter((c) => !c.archived).map((c) => ({
        id: c.id,
        name: c.name,
        guard: isClientGuard(c.guard) ? c.guard : DEFAULT_GUARD,
        connections: c.connections.map((conn) => this.gatewayConnection(c.id, conn)),
      })),
      ...(every.length ? { everyClient: every.map((conn) => this.gatewayConnection(EVERY_CLIENT_ID, conn)) } : {}),
    };
  }

  private gatewayConnection(ownerId: string, conn: StoredConnection): ConnectionConfig {
    const missing: string[] = [];
    const resolved: Record<string, string> = {};
    for (const [name, v] of Object.entries(fieldsOf(conn))) {
      if ("value" in v) resolved[name] = v.value;
      else {
        const s = this.secrets.get(v.secret);
        if (s === undefined) missing.push(name);
        else resolved[name] = s;
      }
    }
    const { copiedFrom, ...chosen } = kept(conn);
    const base = { id: conn.id, name: conn.name, ...(missing.length ? { missingKeys: missing } : {}), ...chosen, ...(copiedFrom ? { off: true } : {}) };
    const oauth =
      conn.auth === "oauth"
        ? {
            oauth: { key: oauthKey(ownerId, conn.id), ...(conn.oauthApp ? { app: conn.oauthApp } : {}), ...(conn.scope ? { scope: conn.scope } : {}) },
            needsSignIn: !this.secrets.has(oauthKey(ownerId, conn.id)),
          }
        : {};
    return conn.kind === "local"
      ? { ...base, kind: "local", command: conn.command, args: [...conn.args], env: resolved, ...oauth }
      : { ...base, kind: "remote", url: conn.url, ...(conn.transport ? { transport: conn.transport } : {}), ...oauth, headers: resolved };
  }

  // ---------- clients ----------

  private client(id: string): StoredClient {
    if (id === EVERY_CLIENT_ID) return (this.data.everyClient ??= { id: EVERY_CLIENT_ID, name: EVERY_CLIENT_NAME, connections: [] });
    const c = this.data.clients.find((x) => x.id === id);
    if (!c) throw new StoreError("That client no longer exists. Close this window and open it again.");
    return c;
  }

  /** A client, not the tools for every client. */
  private realClient(id: string): StoredClient {
    if (id === EVERY_CLIENT_ID) throw new StoreError("That's only possible for a client, not for the tools every client gets.");
    return this.client(id);
  }

  private checkClientName(name: string, exceptId?: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new StoreError("Give the client a name.");
    if (trimmed.length > 60) throw new StoreError("That name is too long. Keep it under 60 characters.");
    if (this.data.clients.some((c) => c.id !== exceptId && c.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new StoreError(`You already have a client called "${trimmed}". Pick a different name.`);
    }
    return trimmed;
  }

  /**
   * Add a client. With `likeId`, it starts with that client's tools and what the AI may do:
   * settings are copied, keys and sign-ins aren't, and each tool waits until it's been checked
   * (an address or setting may still be the other client's).
   */
  addClient(name: string, likeId?: string): ClientView {
    const clean = this.checkClientName(name);
    const like = likeId ? this.realClient(likeId) : undefined;
    const id = uniqueId(slug(clean, "client", 30), new Set(this.data.clients.map((c) => c.id)));
    const client: StoredClient = { id, name: clean, connections: [], ...(like?.guard ? { guard: like.guard } : {}) };
    if (like) {
      const taken = this.takenConnectionIds(client);
      for (const src of like.connections) {
        const connId = uniqueId(src.id, taken);
        taken.add(connId);
        const fields: Record<string, StoredValue> = {};
        for (const [n, v] of Object.entries(fieldsOf(src))) fields[n] = "value" in v ? { value: v.value } : { secret: this.secretKey(id, connId, n) };
        const { copiedFrom: _was, ...rest } = src;
        const copy: StoredConnection = src.kind === "local" ? { ...(rest as StoredLocalConnection), id: connId, args: [...src.args], env: fields } : { ...(rest as StoredRemoteConnection), id: connId, headers: fields };
        if (Array.isArray(src.actions)) copy.actions = [...src.actions];
        copy.copiedFrom = like.name;
        client.connections.push(copy);
      }
    }
    this.data.clients.push(client);
    if (this.data.activeClientId === null) {
      this.data.activeClientId = id;
      client.lastUsedAt = Date.now();
    }
    this.commit();
    return this.list().find((c) => c.id === id)!;
  }

  /** Renaming keeps the id, so tool names and saved keys stay stable. */
  renameClient(id: string, name: string): void {
    const c = this.realClient(id);
    c.name = this.checkClientName(name, id);
    this.commit();
  }

  /** How much the AI may do for this client: work freely, ask before deleting, or look only. */
  setClientGuard(id: string, guard: ClientGuard): void {
    const c = this.realClient(id);
    if (!isClientGuard(guard)) throw new StoreError("Choose one of the three options.");
    if ((c.guard ?? DEFAULT_GUARD) === guard) return;
    c.guard = guard;
    this.commit();
  }

  removeClient(id: string): void {
    this.realClient(id);
    this.data.clients = this.data.clients.filter((c) => c.id !== id);
    this.secrets.deletePrefix(`${id}/`);
    if (this.data.activeClientId === id) this.data.activeClientId = this.data.clients.find((c) => !c.archived)?.id ?? null;
    this.commit();
  }

  setActiveClient(id: string): void {
    const c = this.realClient(id);
    if (c.archived) throw new StoreError(`${c.name} is archived. Bring it back first, then switch to it.`);
    if (this.data.activeClientId === id) return;
    this.data.activeClientId = id;
    c.lastUsedAt = Date.now();
    this.commit();
  }

  /** Keep a client at the top of the list, or not. */
  setClientPinned(id: string, pinned: boolean): void {
    const c = this.realClient(id);
    if (!!c.pinned === pinned) return;
    if (pinned) c.pinned = true;
    else delete c.pinned;
    this.commit();
  }

  /**
   * Archive a client you're finished with for now (its tools and keys are kept, the AI apps
   * don't see it), or bring it back. The active client can't be archived: switching for the
   * user would change every chat without asking.
   */
  setClientArchived(id: string, archived: boolean): void {
    const c = this.realClient(id);
    if (!!c.archived === archived) return;
    if (archived) {
      if (this.data.activeClientId === id) {
        throw new StoreError(`${c.name} is the active client. Switch to another client first, then archive ${c.name}.`);
      }
      c.archived = true;
      delete c.pinned;
    } else delete c.archived;
    this.commit();
  }

  updateSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.commit();
  }

  // ---------- connections ----------

  /**
   * Ids a new connection of this owner can't have. The AI apps see a client's tools and the
   * tools for every client together, by connection id, so those two never share one.
   */
  private takenConnectionIds(owner: StoredClient): Set<string> {
    const others = owner.id === EVERY_CLIENT_ID ? this.data.clients : this.data.everyClient ? [this.data.everyClient] : [];
    return new Set([owner, ...others].flatMap((c) => c.connections.map((x) => x.id)));
  }

  private secretKey(clientId: string, connId: string, field: string): string {
    return `${clientId}/${connId}/${field}`;
  }

  private validateConnection(input: ConnectionInput, client: StoredClient, exceptId?: string): string {
    const name = input.name.trim();
    if (!name) throw new StoreError("Give the connection a name, for example \"n8n\".");
    if (client.connections.some((c) => c.id !== exceptId && c.name.toLowerCase() === name.toLowerCase())) {
      throw new StoreError(`${client.name} already has a connection called "${name}". Pick a different name.`);
    }
    if (input.kind === "local" && !input.command.trim()) throw new StoreError("Fill in the program to run.");
    if (input.kind === "remote") {
      let url: URL;
      try {
        url = new URL(input.url.trim());
      } catch {
        throw new StoreError("That web address doesn't look right. It should start with https://");
      }
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        throw new StoreError("Use a web address that starts with https:// so your keys are sent securely.");
      }
    }
    const seen = new Set<string>();
    for (const f of input.fields) {
      const n = f.name.trim();
      if (!n) throw new StoreError("Every setting needs a name.");
      if (seen.has(n)) throw new StoreError(`"${n}" is listed twice. Remove one of them.`);
      seen.add(n);
    }
    return name;
  }

  /** Turn field inputs into stored values, saving secrets. Existing secrets are kept when no new value is given. */
  private storeFields(
    clientId: string,
    connId: string,
    fields: FieldInput[],
    previous: Record<string, StoredValue> = {},
  ): Record<string, StoredValue> {
    const out: Record<string, StoredValue> = {};
    for (const f of fields) {
      const name = f.name.trim();
      const key = this.secretKey(clientId, connId, name);
      const prev = previous[name];
      if (f.secret) {
        if (f.value !== undefined && f.value !== "") this.secrets.set(key, f.value);
        else if (prev && "value" in prev && prev.value !== "") this.secrets.set(key, prev.value); // was plain, now secret
        out[name] = { secret: key };
      } else {
        const value = f.value ?? (prev && "value" in prev ? prev.value : prev && "secret" in prev ? this.secrets.get(prev.secret) : undefined) ?? "";
        out[name] = { value };
        this.secrets.delete(key);
      }
    }
    // Forget secrets for fields that were removed.
    for (const name of Object.keys(previous)) {
      if (!fields.some((f) => f.name.trim() === name)) this.secrets.delete(this.secretKey(clientId, connId, name));
    }
    return out;
  }

  addConnection(clientId: string, input: ConnectionInput): ConnectionView {
    const client = this.client(clientId);
    const name = this.validateConnection(input, client);
    const id = uniqueId(slug(name, "connection"), this.takenConnectionIds(client));
    const fields = this.storeFields(clientId, id, input.fields);
    const conn: StoredConnection =
      input.kind === "local"
        ? { kind: "local", id, name, command: input.command.trim(), args: input.args, env: fields, ...(input.auth ? { auth: input.auth } : {}), ...appOf(input) }
        : { kind: "remote", id, name, url: input.url.trim(), ...(input.transport ? { transport: input.transport } : {}), ...(input.auth ? { auth: input.auth } : {}), ...appOf(input), headers: fields };
    client.connections.push(conn);
    this.commit();
    return this.viewConnection(conn);
  }

  updateConnection(clientId: string, connId: string, input: ConnectionInput): ConnectionView {
    const client = this.client(clientId);
    const idx = client.connections.findIndex((c) => c.id === connId);
    const prev = client.connections[idx];
    if (!prev) throw new StoreError("That connection no longer exists.");
    const name = this.validateConnection(input, client, connId);
    const fields = this.storeFields(clientId, connId, input.fields, fieldsOf(prev));
    const conn: StoredConnection =
      input.kind === "local"
        ? {
            kind: "local",
            id: connId,
            name,
            command: input.command.trim(),
            args: input.args,
            env: fields,
            ...(input.auth ? { auth: input.auth } : {}),
            // An edit keeps the registered app and permissions it was added with.
            ...appOf(input.oauthApp || input.auth !== "oauth" || prev.kind !== "local" ? input : prev),
          }
        : {
            kind: "remote",
            id: connId,
            name,
            url: input.url.trim(),
            ...(input.transport ? { transport: input.transport } : {}),
            ...(input.auth ? { auth: input.auth } : {}),
            // An edit (name, address) keeps the registered app and permissions it was added with.
            ...appOf(input.oauthApp || input.auth !== "oauth" || prev.kind !== "remote" || input.url.trim() !== prev.url ? input : prev),
            headers: fields,
          };
    // A sign-in belongs to one address; a new address (or no more sign-in) needs a new one.
    // (A program signed in through a registered app: new permissions need a new sign-in too;
    // fewer keep it, as the account already allowed them.)
    if (
      (prev.kind === "remote" && (conn.kind !== "remote" || conn.url !== prev.url || conn.auth !== prev.auth)) ||
      (prev.kind === "local" && prev.auth === "oauth" && (conn.kind !== "local" || conn.auth !== prev.auth || conn.oauthApp !== prev.oauthApp || !within(conn.scope, prev.scope)))
    ) {
      this.secrets.delete(oauthKey(clientId, connId));
    }
    // What the AI gets from it, and whether it's on, stay as they were.
    client.connections[idx] = { ...conn, ...kept(prev) };
    this.commit();
    return this.viewConnection(client.connections[idx]!);
  }

  removeConnection(clientId: string, connId: string): void {
    const client = this.client(clientId);
    client.connections = client.connections.filter((c) => c.id !== connId);
    this.secrets.deletePrefix(`${clientId}/${connId}/`);
    this.commit();
  }

  /**
   * Copy a connection to another client. Plain settings are copied; secrets are
   * not: the new client gets the values in `secretValues` (its own keys), and
   * any left out show as "needs a key".
   */
  cloneConnection(fromClientId: string, connId: string, toClientId: string, secretValues: Record<string, string>): ConnectionView {
    const from = this.client(fromClientId);
    const to = this.client(toClientId);
    const src = from.connections.find((c) => c.id === connId);
    if (!src) throw new StoreError("That connection no longer exists.");
    const name = to.connections.some((c) => c.name.toLowerCase() === src.name.toLowerCase())
      ? `${src.name} (copy)`
      : src.name;
    const fields: FieldInput[] = Object.entries(fieldsOf(src)).map(([n, v]) =>
      "secret" in v ? { name: n, secret: true, value: secretValues[n] || undefined } : { name: n, secret: false, value: v.value },
    );
    const input: ConnectionInput =
      src.kind === "local"
        ? { kind: "local", name, command: src.command, args: [...src.args], ...(src.auth ? { auth: src.auth } : {}), ...appOf(src), fields }
        : { kind: "remote", name, url: src.url, ...(src.transport ? { transport: src.transport } : {}), ...(src.auth ? { auth: src.auth } : {}), ...appOf(src), fields };
    const added = this.addConnection(to.id, input);
    // The same actions are offered for the copy (it's the same kind of tool), and it starts on.
    if (src.actions) this.setConnectionActions(to.id, added.id, src.actions);
    return this.view(to.id)!.connections.find((c) => c.id === added.id)!;
  }

  private connection(owner: StoredClient, connId: string): StoredConnection {
    const conn = owner.connections.find((c) => c.id === connId);
    if (!conn) throw new StoreError("That tool no longer exists. Close this window and open it again.");
    return conn;
  }

  /** Which of a tool's actions the AI apps get: "all", "read" (only the ones that read), or the chosen ones by name. */
  setConnectionActions(clientId: string, connId: string, choice: "all" | ActionChoice): ConnectionView {
    const conn = this.connection(this.client(clientId), connId);
    if (choice === "all") delete conn.actions;
    else if (Array.isArray(choice)) {
      const names = [...new Set(choice.map((n) => String(n).trim()).filter(Boolean))];
      if (!names.length) throw new StoreError(`Choose at least one action, or turn ${conn.name} off instead.`);
      if (!isActionChoice(names) || names.length > 5000) throw new StoreError("That list of actions doesn't look right. Close this window and try again.");
      conn.actions = names;
    } else if (choice === "read") conn.actions = "read";
    else throw new StoreError("Choose one of the three options.");
    this.commit();
    return this.viewConnection(conn);
  }

  /** The user checked a tool copied from another client (they saved it): it's offered from now on. */
  markChecked(clientId: string, connId: string): void {
    const conn = this.connection(this.client(clientId), connId);
    if (!conn.copiedFrom) return;
    delete conn.copiedFrom;
    this.commit();
  }

  /** Turn a tool off (kept with its keys, not offered to the AI apps) or on again. */
  setConnectionOff(clientId: string, connId: string, off: boolean): ConnectionView {
    const conn = this.connection(this.client(clientId), connId);
    if (!!conn.off === off) return this.viewConnection(conn);
    if (off) conn.off = true;
    else delete conn.off;
    this.commit();
    return this.viewConnection(conn);
  }

  /**
   * Move a tool, keys and sign-in included, to another client or to the tools for every client
   * (EVERY_CLIENT_ID), or back. Its id may change so it never clashes with the tools it's shown
   * next to; the AI apps get the new list straight away.
   */
  moveConnection(fromId: string, connId: string, toId: string): ConnectionView {
    const from = this.client(fromId);
    const to = this.client(toId);
    if (from.id === to.id) throw new StoreError("It's already there.");
    const src = this.connection(from, connId);
    if (to.connections.some((c) => c.name.toLowerCase() === src.name.toLowerCase())) {
      throw new StoreError(
        to.id === EVERY_CLIENT_ID
          ? `There's already a tool called "${src.name}" for every client. Rename one of them first.`
          : `${to.name} already has a tool called "${src.name}". Rename one of them first.`,
      );
    }
    const others = to.id === EVERY_CLIENT_ID ? this.data.clients : this.data.everyClient ? [this.data.everyClient] : [];
    const taken = new Set([to, ...others].flatMap((c) => c.connections.filter((x) => x !== src).map((x) => x.id)));
    const id = uniqueId(src.id, taken);
    // Keys and the sign-in go with it, under the new owner.
    const fields: Record<string, StoredValue> = {};
    for (const [name, v] of Object.entries(fieldsOf(src))) {
      if ("value" in v) fields[name] = { value: v.value };
      else {
        const key = this.secretKey(to.id, id, name);
        const value = this.secrets.get(v.secret);
        if (value !== undefined) this.secrets.set(key, value);
        fields[name] = { secret: key };
      }
    }
    const signIn = this.secrets.get(oauthKey(from.id, src.id));
    if (signIn !== undefined) this.secrets.set(oauthKey(to.id, id), signIn);
    const moved: StoredConnection = src.kind === "local" ? { ...src, id, env: fields } : { ...src, id, headers: fields };
    to.connections.push(moved);
    from.connections = from.connections.filter((c) => c !== src);
    this.secrets.deletePrefix(`${from.id}/${src.id}/`);
    this.commit();
    return this.viewConnection(moved);
  }

  // ---------- copies for another computer ----------

  /** Everything a copy holds, keys and sign-ins included. In memory only: sealed with a password before it's written. */
  exportCopy(): CopyPayload {
    const conn = (ownerId: string, c: StoredConnection): CopyConnection => {
      const fields: Record<string, CopyField> = {};
      for (const [n, v] of Object.entries(fieldsOf(c))) fields[n] = "value" in v ? { value: v.value } : { secret: this.secrets.get(v.secret) ?? null };
      const signIn = c.auth === "oauth" ? this.secrets.get(oauthKey(ownerId, c.id)) : undefined;
      const base = {
        id: c.id,
        name: c.name,
        fields,
        ...(c.auth ? { auth: c.auth } : {}),
        ...appOf(c),
        ...kept(c),
        ...(signIn !== undefined ? { signIn } : {}),
      };
      return c.kind === "local"
        ? { ...base, kind: "local", command: c.command, args: [...c.args] }
        : { ...base, kind: "remote", url: c.url, ...(c.transport ? { transport: c.transport } : {}) };
    };
    return {
      kind: "ringkeeper-connect-clients",
      version: 1,
      createdAt: new Date().toISOString(),
      clients: this.data.clients.map(
        (c): CopyClient => ({
          name: c.name,
          ...(isClientGuard(c.guard) ? { guard: c.guard } : {}),
          ...(c.pinned ? { pinned: true as const } : {}),
          ...(c.archived ? { archived: true as const } : {}),
          connections: c.connections.map((x) => conn(c.id, x)),
        }),
      ),
      everyClient: (this.data.everyClient?.connections ?? []).map((x) => conn(EVERY_CLIENT_ID, x)),
      ownApps: (this.data.settings.ownApps ?? []).map((a) => {
        const secret = this.secrets.get(ownAppSecretKey(a.id));
        return { ...a, ...(secret !== undefined ? { secret } : {}) };
      }),
    };
  }

  previewCopy(copy: CopyPayload): CopyPreview {
    const names = new Set(this.data.clients.map((c) => c.name.toLowerCase()));
    const every = new Set((this.data.everyClient?.connections ?? []).map((c) => c.name.toLowerCase()));
    const apps = new Set((this.data.settings.ownApps ?? []).map((a) => a.id));
    return {
      clients: copy.clients.map((c) => ({ name: c.name, tools: c.connections.length, archived: !!c.archived, exists: names.has(c.name.toLowerCase()) })),
      everyClient: copy.everyClient.map((c) => ({ name: c.name, exists: every.has(c.name.toLowerCase()) })),
      ownApps: copy.ownApps.map((a) => ({ name: a.name, exists: apps.has(a.id) })),
    };
  }

  /**
   * Bring in the chosen clients from a copy (by their name in the copy), and the tools for every
   * client and own apps that aren't here yet. Nothing already here is changed: a client whose
   * name is taken comes in under a new one ("Acme 2").
   */
  importCopy(copy: CopyPayload, chosen: { clients: string[]; everyClient: boolean }): CopyResult {
    const result: CopyResult = { clients: [], renamed: [], everyClient: [], ownApps: [] };
    const want = new Set(chosen.clients.map((n) => n.toLowerCase()));

    // Own apps first: the tools that sign in through them name them.
    const apps = this.data.settings.ownApps ?? [];
    for (const a of copy.ownApps) {
      if (apps.some((x) => x.id === a.id)) continue;
      const { secret, ...record } = a;
      apps.push({ id: record.id, vendor: record.vendor, name: record.name, clientId: record.clientId, ...(record.tenant ? { tenant: record.tenant } : {}) });
      if (secret !== undefined) this.secrets.set(ownAppSecretKey(a.id), secret);
      result.ownApps.push(a.name);
    }
    if (result.ownApps.length) this.data.settings.ownApps = apps;

    const place = (owner: StoredClient, c: CopyConnection, taken: Set<string>): StoredConnection => {
      const id = uniqueId(slug(c.id, "connection", 40), taken);
      taken.add(id);
      const fields: Record<string, StoredValue> = {};
      for (const [n, f] of Object.entries(c.fields)) {
        if ("value" in f) fields[n] = { value: f.value };
        else {
          const key = this.secretKey(owner.id, id, n);
          if (f.secret !== null) this.secrets.set(key, f.secret);
          fields[n] = { secret: key };
        }
      }
      if (c.signIn !== undefined && c.auth === "oauth") this.secrets.set(oauthKey(owner.id, id), c.signIn);
      const base = {
        id,
        name: c.name,
        ...(c.auth ? { auth: c.auth } : {}),
        ...appOf(c),
        ...(c.actions ? { actions: Array.isArray(c.actions) ? [...c.actions] : c.actions } : {}),
        ...(c.off ? { off: true as const } : {}),
        ...(c.copiedFrom ? { copiedFrom: c.copiedFrom } : {}),
      };
      return c.kind === "local"
        ? { ...base, kind: "local", command: c.command, args: [...c.args], env: fields }
        : { ...base, kind: "remote", url: c.url, ...(c.transport ? { transport: c.transport } : {}), headers: fields };
    };

    const ids = new Set(this.data.clients.map((c) => c.id));
    for (const c of copy.clients) {
      if (!want.has(c.name.toLowerCase())) continue;
      let name = c.name.trim().slice(0, 60) || "Client";
      if (this.data.clients.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
        let i = 2;
        while (this.data.clients.some((x) => x.name.toLowerCase() === `${name} ${i}`.toLowerCase())) i++;
        result.renamed.push({ from: name, to: `${name} ${i}` });
        name = `${name} ${i}`;
      }
      const id = uniqueId(slug(name, "client", 30), ids);
      ids.add(id);
      const client: StoredClient = {
        id,
        name,
        connections: [],
        ...(c.guard ? { guard: c.guard } : {}),
        ...(c.pinned ? { pinned: true as const } : {}),
        ...(c.archived ? { archived: true as const } : {}),
      };
      const taken = this.takenConnectionIds(client);
      for (const conn of c.connections) {
        if (client.connections.some((x) => x.name.toLowerCase() === conn.name.toLowerCase())) continue;
        client.connections.push(place(client, conn, taken));
      }
      this.data.clients.push(client);
      result.clients.push(name);
    }

    if (chosen.everyClient && copy.everyClient.length) {
      const every = (this.data.everyClient ??= { id: EVERY_CLIENT_ID, name: EVERY_CLIENT_NAME, connections: [] });
      const taken = this.takenConnectionIds(every);
      for (const conn of copy.everyClient) {
        if (every.connections.some((x) => x.name.toLowerCase() === conn.name.toLowerCase())) continue;
        every.connections.push(place(every, conn, taken));
        result.everyClient.push(conn.name);
      }
    }

    if (this.data.activeClientId === null || !this.data.clients.some((c) => c.id === this.data.activeClientId)) {
      const first = this.data.clients.find((c) => !c.archived);
      this.data.activeClientId = first?.id ?? null;
      if (first) first.lastUsedAt = Date.now();
    }
    this.commit();
    return result;
  }
}
