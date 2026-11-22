// Catalog actions for the window: add a known service, sign in to it, and
// open a vendor's "where to find this key" page.
import {
  ACCESS_SETTING,
  BUILTIN_COMMAND,
  CatalogInputError,
  KEY_EXPIRES_SETTING,
  buildConnection,
  catalog,
  checkField,
  chosenAccess,
  scopeFor,
  type CatalogOption,
  type CatalogService,
  type KeyCheck,
} from "@ringkeeper/catalog";
import { checkMetaToken } from "@ringkeeper/tools";
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

import { OWN_APP_LINKS, type ConnectionView } from "../shared/api.js";
import { serviceOf } from "./help.js";

export class CatalogActionError extends Error {}

/** Meta's own ads server: it only lets the AI apps Meta approved in (a token from any other app gets 401). */
export const META_ADS_SERVER = "https://mcp.facebook.com/ads";

/** What "Test connection" found. `reached` is false when the vendor couldn't be asked at all (offline). */
export interface KeyCheckResult {
  ok: boolean;
  message: string;
  /** When the key stops working (ISO), or null when it doesn't run out or isn't known. */
  expiresAt: string | null;
  reached: boolean;
}

/** Checks a pasted key with its vendor. */
export async function checkKeyWithVendor(check: KeyCheck, key: string, f: typeof fetch = fetch): Promise<KeyCheckResult> {
  switch (check) {
    case "meta-token": {
      const r = await checkMetaToken(key, f);
      if (r.ok) return { ok: true, message: r.message, expiresAt: r.expiresAt, reached: true };
      return { ok: false, message: r.message, expiresAt: null, reached: !/Couldn't reach|took too long/.test(r.message) };
    }
  }
}

/** The key a check looks at: the option's first required secret field. */
function checkedField(option: CatalogOption) {
  return option.fields.find((f) => f.secret && f.required);
}

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

/** Where "Did it work?" reports go, as an email the user sees and chooses to send. */
export const FEEDBACK_EMAIL = "alexey@yushkin.us";

/** Whether to ask "Did it work?" after this sign-in: the first time for its service on this computer. */
export function feedbackServiceFor(
  conn: ConnectionView,
  answered: Record<string, unknown> | undefined,
  services: CatalogService[] = catalog.services,
): CatalogService | undefined {
  const service = serviceOf(conn, services);
  return service && !(service.id in (answered ?? {})) ? service : undefined;
}

/**
 * The email "Worked" or "Had a problem" opens. Only the service, how it connects, its status here,
 * the version and the system: never the client's name (taken out of the status too), never a key.
 */
export function feedbackMailto(
  input: {
    worked: boolean;
    service: { id: string; name: string; beta?: boolean };
    how: string;
    status: string;
    clientName: string;
    version: string;
    system: string;
  },
  email = FEEDBACK_EMAIL,
): string {
  const scrub = (t: string) => (input.clientName.trim() ? t.split(input.clientName).join("[client]") : t);
  const subject = input.worked ? `Ringkeeper Connect: ${input.service.name} worked` : `Ringkeeper Connect: a problem with ${input.service.name}`;
  const body = [
    `Tool: ${input.service.name}${input.service.beta ? " (Beta)" : ""}`,
    `How it connects: ${input.how}`,
    `Result: ${input.worked ? "Worked" : "Had a problem"}`,
    `Status in Ringkeeper Connect: ${scrub(input.status).slice(0, 500)}`,
    `Ringkeeper Connect ${input.version} on ${input.system}`,
    "",
    ...(input.worked ? ["Anything else (optional): ", ""] : ["What happened: ", "", "What you expected: ", ""]),
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

/** The sign-in a Google account needs after Edit ticked something new: only the new permissions. */
export function incrementalScope(previous: string, wanted: string): string | undefined {
  const had = new Set(previous.split(/\s+/).filter(Boolean));
  const added = wanted.split(/\s+/).filter((s) => s && !had.has(s));
  return added.length ? [...new Set(["openid", "email", ...added])].join(" ") : undefined;
}

export class CatalogActions {
  private signingIn?: AbortController;
  /**
   * Google accounts whose Edit ticked something new, by client/connection: what they had
   * allowed before. Their next sign-in asks only for what's new, and Google keeps the rest
   * (include_granted_scopes). Kept until that sign-in; after a restart it's a full sign-in.
   */
  private readonly grantedBefore = new Map<string, string>();

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
      /** Checks a pasted key with its vendor ("Test connection"); swappable in tests. */
      checkKey?: (check: KeyCheck, key: string) => Promise<KeyCheckResult>;
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
    /** When the pasted key stops working, from its check (kept so the tool can warn a week ahead). */
    keyExpires?: string | null,
  ): { connectionId: string; needsSignIn: boolean } {
    let input;
    try {
      input = buildConnection(serviceId, optionId, answers, name, access);
    } catch (err) {
      if (err instanceof CatalogInputError)
        throw new CatalogActionError(err.message);
      throw err;
    }
    if (keyExpires) input = { ...input, fields: [...input.fields, { name: KEY_EXPIRES_SETTING, value: keyExpires, secret: false }] };
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
              : vendor === "hubspot" || vendor === "asana"
                ? `${vendorName(vendor)} signs in through your own ${vendorName(vendor)} app. Set one up under "Your own apps" first.`
                : `Signing in needs Ringkeeper Connect's own ${vendorName(vendor)} sign-in, which isn't in this version yet.`,
        );
      input = { ...input, oauthApp: chosen };
    }
    const conn = this.deps.store.addConnection(clientId, input);
    return { connectionId: conn.id, needsSignIn: input.auth === "oauth" };
  }

  private option(serviceId: string, optionId: string): CatalogOption | undefined {
    return catalog.services.find((s) => s.id === serviceId)?.options.find((o) => o.id === optionId);
  }

  /** The catalog option one of Ringkeeper Connect's own tools was added with. */
  private builtInOption(conn: { kind: string; command?: string; args?: string[]; auth?: string }, preferCheck = false): CatalogOption | undefined {
    if (conn.kind !== "local" || conn.command !== BUILTIN_COMMAND) return undefined;
    const all = catalog.services
      .flatMap((s) => s.options)
      .filter((o) => o.kind === "local" && o.command === BUILTIN_COMMAND && o.args[0] === conn.args?.[0]);
    if (preferCheck) return all.find((o) => o.check) ?? all[0];
    // Meta Ads has two: the one this tool was added with signs in, or takes a pasted token.
    return all.find((o) => (o.auth === "oauth") === (conn.auth === "oauth")) ?? all[0];
  }

  /**
   * "Test connection": checks a pasted key with its vendor. For a tool already added, a
   * key left empty means the one saved for it.
   */
  async testKey(
    serviceId: string,
    optionId: string,
    answers: Record<string, string>,
    existing?: { clientId: string; connectionId: string },
  ): Promise<KeyCheckResult> {
    let option = this.option(serviceId, optionId);
    let saved: Record<string, string> = {};
    if (existing) {
      const client = this.deps.store.toGatewayConfig().clients.find((c) => c.id === existing.clientId);
      const conn = client?.connections.find((c) => c.id === existing.connectionId);
      if (!conn) throw new StoreError("That tool no longer exists.");
      option = this.builtInOption(conn as { kind: string; command?: string; args?: string[] }, true);
      saved = conn.kind === "local" ? (conn.env ?? {}) : {};
    }
    const field = option ? checkedField(option) : undefined;
    if (!option?.check || !field) throw new CatalogActionError("This tool can't be tested here.");
    const typed = (answers[field.id] ?? "").trim();
    let key = typed || saved[field.id] || "";
    if (!key) return { ok: false, message: `Paste the ${field.label.toLowerCase()} first.`, expiresAt: null, reached: false };
    try {
      key = checkField(field, key);
    } catch (err) {
      if (err instanceof CatalogInputError) return { ok: false, message: err.message, expiresAt: null, reached: false };
      throw err;
    }
    return (this.deps.checkKey ?? checkKeyWithVendor)(option.check, key);
  }

  /**
   * Add from the catalog, checking a pasted key with its vendor first when the tool can
   * (Meta Ads): a key the vendor refused isn't added; when the vendor can't be reached,
   * it's added unchecked.
   */
  async addChecked(
    clientId: string,
    serviceId: string,
    optionId: string,
    answers: Record<string, string>,
    name?: string,
    access?: string[],
    appId?: string,
  ): Promise<{ connectionId: string; needsSignIn: boolean }> {
    const option = this.option(serviceId, optionId);
    let expires: string | null = null;
    if (option?.check) {
      const r = await this.testKey(serviceId, optionId, answers);
      if (!r.ok && r.reached) throw new CatalogActionError(r.message);
      expires = r.ok ? r.expiresAt : null;
    }
    return this.add(clientId, serviceId, optionId, answers, name, access, appId, expires);
  }

  /** editBuiltIn, checking a newly pasted key with its vendor first (as addChecked). */
  async editBuiltInChecked(
    clientId: string,
    connectionId: string,
    name: string,
    access?: string[],
    keys?: Record<string, string>,
  ): Promise<{ needsSignIn: boolean }> {
    const typed = Object.fromEntries(Object.entries(keys ?? {}).filter(([, v]) => String(v ?? "").trim()));
    if (!Object.keys(typed).length) return this.editBuiltIn(clientId, connectionId, name, access);
    const r = await this.testKey("", "", typed, { clientId, connectionId });
    if (!r.ok && r.reached) throw new CatalogActionError(r.message);
    return this.editBuiltIn(clientId, connectionId, name, access, typed, r.ok ? r.expiresAt : undefined);
  }

  /**
   * Edit one of Ringkeeper Connect's own tools (a Google or Microsoft account): its name, and
   * what the AI may do. Ticking something new needs a new sign-in (the account has to allow
   * it); unticking keeps the sign-in, and the tool just stops offering those actions.
   */
  editBuiltIn(
    clientId: string,
    connectionId: string,
    name: string,
    access?: string[],
    /** A new key for a tool that takes one (Meta Ads), by field; empty keeps the saved one. */
    keys?: Record<string, string>,
    /** When that new key stops working: a date, null when it doesn't, undefined when unknown. */
    keyExpires?: string | null,
  ): { needsSignIn: boolean } {
    const client = this.deps.store.view(clientId);
    const conn = client?.connections.find((c) => c.id === connectionId);
    if (!client || !conn) throw new StoreError("That tool no longer exists.");
    if (conn.kind !== "local" || conn.command !== BUILTIN_COMMAND)
      throw new CatalogActionError("Only Ringkeeper Connect's own tools are edited here.");
    const option = this.builtInOption(conn, !!keys && Object.keys(keys).length > 0);
    let fields: Array<{ name: string; secret: boolean; value?: string }> = conn.fields.map((f) =>
      f.secret ? { name: f.name, secret: true } : { name: f.name, secret: false, value: f.value },
    );
    for (const [id, raw] of Object.entries(keys ?? {})) {
      const field = option?.fields.find((f) => f.id === id);
      if (!field || !String(raw ?? "").trim()) continue;
      let value;
      try {
        value = checkField(field, raw);
      } catch (err) {
        if (err instanceof CatalogInputError) throw new CatalogActionError(err.message);
        throw err;
      }
      fields = fields.map((f) => (f.name === id ? { name: id, secret: true, value } : f));
      // A new key: when the old one ran out no longer applies.
      fields = fields.filter((f) => f.name !== KEY_EXPIRES_SETTING);
      if (keyExpires) fields.push({ name: KEY_EXPIRES_SETTING, secret: false, value: keyExpires });
    }
    let scope = conn.scope;
    const signedInBefore = conn.auth === "oauth" && !!conn.signedIn;
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
      if (conn.auth) scope = scopeFor(option.scope, chosen);
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
    const isGoogle = conn.oauthApp === "google" || !!conn.oauthApp?.startsWith("google:");
    if (isGoogle && signedInBefore && !updated.signedIn && conn.scope) this.grantedBefore.set(`${clientId}/${connectionId}`, conn.scope);
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
    const client = this.deps.store.view(clientId);
    const conn = client?.connections.find((c) => c.id === connectionId);
    if (!client || !conn || conn.kind !== "remote") return;
    const same = (u: string) => u.replace(/\/+$/, "").toLowerCase();
    // Meta's own ads server takes only the AI apps Meta approved, whatever app signs in: it
    // becomes Ringkeeper Connect's own Meta Ads tools, signed in through your Meta app.
    if (same(conn.url) === same(META_ADS_SERVER)) {
      const meta = catalog.services.find((s) => s.id === "meta_ads")?.options.find((o) => o.kind === "local" && o.auth === "oauth");
      if (!meta || meta.kind !== "local" || !meta.app) return;
      const chosen = this.signInApps(meta.app)[0];
      if (!chosen)
        throw new CatalogActionError(
          `${conn.name} for ${client.name} signs in through your own Meta app. Set one up under "Your own apps", then click Sign in again. Or remove it and add Meta Ads with an access token instead.`,
        );
      const ticks = chosenAccess(meta.access ?? [], undefined);
      this.deps.store.updateConnection(clientId, connectionId, {
        kind: "local",
        name: conn.name,
        command: meta.command,
        args: [...meta.args],
        auth: "oauth",
        oauthApp: chosen.id,
        scope: scopeFor(meta.scope, ticks),
        fields: [{ name: ACCESS_SETTING, secret: false, value: ticks.map((a) => a.id).join(",") }],
      });
      return;
    }
    if (conn.oauthApp) return;
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
    const client = this.deps.store.view(clientId);
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
        // After Edit ticked something new on a Google account: ask only for that.
        const before = this.grantedBefore.get(`${clientId}/${connectionId}`);
        const onlyNew = before ? incrementalScope(before, conn.scope ?? "") : undefined;
        await signInDirect({
          label: `${conn.name} for ${client.name}`,
          store: this.deps.oauthStore,
          key: oauthKey(clientId, connectionId),
          openBrowser,
          signal: ctrl.signal,
          app,
          scope: onlyNew ?? conn.scope ?? "",
          ...(onlyNew ? { authParams: { include_granted_scopes: "true" } } : {}),
        });
        this.grantedBefore.delete(`${clientId}/${connectionId}`);
      } else
        await signIn({
          serverUrl: conn.url,
          // A service that takes Ringkeeper Connect's app-ID page instead of registrations (Vercel).
          ...(!app && this.usesAppIdPage(conn.url) ? { appIdPage: true } : {}),
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
    // The first sign-in to this service here: ask "Did it work?" (answered once per service).
    const signedIn = this.deps.store.view(clientId)?.connections.find((c) => c.id === connectionId);
    const settings = this.deps.store.settings;
    const ask = signedIn && feedbackServiceFor(signedIn, settings.toolFeedback);
    if (ask) this.deps.store.updateSettings({ feedbackAsk: { clientId, connectionId, serviceId: ask.id } });
    this.deps.onChange();
  }

  /** Whether the catalog says this address signs in with the app-ID page. */
  private usesAppIdPage(url: string): boolean {
    const same = (a: string) => {
      try {
        const x = new URL(a);
        const y = new URL(url);
        return x.origin === y.origin && x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "");
      } catch {
        return false;
      }
    };
    return catalog.services.some((s) => s.options.some((o) => o.kind === "remote" && o.appIdPage && same(o.url)));
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
