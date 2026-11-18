// What "Restore original settings" does, in the words the Restore dialog and
// the Help page share. Kept here so both say the same thing (and for tests).
import type { HostView } from "../shared/api";

/** The AI apps Ringkeeper Connect has changed, which Restore puts back. */
export function appsToRestore(hosts: Array<Pick<HostView, "label" | "status">>): string[] {
  return hosts.filter((h) => h.status !== "not_installed" && h.status !== "not_connected").map((h) => h.label);
}

/** "A", "A and B", "A, B and C". */
export function listOf(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The Restore dialog's text for these AI apps. */
export function restoreBody(hosts: Array<Pick<HostView, "label" | "status">>): string {
  const apps = appsToRestore(hosts);
  if (!apps.length) return "Ringkeeper Connect hasn't changed any AI app's settings on this computer, so there's nothing to restore.";
  return (
    `This takes Ringkeeper Connect out of ${listOf(apps)} and puts back the tools it took over, with the settings they had then. ` +
    "Anything you changed in those apps since stays as it is. Your clients and their tools stay in Ringkeeper Connect, but changes you made there " +
    "(a new key or address) aren't copied back to the apps. A backup is kept first. Restart those apps afterwards."
  );
}

/** The points the Help page lists about Restore. */
export const RESTORE_POINTS = [
  "Ringkeeper Connect is taken out of each AI app it set up.",
  "The tools it took over go back into those apps, with the settings they had when it took them.",
  "Anything you changed in an AI app since stays: a preference, or a tool you added there yourself. If you added a tool again under the same name, yours is kept.",
  "Your clients and their tools stay in Ringkeeper Connect. Changes made there, like a new key, a fixed address or a tool you added only in Ringkeeper Connect, aren't copied back to the apps.",
  "If an app's settings file was damaged, the whole file from before Ringkeeper Connect is put back.",
  "A backup is kept before every change, Restore included.",
];
