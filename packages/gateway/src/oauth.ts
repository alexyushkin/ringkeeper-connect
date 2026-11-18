// Sign-in for web connections that use OAuth (Notion, Airtable, Supabase…).
//
// - signIn(): run by the desktop app when the user clicks "Sign in". Opens the
//   vendor's page in the browser and catches the result on a short-lived
//   127.0.0.1 address (RFC 8252 loopback redirect), using PKCE and dynamic
//   client registration through the MCP SDK.
// - StoredOAuthProvider: used by the gateway at run time. Reads the saved
//   tokens, saves refreshed ones straight away (some vendors rotate refresh
//   tokens and revoke on reuse), and never opens a browser by itself.
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { auth, discoverOAuthServerInfo, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface OAuthState {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  redirectUrl?: string;
  obtainedAt?: number;
}

export interface OAuthStateStore {
  load(key: string): OAuthState | undefined;
  save(key: string, state: OAuthState): void;
}

export class SignInError extends Error {}

/** Starts the message for a service that only lets apps it approved sign in: trying again can't help. */
export const NOT_APPROVED = "only lets apps it has approved sign in";

/**
 * An app Ringkeeper Connect registered with a vendor in advance (Google,
 * Microsoft): for vendors that don't let apps register themselves. Its ID is
 * used instead of registering, for the sign-in and for every refresh.
 */
export interface RegisteredApp {
  id: string;
  clientId: string;
  /** Desktop apps' "secret" (Google issues one); not truly secret, but kept out of the code and logs. */
  clientSecret?: string;
  /** Added to the sign-in address, e.g. Google's access_type=offline so the sign-in lasts. */
  authParams?: Record<string, string>;
}

function appClient(app: RegisteredApp): OAuthClientInformationMixed {
  return { client_id: app.clientId, ...(app.clientSecret ? { client_secret: app.clientSecret } : {}) };
}

function metadata(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: "Ringkeeper Connect",
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** Gateway side: use saved tokens and keep refreshed ones. */
export class StoredOAuthProvider implements OAuthClientProvider {
  private verifier = "";
  /** Set when the vendor wants a fresh sign-in; the gateway reports it instead of opening a browser. */
  needsSignIn = false;

  constructor(
    private readonly store: OAuthStateStore,
    private readonly key: string,
    private readonly app?: RegisteredApp,
  ) {}

  private get saved(): OAuthState {
    return this.store.load(this.key) ?? {};
  }

  get redirectUrl(): string {
    return this.saved.redirectUrl ?? "http://127.0.0.1/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    return metadata(this.redirectUrl);
  }

  clientInformation() {
    return this.app ? appClient(this.app) : this.saved.client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    if (this.app) return; // a registered app's ID never changes
    this.store.save(this.key, { ...this.saved, client });
  }

  tokens() {
    return this.saved.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.save(this.key, { ...this.saved, tokens, obtainedAt: Date.now() });
  }

  redirectToAuthorization(): void {
    this.needsSignIn = true;
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

/** Desktop side: one interactive sign-in. */
class InteractiveProvider implements OAuthClientProvider {
  verifier = "";
  client?: OAuthClientInformationMixed;
  tokensSaved?: OAuthTokens;
  readonly expectedState = randomBytes(16).toString("base64url");

  constructor(
    readonly redirectUrl: string,
    private readonly open: (url: URL) => void,
    readonly app?: RegisteredApp,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return metadata(this.redirectUrl);
  }
  state(): string {
    return this.expectedState;
  }
  // Always register afresh: the redirect address changes on every sign-in. (Not for a registered app.)
  clientInformation() {
    return this.app ? appClient(this.app) : this.client;
  }
  saveClientInformation(c: OAuthClientInformationMixed): void {
    if (!this.app) this.client = c;
  }
  tokens() {
    return this.tokensSaved;
  }
  saveTokens(t: OAuthTokens): void {
    this.tokensSaved = t;
  }
  redirectToAuthorization(url: URL): void {
    for (const [k, v] of Object.entries(this.app?.authParams ?? {})) url.searchParams.set(k, v);
    this.open(url);
  }
  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }
  codeVerifier(): string {
    return this.verifier;
  }
}

const DONE_PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 20px;color:#17201e"><h1 style="font-size:22px">${title}</h1><p>${body}</p></body>`;

export interface SignInOptions {
  serverUrl: string;
  /** e.g. "Notion for Acme", used in messages. */
  label: string;
  store: OAuthStateStore;
  key: string;
  /** Open the sign-in page (the desktop app uses the system browser). Also gets the URL for a "copy link" fallback. */
  openBrowser: (url: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  /** Sign in through Ringkeeper Connect's registered app instead of registering (Google, Microsoft). */
  app?: RegisteredApp;
  /** The permissions to ask for, space-separated (otherwise the server's own list). */
  scope?: string;
}

/** Sign in once and save the result. Resolves when done; rejects with a plain-language SignInError. */
export async function signIn(opts: SignInOptions): Promise<void> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codeArrived = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  let provider: InteractiveProvider | undefined;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (error) {
      res.end(DONE_PAGE("Sign-in didn't finish", "You can close this tab and try again from Ringkeeper Connect."));
      rejectCode(new SignInError(error === "access_denied" ? `Sign-in to ${opts.label} was cancelled.` : `${opts.label} didn't complete the sign-in (${error}). Try again.`));
    } else if (!code || state !== provider?.expectedState) {
      res.end(DONE_PAGE("Sign-in didn't finish", "This sign-in link is out of date. Start again from Ringkeeper Connect."));
      rejectCode(new SignInError(`The sign-in to ${opts.label} came back incomplete. Try again.`));
    } else {
      res.end(DONE_PAGE("You're signed in", "You can close this tab and go back to Ringkeeper Connect."));
      resolveCode(code);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  provider = new InteractiveProvider(`http://127.0.0.1:${port}/callback`, (u) => opts.openBrowser(u.toString()), opts.app);

  const timer = setTimeout(() => rejectCode(new SignInError(`Sign-in to ${opts.label} took too long. Try again.`)), opts.timeoutMs ?? 5 * 60_000);
  opts.signal?.addEventListener("abort", () => rejectCode(new SignInError(`Sign-in to ${opts.label} was cancelled.`)));

  try {
    let first: string;
    try {
      first = await auth(provider, { serverUrl: opts.serverUrl, fetchFn: opts.fetchFn, ...(opts.scope ? { scope: opts.scope } : {}) });
    } catch {
      // No details from the service in the message: they're technical and not something the user can act on.
      throw new SignInError(await whySignInFailed(opts.label, opts.serverUrl, !!(provider?.client || opts.app), opts.fetchFn));
    }
    if (first !== "AUTHORIZED") {
      const code = await codeArrived;
      const done = await auth(provider, { serverUrl: opts.serverUrl, authorizationCode: code, fetchFn: opts.fetchFn, ...(opts.scope ? { scope: opts.scope } : {}) });
      if (done !== "AUTHORIZED" || !provider.tokensSaved) throw new SignInError(`${opts.label} didn't finish the sign-in. Try again.`);
    }
    opts.store.save(opts.key, { client: provider.client, tokens: provider.tokensSaved, redirectUrl: provider.redirectUrl, obtainedAt: Date.now() });
  } catch (err) {
    if (err instanceof SignInError) throw err;
    throw new SignInError(`Sign-in to ${opts.label} failed: ${err instanceof Error ? err.message : String(err)}. Try again.`);
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
}

/** Plain reason for a sign-in that failed before the browser part. Exported for tests. */
export async function whySignInFailed(label: string, serverUrl: string, registered: boolean, fetchFn?: typeof fetch): Promise<string> {
  if (registered) return `${label}'s sign-in page couldn't be opened. Try again in a few minutes.`;
  let offersRegistration = false;
  try {
    const base = fetchFn ?? fetch;
    const timed: typeof fetch = (input, init) => base(input, { ...init, signal: AbortSignal.timeout(8000) });
    offersRegistration = !!(await discoverOAuthServerInfo(serverUrl, { fetchFn: timed })).authorizationServerMetadata?.registration_endpoint;
  } catch {
    offersRegistration = false;
  }
  return offersRegistration
    ? // It lets apps register, but refused this one: some services allow only apps they approved (Meta).
      `${label} ${NOT_APPROVED}, and Ringkeeper Connect isn't one of them yet, so this sign-in can't work. Nothing was changed. Use "Request a tool" to tell us you need it.`
    : `${label} doesn't offer a sign-in that Ringkeeper Connect can use. Use a key instead, if the service offers one.`;
}

/**
 * Does this web address need a sign-in that Ringkeeper Connect can do by itself
 * (no key to make)? Only when the server refuses a call without one (401),
 * names its sign-in service (RFC 9728), and that service lets a new app
 * register (RFC 7591), the same as signIn() needs.
 * Never throws: anything unclear is "no". `fetchFn` is for tests.
 */
export async function offersSignIn(serverUrl: string, opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {}): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const base = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const fetchFn: typeof fetch = (input, init) => base(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  try {
    // Only a server that refuses a call without sign-in: one that works without any key stays as it is.
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ringkeeper-connect", version: "1" } } }),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status !== 401) return false;
    const hinted = /resource_metadata="([^"]+)"/i.exec(res.headers.get("www-authenticate") ?? "")?.[1];
    const info = await discoverOAuthServerInfo(url, { fetchFn, ...(hinted ? { resourceMetadataUrl: new URL(hinted) } : {}) });
    return !!info.resourceMetadata?.authorization_servers?.length && !!info.authorizationServerMetadata?.registration_endpoint;
  } catch {
    return false;
  }
}
