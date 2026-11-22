// The client list with dozens of clients: pinned ones on top, the recently used, everything
// else A to Z, and archived ones out of the way; and the one list of tools that need
// something before they work. Pure, so it's tested without the window.
import { keyExpiryWarning } from "../shared/key-expiry";
import type { ClientView, ConnectionStatus, ConnectionView } from "../shared/api";
import { CLIENT_SEARCH_FROM, matchesWords } from "./search";

/** "Recent" shows once the list is long enough to search, with this many clients. */
export const RECENT_COUNT = 5;

export interface ClientGroups {
  /** While searching: every client that matches, archived ones included. */
  matches: ClientView[];
  pinned: ClientView[];
  recent: ClientView[];
  /** Every client that isn't pinned or archived, A to Z (recent ones are here too). */
  rest: ClientView[];
  archived: ClientView[];
}

const byName = (a: ClientView, b: ClientView) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

export function clientGroups(clients: ClientView[], query: string): ClientGroups {
  const q = query.trim();
  if (q) return { matches: clients.filter((c) => matchesWords(c.name, q)).sort(byName), pinned: [], recent: [], rest: [], archived: [] };
  const current = clients.filter((c) => !c.archived);
  const unpinned = current.filter((c) => !c.pinned);
  return {
    matches: [],
    pinned: current.filter((c) => c.pinned).sort(byName),
    recent:
      current.length >= CLIENT_SEARCH_FROM
        ? unpinned
            .filter((c) => typeof c.lastUsedAt === "number")
            .sort((a, b) => b.lastUsedAt! - a.lastUsedAt!)
            .slice(0, RECENT_COUNT)
        : [],
    rest: unpinned.sort(byName),
    archived: clients.filter((c) => c.archived).sort(byName),
  };
}

export interface Attention {
  client: ClientView;
  conn: ConnectionView;
  problem: string;
  /** What fixes it: Edit (a key, a setting), Sign in, or checking a tool copied from another client. */
  fix: "edit" | "signin" | "check";
}

/** Whose account a sign-in or key is, in a sentence: "Acme's", or "your" for the tools every client gets. */
export function ownerWords(client: ClientView, everyId: string): string {
  return client.id === everyId ? "your" : `${client.name}'s`;
}

/** What a tool copied from another client says until it's checked. */
export function copiedNote(client: ClientView, conn: ConnectionView): string {
  return `Copied from ${conn.copiedFrom}. Check that its address and settings are ${client.name}'s, add ${client.name}'s keys, then save. AI apps don't get it until then.`;
}

/**
 * Every tool, in every client that isn't archived and in "For every client", that needs a key,
 * a sign-in or a check, or isn't working. Turned-off tools are left out: that was chosen.
 */
export function needsAttention(clients: ClientView[], every: ClientView | undefined, statuses: ConnectionStatus[], everyId: string, now = Date.now()): Attention[] {
  const out: Attention[] = [];
  for (const client of [...clients.filter((c) => !c.archived), ...(every ? [every] : [])]) {
    for (const conn of client.connections) {
      if (conn.off) continue;
      const s = statuses.find((x) => x.clientId === client.id && x.connectionId === conn.id);
      const expiring = keyExpiryWarning(conn, now);
      if (conn.copiedFrom) out.push({ client, conn, problem: copiedNote(client, conn), fix: "check" });
      else if (conn.missingKeys.length) out.push({ client, conn, problem: `Add ${conn.missingKeys.join(" and ")} with Edit to use it.`, fix: "edit" });
      else if ((conn.auth === "oauth" && !conn.signedIn) || s?.status === "needs_signin") {
        out.push({ client, conn, problem: `Sign in with ${ownerWords(client, everyId)} account to use it.`, fix: "signin" });
      } else if (s?.status === "error") out.push({ client, conn, problem: s.problem ?? "It isn't working. Open Edit to check its settings.", fix: "edit" });
      else if (expiring) out.push({ client, conn, problem: expiring, fix: "edit" });
    }
  }
  return out;
}
