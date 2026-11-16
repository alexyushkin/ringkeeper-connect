// Catalog actions for the window: add a known service, sign in to it, and
// open a vendor's "where to find this key" page.
import { CatalogInputError, buildConnection, catalog, type CatalogService } from "@ringkeeper/catalog";
import { SignInError, StoreError, oauthKey, signIn, type ClientStore, type Gateway, type OAuthStateStore } from "@ringkeeper/gateway";

export class CatalogActionError extends Error {}

/** Every link the catalog may open; nothing else is opened from the window. */
const allowedLinks = new Set(catalog.services.flatMap((s) => s.options.flatMap((o) => o.fields.flatMap((f) => (f.where ? [f.where.url] : [])))));

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
    },
  ) {}

  services(): CatalogService[] {
    return catalog.services;
  }

  add(clientId: string, serviceId: string, optionId: string, answers: Record<string, string>, name?: string): { connectionId: string; needsSignIn: boolean } {
    let input;
    try {
      input = buildConnection(serviceId, optionId, answers, name);
    } catch (err) {
      if (err instanceof CatalogInputError) throw new CatalogActionError(err.message);
      throw err;
    }
    const conn = this.deps.store.addConnection(clientId, input);
    return { connectionId: conn.id, needsSignIn: input.kind === "remote" && input.auth === "oauth" };
  }

  async signIn(clientId: string, connectionId: string): Promise<void> {
    const client = this.deps.store.list().find((c) => c.id === clientId);
    const conn = client?.connections.find((c) => c.id === connectionId);
    if (!client || !conn || conn.kind !== "remote" || conn.auth !== "oauth") throw new StoreError("That connection doesn't use sign-in.");
    this.signingIn?.abort();
    const ctrl = new AbortController();
    this.signingIn = ctrl;
    try {
      await signIn({
        serverUrl: conn.url,
        label: `${conn.name} for ${client.name}`,
        store: this.deps.oauthStore,
        key: oauthKey(clientId, connectionId),
        openBrowser: (url) => {
          this.deps.showSignInLink(url);
          this.deps.openExternal(url);
        },
        signal: ctrl.signal,
      });
    } catch (err) {
      if (err instanceof SignInError) throw new CatalogActionError(err.message);
      throw err;
    } finally {
      if (this.signingIn === ctrl) this.signingIn = undefined;
    }
    // The saved sign-in changes what the gateway should run.
    this.deps.gateway().applyConfig(this.deps.store.toGatewayConfig(), this.deps.store.activeClientId);
    this.deps.gateway().restartConnection(clientId, connectionId);
    this.deps.onChange();
  }

  cancelSignIn(): void {
    this.signingIn?.abort();
  }

  openLink(url: string): void {
    if (!allowedLinks.has(url)) throw new CatalogActionError("That link can't be opened from here.");
    this.deps.openExternal(url);
  }
}
