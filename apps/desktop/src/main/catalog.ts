// Catalog actions for the window: add a known service, sign in to it, and
// open a vendor's "where to find this key" page.
import {
  ACCESS_SETTING,
  BUILTIN_COMMAND,
  CatalogInputError,
  buildConnection,
  catalog,
  chosenAccess,
  scopeFor,
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
  vendorName,
} from "@ringkeeper/gateway";

import { OWN_APP_LINKS } from "../shared/api.js";

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

/** Every link the catalog may open, and the Google Cloud and Microsoft Entra pages of "your own app"; nothing else is opened from the window. */
const allowedLinks = new Set([
  ...catalog.services.flatMap((s) =>
    s.options.flatMap((o) =>
      o.fields.flatMap((f) => (f.where ? [f.where.url] : [])),
    ),
  ),
  ...OWN_APP_LINKS,
]);

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
      /** The registered apps sign-ins can use, by id: Ringkeeper Connect's (Google, Microsoft) and the user's own. */
      apps?: Record<string, RegisteredApp>;
      /** The user's own apps, by name (see own-apps.ts). */
      ownApps?: () => Array<{ id: string; vendor: string; name: string }>;
    },
  ) {}

  /** The apps a sign-in with this vendor can go through: ours first, then the user's own. */
  private signInApps(vendor: string): Array<{ id: string; name: string }> {
    const apps = this.deps.apps ?? {};
    const label = vendorName(vendor);
    const ours = apps[vendor] ? [{ id: vendor, name: `Ringkeeper Connect's ${label} app` }] : [];
    const own = (this.deps.ownApps?.() ?? []).filter((a) => a.vendor === vendor && apps[a.id]).map((a) => ({ id: a.id, name: a.name }));
    return [...ours, ...own];
  }

  /** The catalog, with options that need a registered app this build doesn't have (and the user hasn't added) marked unavailable. */
  services(): CatalogService[] {
    return catalog.services.map((s) => ({
      ...s,
      options: s.options.map((o) => {
        if (!o.app) return o;
        const signInApps = this.signInApps(o.app);
        return signInApps.length ? { ...o, signInApps } : { ...o, unavailable: true };
      }),
    }));
  }

  add(
    clientId: string,
    serviceId: string,
    optionId: string,
    answers: Record<string, string>,
    name?: string,
    access?: string[],
    /** Which app it signs in through (ours, or one of the user's own); the first offered when left out. */
    appId?: string,
  ): { connectionId: string; needsSignIn: boolean } {
    let input;
    try {
      input = buildConnection(serviceId, optionId, answers, name, access);
    } catch (err) {
      if (err instanceof CatalogInputError)
        throw new CatalogActionError(err.message);
      throw err;
    }
    if (input.oauthApp) {
      const vendor = input.oauthApp;
      const choices = this.signInApps(vendor);
      const chosen = appId ?? choices[0]?.id;
      if (!chosen || !choices.some((c) => c.id === chosen))
        throw new CatalogActionError(
          choices.length
            ? `That ${vendorName(vendor)} app isn't set up anymore. Choose another one.`
            : vendor === "meta"
              ? 'Meta Ads signs in through your own Meta app. Set one up under "Your own apps" first.'
              : `Signing in needs Ringkeeper Connect's own ${vendorName(vendor)} sign-in, which isn't in this version yet.`,
        );
      input = { ...input, oauthApp: chosen };
    }
    const conn = this.deps.store.addConnection(clientId, input);
    return { connectionId: conn.id, needsSignIn: input.auth === "oauth" };
  }

  /**
   * Edit one of Ringkeeper Connect's own tools (a Google or Microsoft account): its name, and
   * what the AI may do. Ticking something new needs a new sign-in (the account has to allow
   * it); unticking keeps the sign-in, and the tool just stops offering those actions.
   */
  editBuiltIn(clientId: string, connectionId: string, name: string, access?: string[]): { needsSignIn: boolean } {
    const client = this.deps.store.list().find((c) => c.id === clientId);
    const conn = client?.connections.find((c) => c.id === connectionId);
    if (!client || !conn) throw new StoreError("That tool no longer exists.");
    if (conn.kind !== "local" || conn.command !== BUILTIN_COMMAND)
      throw new CatalogActionError("Only Ringkeeper Connect's own tools are edited here.");
    const option = catalog.services
      .flatMap((s) => s.options)
      .find((o) => o.kind === "local" && o.command === BUILTIN_COMMAND && o.args[0] === conn.args[0]);
    let fields = conn.fields.map((f) =>
      f.secret ? { name: f.name, secret: true } : { name: f.name, secret: false, value: f.value },
    );
    let scope = conn.scope;
    if (option?.access && access) {
      let chosen;
      try {
        chosen = chosenAccess(option.access, access);
      } catch (err) {
        if (err instanceof CatalogInputError) throw new CatalogActionError(err.message);
        throw err;
      }
      fields = [
        ...fields.filter((f) => f.name !== ACCESS_SETTING),
        { name: ACCESS_SETTING, secret: false, value: chosen.map((a) => a.id).join(",") },
      ];
      scope = scopeFor(option.scope, chosen);
    }
    const updated = this.deps.store.updateConnection(clientId, connectionId, {
      kind: "local",
      name,
      command: conn.command,
      args: [...conn.args],
      fields,
      ...(conn.auth ? { auth: conn.auth } : {}),
      ...(conn.oauthApp ? { oauthApp: conn.oauthApp } : {}),
      ...(scope ? { scope } : {}),
    });
    // The tool restarts with the new ticks (and name).
    this.deps.gateway().applyConfig(this.deps.store.toGatewayConfig(), this.deps.store.activeClientId);
    this.deps.gateway().restartConnection(clientId, connectionId);
    this.deps.onChange();
    return { needsSignIn: updated.auth === "oauth" && !updated.signedIn };
  }

  /**
   * A web connection added by hand or brought in from an AI app, at an address the catalog
   * signs in to through a registered app (Meta's ads server): it takes the first such app
   * offered, with the catalog's permissions. Without one, says how to get one.
   */
  private adoptApp(clientId: string, connectionId: string): void {
    const client = this.deps.store.list().find((c) => c.id === clientId);
    const conn = client?.connections.find((c) => c.id === connectionId);
    if (!client || !conn || conn.kind !== "remote" || conn.oauthApp) return;
    const same = (u: string) => u.replace(/\/+$/, "").toLowerCase();
    const option = catalog.services
      .flatMap((s) => s.options.map((o) => ({ s, o })))
      .find(({ o }) => o.kind === "remote" && o.app && same(o.url) === same(conn.url));
    if (!option?.o.app) return;
    const chosen = this.signInApps(option.o.app)[0];
    if (!chosen)
      throw new CatalogActionError(
        `${conn.name} for ${client.name} only lets apps Meta approved sign in, so Ringkeeper Connect signs in to it through your own ${vendorName(option.o.app)} app. Set one up under "Your own apps", then click Sign in again.`,
      );
    this.deps.store.updateConnection(clientId, connectionId, {
      kind: "remote",
      name: conn.name,
      url: conn.url,
      ...(conn.transport ? { transport: conn.transport } : {}),
      auth: "oauth",
      oauthApp: chosen.id,
      ...(option.o.scope ? { scope: option.o.scope } : {}),
      fields: conn.fields.map((f) => (f.secret ? { name: f.name, secret: true } : { name: f.name, secret: false, value: f.value })),
    });
  }

  async signIn(clientId: string, connectionId: string): Promise<void> {
    this.adoptApp(clientId, connectionId);
    const client = this.deps.store.list().find((c) => c.id === clientId);
    const conn = client?.connections.find((c) => c.id === connectionId);
    if (!client || !conn || conn.auth !== "oauth")
      throw new StoreError("That connection doesn't use sign-in.");
    const app = conn.oauthApp ? this.deps.apps?.[conn.oauthApp] : undefined;
    if (conn.oauthApp?.includes(":") && !app)
      throw new CatalogActionError(
        `The ${vendorName(conn.oauthApp)} app ${conn.name} for ${client.name} signs in through isn't set up on this computer anymore. Add it again under "Your own apps", or remove this tool and add it again.`,
      );
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
      if (conn.kind === "local" || app?.authorizationEndpoint) {
        // Ringkeeper Connect's own tools, and web connections through an app with its own
        // sign-in addresses (Meta): sign in straight with the vendor through that app.
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
