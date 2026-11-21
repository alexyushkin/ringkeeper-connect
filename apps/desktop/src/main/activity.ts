// What AI apps did for each client, newest first: which tool, whether it looked, changed or
// deleted, which AI app asked and how it ended. It never holds what was sent or what came
// back, so there is nothing secret or personal in it. Kept in one small file per install.
import fs from "node:fs";
import { writeJsonAtomic, type Activity } from "@ringkeeper/gateway";

/** How many entries are kept per client. Older ones are dropped. */
export const ACTIVITY_PER_CLIENT = 200;

const KINDS = new Set(["read", "change", "delete"]);
const OUTCOMES = new Set(["ran", "failed", "not_allowed", "look_only", "wrong_client"]);

function valid(a: unknown): a is Activity {
  if (!a || typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  return (
    typeof x.at === "number" &&
    typeof x.clientId === "string" &&
    typeof x.connectionId === "string" &&
    typeof x.connectionName === "string" &&
    typeof x.tool === "string" &&
    typeof x.app === "string" &&
    KINDS.has(x.kind as string) &&
    OUTCOMES.has(x.outcome as string)
  );
}

export class ActivityLog {
  private byClient = new Map<string, Activity[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly file: string,
    private readonly saveAfterMs = 2_000,
  ) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      const clients = raw && typeof raw === "object" ? (raw as { clients?: unknown }).clients : undefined;
      if (clients && typeof clients === "object") {
        for (const [id, list] of Object.entries(clients as Record<string, unknown>)) {
          if (Array.isArray(list)) this.byClient.set(id, list.filter(valid).slice(0, ACTIVITY_PER_CLIENT));
        }
      }
    } catch {
      // No file yet, or one that can't be read: start empty. It's a convenience, never needed to run.
    }
  }

  record(a: Activity): void {
    const list = this.byClient.get(a.clientId) ?? [];
    list.unshift(a);
    if (list.length > ACTIVITY_PER_CLIENT) list.length = ACTIVITY_PER_CLIENT;
    this.byClient.set(a.clientId, list);
    this.saveSoon();
  }

  /** Newest first. */
  list(clientId: string): Activity[] {
    return [...(this.byClient.get(clientId) ?? [])];
  }

  /** Drop the entries of clients that no longer exist. */
  keepOnly(clientIds: Iterable<string>): void {
    const keep = new Set(clientIds);
    let dropped = false;
    for (const id of [...this.byClient.keys()]) {
      if (!keep.has(id)) {
        this.byClient.delete(id);
        dropped = true;
      }
    }
    if (dropped) this.saveSoon();
  }

  private saveSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.saveAfterMs);
    this.timer.unref?.();
  }

  /** Write now (also called when the app quits). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      writeJsonAtomic(this.file, { version: 1, clients: Object.fromEntries(this.byClient) }, 0o600);
    } catch {
      // Losing the list must never get in the way of the work itself.
    }
  }
}
