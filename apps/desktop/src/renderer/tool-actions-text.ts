// Words and checks for a tool's actions and for moving tools, kept apart from the
// dialogs so they can be tested without a window.
import type { ClientView, ConnectionStatus, ConnectionView } from "../shared/api";

/** One line under a tool's name when not all of its actions are given to the AI apps. */
export function actionsNote(conn: Pick<ConnectionView, "actions" | "off">, status?: Pick<ConnectionStatus, "tools" | "offered">): string | null {
  if (conn.off || conn.actions === undefined) return null;
  const counts = status && status.tools > 0 ? ` (${status.offered} of ${status.tools})` : "";
  if (conn.actions === "read") return `The AI gets only the actions that read${counts}.`;
  const n = conn.actions.length;
  return `The AI gets ${n === 1 ? "1 chosen action" : `${n} chosen actions`}${status && status.tools > 0 ? ` of ${status.tools}` : ""}.`;
}

/** The same tool in other clients: same address, or same program with the same options. */
export function sameToolIn(clients: ClientView[], conn: ConnectionView, exceptClientId: string): Array<{ client: ClientView; conn: ConnectionView }> {
  const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
  const same = (c: ConnectionView) =>
    c.kind === conn.kind &&
    (c.kind === "remote" && conn.kind === "remote"
      ? norm(c.url) === norm(conn.url)
      : c.kind === "local" && conn.kind === "local" && c.command === conn.command && c.args.join("\n") === conn.args.join("\n"));
  return clients.filter((cl) => cl.id !== exceptClientId).flatMap((cl) => cl.connections.filter(same).map((c) => ({ client: cl, conn: c })));
}
