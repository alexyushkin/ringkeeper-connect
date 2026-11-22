// When a pasted key (a Meta access token) stops working: what the tool's card says a week
// ahead, and after. Pure, so it's tested without the window.
import { KEY_EXPIRES_SETTING } from "./api";

/** Warn this many days before a pasted key stops working. */
export const KEY_WARN_DAYS = 7;

/** Warn this many days before a saved sign-in ends. */
export const SIGN_IN_WARN_DAYS = 7;

/** What a tool's card says about a sign-in that ends soon or already has (where the service said when); null otherwise. */
export function signInEndWarning(conn: { auth?: string; signedIn?: boolean; signInEndsAt?: number }, now = Date.now()): string | null {
  if (conn.auth !== "oauth" || !conn.signedIn || typeof conn.signInEndsAt !== "number") return null;
  const day = new Date(conn.signInEndsAt).toLocaleDateString("en-US", { month: "long", day: "numeric" });
  if (conn.signInEndsAt <= now) return `This sign-in ended on ${day}. Click Sign in to sign in again.`;
  if (conn.signInEndsAt - now <= SIGN_IN_WARN_DAYS * 24 * 60 * 60 * 1000) return `This sign-in ends on ${day}, as the service set it. Click Sign in before then to keep it working.`;
  return null;
}

/** What a tool's card says about a key that stops working soon or already has; null otherwise. */
export function keyExpiryWarning(conn: { fields: Array<{ name: string; value?: string }> }, now = Date.now()): string | null {
  const when = conn.fields.find((f) => f.name === KEY_EXPIRES_SETTING)?.value;
  const at = when ? Date.parse(when) : NaN;
  if (!Number.isFinite(at)) return null;
  const day = new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric" });
  if (at <= now) return `This access token stopped working on ${day}. Paste a new one with Edit.`;
  if (at - now <= KEY_WARN_DAYS * 24 * 60 * 60 * 1000) return `This access token stops working on ${day}. Paste a new one with Edit before then.`;
  return null;
}
