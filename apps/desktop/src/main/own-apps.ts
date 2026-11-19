// "Use your own Google app" (as in Ringkeeper's Settings > Developer apps): a Google
// "Desktop app" client in the user's own Google Cloud project, for agencies past the 100
// accounts Google allows Ringkeeper Connect's app, for a client whose Workspace admin
// only trusts apps in their own project, or for their own name on Google's sign-in page.
//
// The client ID is kept in the settings; the secret encrypted with the keys, and never
// shown again. Each Google account picks the app it signs in through when it's added.
import {
  ownAppSecretKey,
  slug,
  type ClientStore,
  type OwnAppRecord,
  type RegisteredApp,
  type SecretStore,
} from "@ringkeeper/gateway";
import { GOOGLE_TOKEN_ENDPOINT, googleApp } from "./registered-apps.js";

export class OwnAppsError extends Error {}

/** What the window sees of an own app: never its secret. */
export interface OwnAppView {
  id: string;
  vendor: "google";
  name: string;
  clientId: string;
  /** The tools that sign in through it, as "Acme > Google". */
  usedBy: string[];
}

export interface OwnAppInput {
  name?: string;
  clientId?: string;
  /** Empty or left out on an edit: keep the saved one. */
  clientSecret?: string;
}

const MOST_APPS = 20;

function cleanClientId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(id)) {
    throw new OwnAppsError("That isn't a Google client ID: it ends with .apps.googleusercontent.com. Copy it from Google Cloud > Clients.");
  }
  return id;
}

function cleanSecret(value: string): string {
  const secret = value.replace(/\s+/g, "");
  if (!secret) throw new OwnAppsError("Paste the client secret too. Google shows it when you create the client (and under Clients > the client).");
  if (secret.length > 500) throw new OwnAppsError("That's too long to be a Google client secret.");
  return secret;
}

/**
 * Asks Google about this client with a code that can't work, so nothing is created:
 * Google turning the code down means it accepted the client ID and secret.
 */
export async function checkGoogleClient(clientId: string, clientSecret: string, fetchFn: typeof fetch = fetch, tokenEndpoint = GOOGLE_TOKEN_ENDPOINT): Promise<void> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: "ringkeeper-connect-check",
    redirect_uri: "http://127.0.0.1/callback",
    client_id: clientId,
    client_secret: clientSecret,
  });
  let response: Response;
  try {
    response = await fetchFn(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new OwnAppsError("Couldn't reach Google to check this app. Check this computer's internet connection and try again.");
  }
  const text = await response.text().catch(() => "");
  if (response.status === 401 || /invalid_client|unauthorized_client/.test(text)) {
    throw new OwnAppsError("Google didn't accept this client ID and secret. Copy both again from Google Cloud > Clients (the client's type must be Desktop app).");
  }
}

export class OwnApps {
  constructor(
    private readonly deps: {
      store: ClientStore;
      secrets: SecretStore;
      /** The apps sign-ins use (ours and these), by id: kept up to date here. */
      apps: Record<string, RegisteredApp>;
      /** Restart the tools that sign in through an app whose secret changed. */
      restart?: (clientId: string, connectionId: string) => void;
      fetchFn?: typeof fetch;
      /** Google itself unless a test says otherwise. */
      endpoints?: { authorizationEndpoint: string; tokenEndpoint: string };
    },
  ) {
    this.sync();
  }

  private records(): OwnAppRecord[] {
    return [...(this.deps.store.settings.ownApps ?? [])];
  }

  private users(id: string): Array<{ clientId: string; connectionId: string; label: string }> {
    return this.deps.store.list().flatMap((c) =>
      c.connections.filter((conn) => conn.kind === "local" && conn.oauthApp === id).map((conn) => ({ clientId: c.id, connectionId: conn.id, label: `${c.name} > ${conn.name}` })),
    );
  }

  list(): OwnAppView[] {
    return this.records().map((r) => ({ id: r.id, vendor: r.vendor, name: r.name, clientId: r.clientId, usedBy: this.users(r.id).map((u) => u.label) }));
  }

  /** Puts these apps into the apps sign-ins use (an app without its secret is left out). */
  sync(): void {
    const apps = this.deps.apps;
    for (const id of Object.keys(apps)) if (id.includes(":")) delete apps[id];
    for (const r of this.records()) {
      const secret = this.secret(r.id);
      if (secret) apps[r.id] = { ...googleApp(r.id, r.clientId, secret), ...this.deps.endpoints };
    }
  }

  private secret(id: string): string | undefined {
    try {
      return this.deps.secrets.get(ownAppSecretKey(id));
    } catch {
      return undefined; // this computer's secure storage isn't available
    }
  }

  async add(input: OwnAppInput): Promise<OwnAppView> {
    const name = (input.name ?? "").trim();
    if (!name) throw new OwnAppsError("Name this Google app, say whose Google Cloud project it's in.");
    if (name.length > 80) throw new OwnAppsError("Make the name shorter (80 characters at most).");
    const clientId = cleanClientId(input.clientId ?? "");
    const secret = cleanSecret(input.clientSecret ?? "");
    const records = this.records();
    if (records.length >= MOST_APPS) throw new OwnAppsError(`That's ${MOST_APPS} Google apps already. Remove one you don't use first.`);
    const same = records.find((r) => r.clientId === clientId);
    if (same) throw new OwnAppsError(`That Google app is already set up, as "${same.name}".`);
    await checkGoogleClient(clientId, secret, this.deps.fetchFn, this.deps.endpoints?.tokenEndpoint);
    const base = `google:${slug(name, "app", 30)}`;
    let id = base;
    for (let n = 2; records.some((r) => r.id === id); n++) id = `${base}_${n}`;
    this.deps.secrets.set(ownAppSecretKey(id), secret);
    this.deps.store.updateSettings({ ownApps: [...records, { id, vendor: "google", name, clientId }] });
    this.sync();
    return this.list().find((a) => a.id === id)!;
  }

  /** A new name or secret. A new client ID only while no tool signs in through it: Google ties each sign-in to its client. */
  async update(id: string, input: OwnAppInput): Promise<OwnAppView> {
    const records = this.records();
    const current = records.find((r) => r.id === id);
    if (!current) throw new OwnAppsError("That Google app isn't set up anymore.");
    const name = input.name === undefined ? current.name : input.name.trim();
    if (!name) throw new OwnAppsError("Name this Google app, say whose Google Cloud project it's in.");
    const clientId = input.clientId === undefined || !input.clientId.trim() ? current.clientId : cleanClientId(input.clientId);
    const users = this.users(id);
    if (clientId !== current.clientId && users.length) {
      throw new OwnAppsError(`${users.map((u) => u.label).join(", ")} sign${users.length === 1 ? "s" : ""} in through this app, and Google ties each sign-in to its client ID. Add the new client as another app instead.`);
    }
    if (clientId !== current.clientId && records.some((r) => r.id !== id && r.clientId === clientId)) throw new OwnAppsError("That Google app is already set up.");
    const newSecret = input.clientSecret && input.clientSecret.trim() ? cleanSecret(input.clientSecret) : undefined;
    if (clientId !== current.clientId && !newSecret) throw new OwnAppsError("Paste the new client's secret too.");
    if (newSecret || clientId !== current.clientId) {
      const secret = newSecret ?? this.secret(id);
      if (!secret) throw new OwnAppsError("Paste the client secret again: this computer couldn't read the saved one.");
      await checkGoogleClient(clientId, secret, this.deps.fetchFn, this.deps.endpoints?.tokenEndpoint);
      this.deps.secrets.set(ownAppSecretKey(id), secret);
    }
    this.deps.store.updateSettings({ ownApps: records.map((r) => (r.id === id ? { ...r, name, clientId } : r)) });
    this.sync();
    // Tools already running renew their sign-in with the app they started with.
    if (newSecret) for (const u of users) this.deps.restart?.(u.clientId, u.connectionId);
    return this.list().find((a) => a.id === id)!;
  }

  remove(id: string): void {
    const records = this.records();
    if (!records.some((r) => r.id === id)) throw new OwnAppsError("That Google app isn't set up anymore.");
    const users = this.users(id);
    if (users.length) {
      throw new OwnAppsError(`${users.map((u) => u.label).join(", ")} sign${users.length === 1 ? "s" : ""} in through this app. Remove ${users.length === 1 ? "that tool" : "those tools"} first.`);
    }
    this.deps.store.updateSettings({ ownApps: records.filter((r) => r.id !== id) });
    this.deps.secrets.delete(ownAppSecretKey(id));
    this.sync();
  }
}
