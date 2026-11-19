// Ringkeeper Connect's own registered apps with Google and Microsoft (see
// docs/registered-apps.md). Release builds get the IDs from the repository's
// Actions settings at build time; a development run can set the same names as
// environment variables. A build without them simply doesn't offer those
// sign-ins.
import type { RegisteredApp } from "@ringkeeper/gateway";

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

/** The registered apps this build can use, by id. */
export function registeredApps(env: Record<string, string | undefined> = process.env, built: Record<string, string> = fromBuild()): Record<string, RegisteredApp> {
  const value = (name: string) => (env[name] || built[name] || "").trim();
  const apps: Record<string, RegisteredApp> = {};
  const googleId = value("RINGKEEPER_GOOGLE_CLIENT_ID");
  if (googleId) apps.google = googleApp("google", googleId, value("RINGKEEPER_GOOGLE_CLIENT_SECRET"));
  const microsoftId = value("RINGKEEPER_MICROSOFT_CLIENT_ID");
  if (microsoftId) {
    apps.microsoft = {
      id: "microsoft",
      clientId: microsoftId,
      // "common": work, school and personal Microsoft accounts.
      authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      authParams: { prompt: "select_account" },
      scopeOnRefresh: true,
    };
  }
  return apps;
}
