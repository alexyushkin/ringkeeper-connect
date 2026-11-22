// "Use your own Google or Microsoft app" (as in Ringkeeper's Settings > Developer apps):
// - Google: a "Desktop app" client in the agency's own Google Cloud project, for agencies
//   past the 100 accounts Google allows Ringkeeper Connect's app, or for their own name on
//   Google's sign-in page. The client ID is kept in the settings, the secret encrypted with
//   the keys and never shown again.
// - Microsoft: a "public client" app registration in the agency's own Entra directory (or a
//   client's), for a client whose IT admin only approves apps they know, or for their own
//   name on Microsoft's sign-in page. Like ours it has no secret: just its client ID, and
//   the directory it signs in to ("common" for any account).
// - Meta: an app the agency made on Meta for Developers, for Meta Ads. Meta's own ads server
//   only lets the AI apps it approved sign in, and there's no Ringkeeper Connect Meta app (its
//   secret would ship in every copy), so Meta Ads always signs in through one of these. The
//   App ID is kept in the settings, the App secret encrypted like a Google one.
// Each Google, Microsoft or Meta account picks the app it signs in through when it's added.
import {
  ownAppSecretKey,
  slug,
  type ClientStore,
  type OwnAppRecord,
  type OwnAppVendor,
  type RegisteredApp,
  type SecretStore,
} from "@ringkeeper/gateway";
import { GOOGLE_TOKEN_ENDPOINT, META_GRAPH, MICROSOFT_LOGIN, googleApp, mcpServerApp, metaApp, microsoftApp } from "./registered-apps.js";

export class OwnAppsError extends Error {}

/** What the window sees of an own app: never its secret. */
export interface OwnAppView {
  id: string;
  vendor: OwnAppVendor;
  name: string;
  clientId: string;
  /** Microsoft: the directory it signs in to ("common" for any account). */
  tenant?: string;
  /** The tools that sign in through it, as "Acme > Google". */
  usedBy: string[];
}

export interface OwnAppInput {
  /** On an add: whose app it is (Google when left out). */
  vendor?: string;
  name?: string;
  clientId?: string;
  /** Google and Meta. Empty or left out on an edit: keep the saved one. */
  clientSecret?: string;
  /** Microsoft only: a directory (tenant) ID or domain; empty for any account ("common"). */
  tenant?: string;
}

const MOST_APPS = 20;
const LABEL: Record<OwnAppVendor, string> = { google: "Google", microsoft: "Microsoft", meta: "Meta", hubspot: "HubSpot", asana: "Asana" };
/** The own apps that have a secret (Microsoft's are public clients). */
const hasSecret = (vendor: OwnAppVendor) => vendor !== "microsoft";

function vendorOf(value: string | undefined): OwnAppVendor {
  if (value === undefined || value === "google") return "google";
  if (value === "microsoft" || value === "meta" || value === "hubspot" || value === "asana") return value;
  throw new OwnAppsError("Ringkeeper Connect can use your own Google, Microsoft, Meta, HubSpot or Asana app only.");
}

function cleanClientId(vendor: OwnAppVendor, value: string): string {
  const id = value.trim();
  if (vendor === "hubspot") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new OwnAppsError("That isn't a HubSpot client ID: it looks like 1a2b3c4d-1234-5678-9abc-1a2b3c4d5e6f. Copy it from the MCP connector's details page.");
    }
    return id.toLowerCase();
  }
  if (vendor === "asana") {
    if (!/^\d{6,24}$/.test(id)) throw new OwnAppsError("That isn't an Asana client ID: it's a long number. Copy it from the app's OAuth page in Asana's developer console.");
    return id;
  }
  if (vendor === "meta") {
    if (!/^\d{5,20}$/.test(id)) throw new OwnAppsError("That isn't a Meta App ID: it's a long number. Copy it from App settings > Basic on Meta for Developers.");
    return id;
  }
  if (vendor === "microsoft") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new OwnAppsError("That isn't a Microsoft Application (client) ID: it looks like 1a2b3c4d-1234-5678-9abc-1a2b3c4d5e6f. Copy it from the app's Overview page.");
    }
    return id.toLowerCase();
  }
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(id)) {
    throw new OwnAppsError("That isn't a Google client ID: it ends with .apps.googleusercontent.com. Copy it from Google Cloud > Clients.");
  }
  return id;
}

function cleanSecret(value: string, vendor: OwnAppVendor = "google"): string {
  const secret = value.replace(/\s+/g, "");
  if (vendor === "meta") {
    if (!secret) throw new OwnAppsError("Paste the App secret too: App settings > Basic, then Show next to App secret.");
    if (!/^[0-9a-f]{32}$/i.test(secret)) throw new OwnAppsError("That isn't a Meta App secret: it's 32 letters and digits. Click Show next to App secret in App settings > Basic, and copy it.");
    return secret;
  }
  if (vendor === "hubspot" || vendor === "asana") {
    if (!secret) throw new OwnAppsError(`Paste the client secret too: ${vendor === "hubspot" ? "it's on the MCP connector's details page" : "it's on the app's OAuth page"}.`);
    if (secret.length > 500) throw new OwnAppsError("That's too long to be a client secret.");
    return secret;
  }
  if (!secret) throw new OwnAppsError("Paste the client secret too. Google shows it when you create the client (and under Clients > the client).");
  if (secret.length > 500) throw new OwnAppsError("That's too long to be a Google client secret.");
  return secret;
}

function cleanTenant(value: string | undefined): string {
  const tenant = (value ?? "").trim().toLowerCase();
  if (!tenant) return "common";
  if (!/^[a-z0-9][a-z0-9.-]{1,79}$/.test(tenant)) {
    throw new OwnAppsError("That isn't a directory (tenant) ID. Copy the Directory (tenant) ID from the app's Overview page, or leave it empty for any account.");
  }
  return tenant;
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

/** Where the check asks Microsoft to send the browser back (never opened: Microsoft ignores the port of these). */
const CHECK_RETURN = "http://127.0.0.1:53682/callback";
/** What Microsoft sends back to an app it knows when nobody is signed in. */
const SILENT_ANSWERS = new Set(["login_required", "interaction_required", "consent_required"]);

/**
 * Asks Microsoft's sign-in page for a silent sign-in (prompt=none) with nobody signed in, so
 * nothing happens: Microsoft sends the browser back to Ringkeeper Connect's address only when
 * the app exists, takes accounts from that directory and has that return address. Anything
 * else stays on Microsoft's error page.
 */
export async function checkMicrosoftApp(clientId: string, tenant: string, fetchFn: typeof fetch = fetch, login = MICROSOFT_LOGIN): Promise<void> {
  // Personal accounts only: there's no silent check for those; the first sign-in shows any problem.
  if (tenant === "consumers") return;
  const url = new URL(`${login}/${tenant === "common" ? "organizations" : tenant}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: CHECK_RETURN,
    scope: "openid offline_access",
    prompt: "none",
    code_challenge: "ringkeeper-connect-check-ringkeeper-connect",
    code_challenge_method: "S256",
    state: "ringkeeper-connect-check",
  }).toString();
  let response: Response;
  try {
    response = await fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new OwnAppsError("Couldn't reach Microsoft to check this app. Check this computer's internet connection and try again.");
  }
  const back = response.status >= 300 && response.status < 400 ? (response.headers.get("location") ?? "") : "";
  if (back.startsWith(CHECK_RETURN)) {
    const answer = new URL(back).searchParams;
    if (answer.has("code") || SILENT_ANSWERS.has(answer.get("error") ?? "")) return;
  }
  const text = back ? "" : await response.text().catch(() => "");
  if (/AADSTS90002\b/.test(text)) {
    throw new OwnAppsError(`Microsoft doesn't know the directory "${tenant}". Copy the Directory (tenant) ID from the app's Overview page, or leave it empty for any account.`);
  }
  throw new OwnAppsError(
    "Microsoft didn't accept this app. Check that the Application (client) ID is the one on its Overview page, that http://127.0.0.1/callback is one of its redirect URIs (Authentication > Mobile and desktop applications), and that its Supported account types take other organizations' accounts (or fill in the directory ID).",
  );
}

/**
 * Asks Meta for this app's own app token (client credentials): Meta gives one only for a
 * matching App ID and secret. Nothing is created, and the token isn't kept.
 */
export async function checkMetaApp(appId: string, appSecret: string, fetchFn: typeof fetch = fetch, graph = META_GRAPH): Promise<void> {
  const query = new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: "client_credentials" });
  let response: Response;
  try {
    response = await fetchFn(`${graph}/oauth/access_token?${query}`, { signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new OwnAppsError("Couldn't reach Meta to check this app. Check this computer's internet connection and try again.");
  }
  const answer = (await response.json().catch(() => ({}))) as { access_token?: unknown };
  if (!response.ok || typeof answer.access_token !== "string") {
    throw new OwnAppsError("Meta didn't accept this App ID and App secret. Copy both again from App settings > Basic on Meta for Developers.");
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
      /** Microsoft's sign-in service unless a test says otherwise. */
      microsoftLogin?: string;
      /** Meta's Graph API and sign-in dialog unless a test says otherwise. */
      meta?: { graph: string; dialog: string };
    },
  ) {
    this.sync();
  }

  private records(): OwnAppRecord[] {
    return [...(this.deps.store.settings.ownApps ?? [])];
  }

  private users(id: string): Array<{ clientId: string; connectionId: string; label: string }> {
    return this.deps.store.listAll().flatMap((c) =>
      c.connections.filter((conn) => conn.oauthApp === id).map((conn) => ({ clientId: c.id, connectionId: conn.id, label: `${c.name} > ${conn.name}` })),
    );
  }

  list(): OwnAppView[] {
    return this.records().map((r) => ({
      id: r.id,
      vendor: r.vendor,
      name: r.name,
      clientId: r.clientId,
      ...(r.vendor === "microsoft" ? { tenant: r.tenant ?? "common" } : {}),
      usedBy: this.users(r.id).map((u) => u.label),
    }));
  }

  /** Puts these apps into the apps sign-ins use (a Google or Meta app without its secret is left out). */
  sync(): void {
    const apps = this.deps.apps;
    for (const id of Object.keys(apps)) if (id.includes(":")) delete apps[id];
    for (const r of this.records()) {
      if (r.vendor === "microsoft") {
        apps[r.id] = microsoftApp(r.id, r.clientId, r.tenant ?? "common", this.deps.microsoftLogin);
        continue;
      }
      const secret = this.secret(r.id);
      if (!secret) continue;
      apps[r.id] =
        r.vendor === "meta"
          ? metaApp(r.id, r.clientId, secret, this.deps.meta?.graph, this.deps.meta?.dialog)
          : r.vendor === "hubspot" || r.vendor === "asana"
            ? mcpServerApp(r.vendor, r.id, r.clientId, secret)
            : { ...googleApp(r.id, r.clientId, secret), ...this.deps.endpoints };
    }
  }

  private secret(id: string): string | undefined {
    try {
      return this.deps.secrets.get(ownAppSecretKey(id));
    } catch {
      return undefined; // this computer's secure storage isn't available
    }
  }

  private check(vendor: OwnAppVendor, clientId: string, secretOrTenant: string): Promise<void> {
    // HubSpot and Asana have no way to check an app without a sign-in: the first sign-in shows any problem.
    if (vendor === "hubspot" || vendor === "asana") return Promise.resolve();
    if (vendor === "meta") return checkMetaApp(clientId, secretOrTenant, this.deps.fetchFn, this.deps.meta?.graph);
    return vendor === "microsoft"
      ? checkMicrosoftApp(clientId, secretOrTenant, this.deps.fetchFn, this.deps.microsoftLogin)
      : checkGoogleClient(clientId, secretOrTenant, this.deps.fetchFn, this.deps.endpoints?.tokenEndpoint);
  }

  private cleanName(vendor: OwnAppVendor, value: string): string {
    const name = value.trim();
    if (!name) throw new OwnAppsError(`Name this ${LABEL[vendor]} app, say whose it is (your agency's, or a client's).`);
    if (name.length > 80) throw new OwnAppsError("Make the name shorter (80 characters at most).");
    return name;
  }

  async add(input: OwnAppInput): Promise<OwnAppView> {
    const vendor = vendorOf(input.vendor);
    const label = LABEL[vendor];
    const name = this.cleanName(vendor, input.name ?? "");
    const clientId = cleanClientId(vendor, input.clientId ?? "");
    const secret = hasSecret(vendor) ? cleanSecret(input.clientSecret ?? "", vendor) : undefined;
    const tenant = vendor === "microsoft" ? cleanTenant(input.tenant) : undefined;
    const records = this.records();
    const theirs = records.filter((r) => r.vendor === vendor);
    if (theirs.length >= MOST_APPS) throw new OwnAppsError(`That's ${MOST_APPS} ${label} apps already. Remove one you don't use first.`);
    const same = theirs.find((r) => r.clientId === clientId);
    if (same) throw new OwnAppsError(`That ${label} app is already set up, as "${same.name}".`);
    await this.check(vendor, clientId, (secret ?? tenant)!);
    const base = `${vendor}:${slug(name, "app", 30)}`;
    let id = base;
    for (let n = 2; records.some((r) => r.id === id); n++) id = `${base}_${n}`;
    if (secret) this.deps.secrets.set(ownAppSecretKey(id), secret);
    this.deps.store.updateSettings({ ownApps: [...records, { id, vendor, name, clientId, ...(tenant ? { tenant } : {}) }] });
    this.sync();
    return this.list().find((a) => a.id === id)!;
  }

  /**
   * A new name or (Google) secret. A new client ID or (Microsoft) directory only while no tool
   * signs in through it: each sign-in belongs to the app and directory it was made with.
   */
  async update(id: string, input: OwnAppInput): Promise<OwnAppView> {
    const records = this.records();
    const current = records.find((r) => r.id === id);
    if (!current) throw new OwnAppsError("That app isn't set up anymore.");
    const vendor = current.vendor;
    const label = LABEL[vendor];
    const name = input.name === undefined ? current.name : this.cleanName(vendor, input.name);
    const clientId = input.clientId === undefined || !input.clientId.trim() ? current.clientId : cleanClientId(vendor, input.clientId);
    const currentTenant = current.tenant ?? "common";
    const tenant = vendor === "microsoft" ? (input.tenant === undefined ? currentTenant : cleanTenant(input.tenant)) : undefined;
    const users = this.users(id);
    const moved = clientId !== current.clientId || (vendor === "microsoft" && tenant !== currentTenant);
    if (moved && users.length) {
      const what = clientId !== current.clientId ? "client ID" : "directory";
      throw new OwnAppsError(
        `${users.map((u) => u.label).join(", ")} sign${users.length === 1 ? "s" : ""} in through this app, and ${label} ties each sign-in to its ${what}. Add the new one as another app instead.`,
      );
    }
    if (clientId !== current.clientId && records.some((r) => r.id !== id && r.vendor === vendor && r.clientId === clientId)) throw new OwnAppsError(`That ${label} app is already set up.`);
    let newSecret: string | undefined;
    if (hasSecret(vendor)) {
      newSecret = input.clientSecret && input.clientSecret.trim() ? cleanSecret(input.clientSecret, vendor) : undefined;
      if (moved && !newSecret) throw new OwnAppsError("Paste the new client's secret too.");
      if (newSecret || moved) {
        const secret = newSecret ?? this.secret(id);
        if (!secret) throw new OwnAppsError("Paste the client secret again: this computer couldn't read the saved one.");
        await this.check(vendor, clientId, secret);
        this.deps.secrets.set(ownAppSecretKey(id), secret);
      }
    } else if (moved) {
      await this.check(vendor, clientId, tenant!);
    }
    this.deps.store.updateSettings({ ownApps: records.map((r) => (r.id === id ? { ...r, name, clientId, ...(tenant ? { tenant } : {}) } : r)) });
    this.sync();
    // Tools already running renew their sign-in with the app they started with.
    if (newSecret) for (const u of users) this.deps.restart?.(u.clientId, u.connectionId);
    return this.list().find((a) => a.id === id)!;
  }

  remove(id: string): void {
    const records = this.records();
    if (!records.some((r) => r.id === id)) throw new OwnAppsError("That app isn't set up anymore.");
    const users = this.users(id);
    if (users.length) {
      throw new OwnAppsError(`${users.map((u) => u.label).join(", ")} sign${users.length === 1 ? "s" : ""} in through this app. Remove ${users.length === 1 ? "that tool" : "those tools"} first.`);
    }
    this.deps.store.updateSettings({ ownApps: records.filter((r) => r.id !== id) });
    this.deps.secrets.delete(ownAppSecretKey(id));
    this.sync();
  }
}
