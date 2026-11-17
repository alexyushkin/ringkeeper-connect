// Whether an AI app really uses Ringkeeper Connect. Writing our entry into
// its settings proves nothing; only the app's bridge contacting us does.
import type { HostView } from "./manager.js";

/**
 * - connected: the app's bridge has contacted us since our entry was written
 * - added: entry written, no contact yet, and the app hasn't restarted since (restart to finish)
 * - not_seeing: entry written, the app restarted since, and still no contact
 * - missing: we set the app up before but our entry is gone (the app rewrote its settings)
 * - not_connected: never set up
 * - unreadable / not_installed: as the names say
 */
export type AppStatus = "not_installed" | "unreadable" | "not_connected" | "missing" | "added" | "connected" | "not_seeing";

/** How long after an app starts it gets to contact us before we say we're "not seeing" it. */
export const CONTACT_GRACE_MS = 60_000;

export function appStatus(
  view: Pick<HostView, "status" | "entryWrittenAt">,
  /** Last time this app's bridge contacted us (ms), if ever. */
  lastContactAt: number | undefined,
  /** When the app was last started (ms), if we can tell (desktop apps on Windows and macOS). */
  appStartedAt: number | undefined,
  now: number,
): AppStatus {
  switch (view.status) {
    case "not_installed":
    case "unreadable":
    case "not_connected":
      return view.status;
    case "entry_missing":
      return "missing";
    case "entry_present": {
      const writtenAt = view.entryWrittenAt;
      if (lastContactAt !== undefined && lastContactAt >= (writtenAt ?? 0)) return "connected";
      // Without a write time (an entry from an older version) we can't tell whether
      // the app restarted since, so don't claim it's ignoring us.
      if (writtenAt !== undefined && appStartedAt !== undefined && appStartedAt > writtenAt && now - appStartedAt > CONTACT_GRACE_MS) {
        return "not_seeing";
      }
      return "added";
    }
  }
}

/** Which AI app a connecting client is, from the name it reports (fallback when the bridge didn't say). */
export function appForClientName(name: string | undefined): "claude-desktop" | "cursor" | "claude-code" | undefined {
  if (!name) return undefined;
  if (name === "claude-code") return "claude-code";
  if (name.startsWith("cursor")) return "cursor";
  if (name === "claude-ai" || name.startsWith("local-agent-mode-")) return "claude-desktop";
  return undefined;
}
