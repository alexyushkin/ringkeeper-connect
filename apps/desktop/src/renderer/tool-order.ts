// How "Add a tool" lists the catalog: by group, and in each group the tools tried with a real
// account first, then the ones marked Beta, each in the catalog's own order. Pure, so it's
// tested without the window.
import type { CatalogService } from "../shared/api";
import { matchesWords } from "./search";

/** The order "Add a tool" shows its groups in (the catalog's own order). */
export const GROUP_ORDER = [
  "Data",
  "Automations",
  "CRM and sales",
  "Marketing and email",
  "Websites",
  "Payments",
  "Accounting",
  "Work and projects",
  "Scheduling",
  "Developers",
  "Voice and research",
  "Other",
];

export function matchesService(s: CatalogService, q: string): boolean {
  return matchesWords(`${s.name} ${s.group} ${s.description} ${(s.tags ?? []).join(" ")}`, q);
}

/** The groups to show for a search (empty: all), each with its tools, tried ones first. */
export function pickerGroups(services: CatalogService[], query: string): Array<{ group: string; items: CatalogService[] }> {
  const shown = services.filter((s) => matchesService(s, query.trim()));
  return GROUP_ORDER.map((group) => {
    const inGroup = shown.filter((s) => s.group === group);
    return { group, items: [...inGroup.filter((s) => !s.beta), ...inGroup.filter((s) => s.beta)] };
  }).filter((g) => g.items.length);
}
