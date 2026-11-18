// Catalog actions for the window: add a known service, sign in to it, and
// open a vendor's "where to find this key" page.
import {
  CatalogInputError,
  buildConnection,
  catalog,
  type CatalogService,
} from "@ringkeeper/catalog";
import {
  SignInError,
  StoreError,
  oauthKey,
  signIn,
  signInDirect,
  type ClientStore,
  type Gateway,
  type OAuthStateStore,
  type RegisteredApp,
} from "@ringkeeper/gateway";

export class CatalogActionError extends Error {}

/** Where "Request a tool" goes. Empty address: the public contact page instead. */
export const REQUEST_TOOL_EMAIL = "requests@yushkin.us";
export const REQUEST_TOOL_PAGE = "https://yushkin.us";

/** The email "Request a tool" opens: what was searched goes in the subject and the first line. */
export function requestToolMailto(
  searched: string,
  email = REQUEST_TOOL_EMAIL,
): string {
  const what = String(searched ?? "")
    .slice(0, 80)
    .replace(/\s+/g, " ")
    .trim();
  const subject = `Tool request: ${what}`;
  const body = [
    `Tool name: ${what}`,
    "What I'd like the AI to do with it: ",
    "How to reach me: ",
    "",
  ].join("\r\n");
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Every link the catalog may open; nothing else is opened from the window. */
const allowedLinks = new Set(
  catalog.services.flatMap((s) =>
    s.options.flatMap((o) =>
      o.fields.flatMap((f) => (f.where ? [f.where.url] : [])),
    ),
  ),
);

export class CatalogActions {
  private signingIn?: AbortController;

  constructor(
    private readonly deps: {
      store: ClientStore;
      gateway: () => Gateway;
      oauthStore: OAuthStateStore;
      openExternal: (url: string) => void;
      /** Tells the window the sign-in address, for the "copy link" fallback. */
      showSignInLink: (url: string) => void;
      onChange: () => void;
      /** Ringkeeper Connect's registered apps this build has (Google, Microsoft). */
      apps?: Record<string, RegisteredApp>;
    },
  ) {}

  /** The catalog, with options that need a registered app this build doesn't have marked unavailable. */
  services(): CatalogService[] {
    const apps = this.deps.apps ?? {};
    return catalog.services.map((s) => ({
      ...s,
      options: s.options.map((o) =>
        o.app && !apps[o.app] ? { ...o, unavailable: true } : o,
      ),
    }));
  }

  add(
    clientId: string,
    serviceId: string,
    optionId: string,
    answers: Record<string, string>,
    name?: string,
    access?: string[],
  ): { connectionId: string; needsSignIn: boolean } {
    let input;
    try {
      input = buildConnection(serviceId, optionId, answers, name, access);
    } catch (err) {
      if (err instanceof CatalogInputError)
        throw new CatalogActionError(err.message);
      throw err;
    }
    const conn = this.deps.store.addConnection(clientId, input);
    return { connectionId: conn.id, needsSignIn: input.auth === "oauth" };
  }

  async signIn(clientId: string, connectionId: string): Promise<void> {
    const client = this.deps.store.list().find((c) => c.id === clientId);
    const conn = client?.connections.find((c) => c.id === connectionId);
    if (!client || !conn || conn.auth !== "oauth")
      throw new StoreError("That connection doesn't use sign-in.");
    const app = conn.oauthApp ? this.deps.apps?.[conn.oauthApp] : undefined;
    if (conn.oauthApp && !app)
      throw new CatalogActionError(
        `Signing in to ${conn.name} needs a newer version of Ringkeeper Connect. Update it, then try again.`,
      );
    this.signingIn?.abort();
    const ctrl = new AbortController();
    this.signingIn = ctrl;
    const openBrowser = (url: string) => {
      this.deps.showSignInLink(url);
      this.deps.openExternal(url);
    };
    try {
      if (conn.kind === "local") {
        // Ringkeeper Connect's own tools: sign in straight with the vendor through our app.
        if (!app)
          throw new CatalogActionError(
            `Signing in to ${conn.name} needs a newer version of Ringkeeper Connect. Update it, then try again.`,
          );
        await signInDirect({
          label: `${conn.name} for ${client.name}`,
          store: this.deps.oauthStore,
          key: oauthKey(clientId, connectionId),
          openBrowser,
          signal: ctrl.signal,
          app,
          scope: conn.scope ?? "",
        });
      } else
        await signIn({
          serverUrl: conn.url,
          label: `${conn.name} for ${client.name}`,
          store: this.deps.oauthStore,
          key: oauthKey(clientId, connectionId),
          openBrowser,
          signal: ctrl.signal,
          ...(app ? { app } : {}),
          ...(conn.scope ? { scope: conn.scope } : {}),
        });
    } catch (err) {
      if (err instanceof SignInError) throw new CatalogActionError(err.message);
      throw err;
    } finally {
      if (this.signingIn === ctrl) this.signingIn = undefined;
    }
    // The saved sign-in changes what the gateway should run.
    this.deps
      .gateway()
      .applyConfig(
        this.deps.store.toGatewayConfig(),
        this.deps.store.activeClientId,
      );
    this.deps.gateway().restartConnection(clientId, connectionId);
    this.deps.onChange();
  }

  cancelSignIn(): void {
    this.signingIn?.abort();
  }

  /** "Request a tool": an email with the search filled in, or the contact page until an address is set. */
  requestTool(searched: string): void {
    this.deps.openExternal(
      REQUEST_TOOL_EMAIL ? requestToolMailto(searched) : REQUEST_TOOL_PAGE,
    );
  }

  openLink(url: string): void {
    if (!allowedLinks.has(url))
      throw new CatalogActionError("That link can't be opened from here.");
    this.deps.openExternal(url);
  }
}
