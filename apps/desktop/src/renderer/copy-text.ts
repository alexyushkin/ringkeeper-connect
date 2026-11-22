// What the window says after a copy is brought in. Pure, so it's tested without the window.
import type { CopyResult } from "../shared/api";
import { listOf } from "./restore-text";

export function copyResultText(r: CopyResult): string {
  const parts: string[] = [];
  if (r.clients.length) parts.push(`Brought in ${listOf(r.clients)}.`);
  for (const x of r.renamed) parts.push(`${x.from} is called "${x.to}" here, because you already had a ${x.from}. Rename either one any time.`);
  if (r.everyClient.length) parts.push(`${r.clients.length ? "Also brought in" : "Brought in"} for every client: ${listOf(r.everyClient)}.`);
  if (!parts.length) return "Nothing was brought in: everything in the copy is here already.";
  parts.push("If a tool says it needs a sign-in, sign in once more. Then delete the copy file: it holds your clients' keys.");
  return parts.join(" ");
}
