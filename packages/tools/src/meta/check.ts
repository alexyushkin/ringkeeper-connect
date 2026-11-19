// "Test connection" for a pasted Meta access token: who it is, how many ad accounts it
// reaches, whether it can read ads, and when it runs out. The token is only ever sent in
// a header or a request body, never in an address, and never appears in a message.
import { META_GRAPH } from "./graph.js";

export type MetaTokenCheck =
  | {
      ok: true;
      /** Ad accounts the token reaches (counted up to `MOST_COUNTED`). */
      accounts: number;
      /** When it stops working (ISO), or null for a token that doesn't run out (a System User's). */
      expiresAt: string | null;
      /** Whether it may pause (ads_management). */
      canPause: boolean;
      message: string;
    }
  | { ok: false; message: string };

const MOST_COUNTED = 500;
const TIMEOUT_MS = 20_000;
export const REFUSED = "Meta didn't accept this token. Check it has ads_read and hasn't expired.";

type Fetch = typeof fetch;

async function call(f: Fetch, url: string, token: string, body?: URLSearchParams): Promise<{ status: number; json: any }> {
  const r = await f(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let json: any = {};
  try {
    json = await r.json();
  } catch {
    // not JSON
  }
  return { status: r.status, json };
}

/** The earliest of Meta's two expiry times that's set (0 means never). */
function expiry(data: any): string | null {
  const times = [data?.expires_at, data?.data_access_expires_at].filter((t): t is number => typeof t === "number" && t > 0);
  return times.length ? new Date(Math.min(...times) * 1000).toISOString() : null;
}

export async function checkMetaToken(token: string, f: Fetch = fetch, graph = META_GRAPH): Promise<MetaTokenCheck> {
  const value = token.trim();
  if (!value) return { ok: false, message: "Paste the access token first." };
  const base = graph.replace(/\/+$/, "");
  try {
    const me = await call(f, `${base}/me?fields=id`, value);
    if (me.status >= 400 || me.json.error) return { ok: false, message: REFUSED };

    let accounts = 0;
    let next: string | undefined = `${base}/me/adaccounts?fields=id&limit=100`;
    while (next && accounts < MOST_COUNTED) {
      const page: { status: number; json: any } = await call(f, next, value);
      if (page.status >= 400 || page.json.error) return { ok: false, message: REFUSED };
      accounts += Array.isArray(page.json.data) ? page.json.data.length : 0;
      next = typeof page.json.paging?.next === "string" && page.json.paging.next.startsWith(base) ? page.json.paging.next : undefined;
    }

    // The token's own details: when it runs out, and what it may do. Best effort.
    let expiresAt: string | null = null;
    let canPause = false;
    const debug = await call(f, `${base}/debug_token`, value, new URLSearchParams({ input_token: value, method: "get" }));
    const data = debug.json?.data;
    if (data && data.is_valid === false) return { ok: false, message: REFUSED };
    if (data) {
      expiresAt = expiry(data);
      const scopes: unknown[] = Array.isArray(data.scopes) ? data.scopes : [];
      canPause = scopes.includes("ads_management");
      if (scopes.length && !scopes.includes("ads_read") && !canPause) return { ok: false, message: REFUSED };
    }
    const count = accounts >= MOST_COUNTED ? `${MOST_COUNTED}+` : String(accounts);
    let message = `Works: ${count} ad account${accounts === 1 ? "" : "s"}.`;
    if (accounts === 0) message += " Assign the client's ad accounts to this token's system user (or person) in Meta Business Settings.";
    if (expiresAt) message += ` This token stops working on ${new Date(expiresAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`;
    return { ok: true, accounts, expiresAt, canPause, message };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return {
      ok: false,
      message: name === "TimeoutError" || name === "AbortError" ? "Meta took too long to answer. Try again in a moment." : "Couldn't reach Meta. Check this computer's internet connection and try again.",
    };
  }
}
