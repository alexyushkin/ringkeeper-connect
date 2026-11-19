// Ringkeeper Connect's own registered apps with Google and Microsoft (see
// docs/registered-apps.md). Release builds get the IDs from the repository's
// Actions settings at build time; a development run can set the same names as
// environment variables. A build without them simply doesn't offer those
// sign-ins.
import type { RegisteredApp } from "@ringkeeper/gateway";
import { META_RETURN_PAGE } from "../shared/api.js";

/** Filled in by scripts/build-desktop.mjs (JSON of the names below); absent in tests and plain runs. */
declare const __RK_APPS__: string | undefined;

function fromBuild(): Record<string, string> {
  try {
    return typeof __RK_APPS__ === "string" && __RK_APPS__ ? (JSON.parse(__RK_APPS__) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** A Google "Desktop app" client: ours, or one in the user's own Google Cloud project. */
export function googleApp(id: string, clientId: string, clientSecret?: string): RegisteredApp {
  return {
    id,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    // Without these, Google gives no lasting sign-in (it would expire within the hour);
    // select_account lets each client use a different Google account.
    authParams: { access_type: "offline", prompt: "consent select_account" },
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
  };
}

export const MICROSOFT_LOGIN = "https://login.microsoftonline.com";

/**
 * A Microsoft "public client" app (no secret: it runs on people's computers): ours, or one in
 * the user's own Entra directory. "common" takes work, school and personal Microsoft accounts.
 */
export function microsoftApp(id: string, clientId: string, tenant = "common", login = MICROSOFT_LOGIN): RegisteredApp {
  return {
    id,
    clientId,
    authorizationEndpoint: `${login}/${tenant}/oauth2/v2.0/authorize`,
    tokenEndpoint: `${login}/${tenant}/oauth2/v2.0/token`,
    authParams: { prompt: "select_account" },
    scopeOnRefresh: true,
  };
}

export const META_GRAPH = "https://graph.facebook.com/v27.0";

/**
 * A Meta app (Facebook Login for Business, with the "Create & manage ads with ads MCP server"
 * use case) the agency made on Meta for Developers. There's no Ringkeeper Connect Meta app:
 * its App secret would have to ship inside every copy, and Meta's secret controls the app.
 * Meta wants the App secret
 * for the token; it gives no way to renew a sign-in, so the first token is swapped for one
 * lasting about 60 days.
 */
export function metaApp(id: string, appId: string, appSecret: string, graph = META_GRAPH, dialog = "https://www.facebook.com/v27.0/dialog/oauth"): RegisteredApp {
  return {
    id,
    clientId: appId,
    clientSecret: appSecret,
    authorizationEndpoint: dialog,
    tokenEndpoint: `${graph}/oauth/access_token`,
    returnPage: META_RETURN_PAGE,
    scopeSeparator: ",",
    tokenByGet: true,
    longLivedExchange: true,
  };
}

/** The registered apps this build can use, by id. */
export function registeredApps(env: Record<string, string | undefined> = process.env, built: Record<string, string> = fromBuild()): Record<string, RegisteredApp> {
  const value = (name: string) => (env[name] || built[name] || "").trim();
  const apps: Record<string, RegisteredApp> = {};
  const googleId = value("RINGKEEPER_GOOGLE_CLIENT_ID");
  if (googleId) apps.google = googleApp("google", googleId, value("RINGKEEPER_GOOGLE_CLIENT_SECRET"));
  const microsoftId = value("RINGKEEPER_MICROSOFT_CLIENT_ID");
  if (microsoftId) apps.microsoft = microsoftApp("microsoft", microsoftId);
  return apps;
}
