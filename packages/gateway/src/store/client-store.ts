// The user's clients and their connections. Saved to clients.json without
// any secret values; secrets go to the SecretStore and are referenced by key.
import fs from "node:fs";
import { readJson, writeJsonAtomic } from "../runtime.js";
import type { ConnectionConfig, GatewayConfig } from "../config.js";
import { DEFAULT_DYNAMIC_HOSTS } from "../meta-tools.js";
import type { SecretStore } from "./secrets.js";
import type { OAuthState, OAuthStateStore } from "../oauth.js";

// ---------- stored shapes ----------

/** A plain value, or a reference to a value kept in the SecretStore. */
export type StoredValue = { value: string } | { secret: string };

interface StoredBase {
  id: string;
  name: string;
}
export interface StoredLocalConnection extends StoredBase {
  kind: "local";
  command: string;
  args: string[];
  env: Record<string, StoredValue>;
}
export interface StoredRemoteConnection extends StoredBase {
  kind: "remote";
  url: string;
  /** "sse" for older servers; Streamable HTTP otherwise. */
  transport?: "sse";
  /** Signs in with OAuth instead of (or as well as) keys. */
  auth?: "oauth";
  headers: Record<string, StoredValue>;
}
export type StoredConnection = StoredLocalConnection | StoredRemoteConnection;

export interface StoredClient {
  id: string;
  name: string;
  connections: StoredConnection[];
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
  /** The "bring in what your apps already use" wizard was offered for an empty first client. */
  bringInOffered: boolean;
}

interface StoreFile {
  version: 1;
  activeClientId: string | null;
  clients: StoredClient[];
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = { requireClientArg: true, dynamicHosts: [...DEFAULT_DYNAMIC_HOSTS], setupDone: false, startAtLogin: true, bringInOffered: false };

// ---------- inputs and views (what the UI sends and sees) ----------

/** One environment variable or header. `value` undefined on update means "keep what's saved". */
export interface FieldInput {
  name: string;
  value?: string;
  secret: boolean;
}

export type ConnectionInput =
  | { kind: "local"; name: string; command: string; args: string[]; fields: FieldInput[] }
  | { kind: "remote"; name: string; url: string; transport?: "sse"; auth?: "oauth"; fields: FieldInput[] };

/** Secret values are never included; `isSet` says whether one is saved. */
export interface FieldView {
  name: string;
  secret: boolean;
  value?: string;
  isSet: boolean;
}

export type ConnectionView =
  | { kind: "local"; id: string; name: string; command: string; args: string[]; fields: FieldView[]; missingKeys: string[] }
  | {
      kind: "remote";
      id: string;
      name: string;
      url: string;
      transport?: "sse";
      auth?: "oauth";
      /** For OAuth connections: a sign-in is saved. */
      signedIn?: boolean;
      fields: FieldView[];
      missingKeys: string[];
    };

export interface ClientView {
  id: string;
  name: string;
  active: boolean;
  connections: ConnectionView[];
}

export class StoreError extends Error {}

/** Where a connection's OAuth sign-in is kept in the SecretStore. Deleted with the connection. */
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
    return this.data.clients.map((c) => ({
      id: c.id,
      name: c.name,
      active: c.id === this.data.activeClientId,
      connections: c.connections.map((conn) => this.viewConnection(conn)),
    }));
  }

  private oauthKeyFor(conn: StoredConnection): string {
    const owner = this.data.clients.find((c) => c.connections.includes(conn));
    return oauthKey(owner?.id ?? "", conn.id);
  }

  private viewConnection(conn: StoredConnection): ConnectionView {
    const fields: FieldView[] = Object.entries(fieldsOf(conn)).map(([name, v]) =>
      "secret" in v ? { name, secret: true, isSet: this.secrets.has(v.secret) } : { name, secret: false, value: v.value, isSet: true },
    );
    const missingKeys = fields.filter((f) => !f.isSet).map((f) => f.name);
    return conn.kind === "local"
      ? { kind: "local", id: conn.id, name: conn.name, command: conn.command, args: [...conn.args], fields, missingKeys }
      : {
          kind: "remote",
          id: conn.id,
          name: conn.name,
          url: conn.url,
          ...(conn.transport ? { transport: conn.transport } : {}),
          ...(conn.auth ? { auth: conn.auth, signedIn: this.secrets.has(this.oauthKeyFor(conn)) } : {}),
          fields,
          missingKeys,
        };
  }

  /**
   * The gateway's view: every connection with its secrets filled in. Kept in
   * memory only. Connections with a missing key carry `missingKeys` instead of
   * being started.
   */
  toGatewayConfig(): GatewayConfig {
    return {
      options: { requireClientArg: this.data.settings.requireClientArg, dynamicHosts: [...this.data.settings.dynamicHosts] },
      clients: this.data.clients.map((c) => ({
        id: c.id,
        name: c.name,
        connections: c.connections.map((conn): ConnectionConfig => {
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
          const base = { id: conn.id, name: conn.name, ...(missing.length ? { missingKeys: missing } : {}) };
          return conn.kind === "local"
            ? { ...base, kind: "local", command: conn.command, args: [...conn.args], env: resolved }
            : {
                ...base,
                kind: "remote",
                url: conn.url,
                ...(conn.transport ? { transport: conn.transport } : {}),
                ...(conn.auth === "oauth" ? { oauth: { key: oauthKey(c.id, conn.id) }, needsSignIn: !this.secrets.has(oauthKey(c.id, conn.id)) } : {}),
                headers: resolved,
              };
        }),
      })),
    };
  }

  // ---------- clients ----------

  private client(id: string): StoredClient {
    const c = this.data.clients.find((x) => x.id === id);
    if (!c) throw new StoreError("That client no longer exists. Close this window and open it again.");
    return c;
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

  addClient(name: string): ClientView {
    const clean = this.checkClientName(name);
    const id = uniqueId(slug(clean, "client", 30), new Set(this.data.clients.map((c) => c.id)));
    this.data.clients.push({ id, name: clean, connections: [] });
    this.data.activeClientId ??= id;
    this.commit();
    return this.list().find((c) => c.id === id)!;
  }

  /** Renaming keeps the id, so tool names and saved keys stay stable. */
  renameClient(id: string, name: string): void {
    const c = this.client(id);
    c.name = this.checkClientName(name, id);
    this.commit();
  }

  removeClient(id: string): void {
    this.client(id);
    this.data.clients = this.data.clients.filter((c) => c.id !== id);
    this.secrets.deletePrefix(`${id}/`);
    if (this.data.activeClientId === id) this.data.activeClientId = this.data.clients[0]?.id ?? null;
    this.commit();
  }

  setActiveClient(id: string): void {
    this.client(id);
    if (this.data.activeClientId === id) return;
    this.data.activeClientId = id;
    this.commit();
  }

  updateSettings(patch: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...patch };
    this.commit();
  }

  // ---------- connections ----------

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
    const id = uniqueId(slug(name, "connection"), new Set(client.connections.map((c) => c.id)));
    const fields = this.storeFields(clientId, id, input.fields);
    const conn: StoredConnection =
      input.kind === "local"
        ? { kind: "local", id, name, command: input.command.trim(), args: input.args, env: fields }
        : { kind: "remote", id, name, url: input.url.trim(), ...(input.transport ? { transport: input.transport } : {}), ...(input.auth ? { auth: input.auth } : {}), headers: fields };
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
        ? { kind: "local", id: connId, name, command: input.command.trim(), args: input.args, env: fields }
        : { kind: "remote", id: connId, name, url: input.url.trim(), ...(input.transport ? { transport: input.transport } : {}), ...(input.auth ? { auth: input.auth } : {}), headers: fields };
    // A sign-in belongs to one address; a new address (or no more sign-in) needs a new one.
    if (prev.kind === "remote" && (conn.kind !== "remote" || conn.url !== prev.url || conn.auth !== prev.auth)) {
      this.secrets.delete(oauthKey(clientId, connId));
    }
    client.connections[idx] = conn;
    this.commit();
    return this.viewConnection(conn);
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
        ? { kind: "local", name, command: src.command, args: [...src.args], fields }
        : { kind: "remote", name, url: src.url, ...(src.transport ? { transport: src.transport } : {}), ...(src.auth ? { auth: src.auth } : {}), fields };
    return this.addConnection(to.id, input);
  }
}
