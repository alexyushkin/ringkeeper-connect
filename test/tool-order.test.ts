// "Add a tool": in each group, the tools tried with a real account first, then the Beta ones.
import { describe, expect, it } from "vitest";
import { catalog } from "../packages/catalog/src/index.js";
import { pickerGroups } from "../apps/desktop/src/renderer/tool-order.js";
import type { CatalogService } from "../apps/desktop/src/shared/api.js";

const svc = (id: string, group: string, beta?: boolean): CatalogService => ({ id, name: id, group: group as CatalogService["group"], description: `${id} tool`, ...(beta ? { beta } : {}), options: [] });

describe("the order of Add a tool", () => {
  it("puts tried tools first in each group, then Beta ones, each in the catalog's order", () => {
    const services = [svc("a-beta", "Data", true), svc("b", "Data"), svc("c-beta", "Data", true), svc("d", "Data"), svc("crm-beta", "CRM and sales", true)];
    expect(pickerGroups(services, "").map((g) => [g.group, g.items.map((s) => s.id)])).toEqual([
      ["Data", ["b", "d", "a-beta", "c-beta"]],
      ["CRM and sales", ["crm-beta"]],
    ]);
  });

  it("keeps that order while searching, and leaves out groups with nothing found", () => {
    const services = [svc("airtable-beta", "Data", true), svc("airtable", "Data"), svc("zapier", "Automations")];
    expect(pickerGroups(services, "airtable").map((g) => [g.group, g.items.map((s) => s.id)])).toEqual([["Data", ["airtable", "airtable-beta"]]]);
  });

  it("with the real catalog: every tool once, and no Beta tool ahead of a tried one in its group", () => {
    const groups = pickerGroups(catalog.services, "");
    expect(groups.flatMap((g) => g.items).length).toBe(catalog.services.length);
    for (const g of groups) {
      const firstBeta = g.items.findIndex((s) => s.beta);
      if (firstBeta >= 0) expect(g.items.slice(firstBeta).every((s) => s.beta)).toBe(true);
    }
    // Tried ones come first where a group has both (Data: Airtable, Supabase, Neon…).
    expect(groups.find((g) => g.group === "Data")!.items[0]!.beta).toBeFalsy();
  });
});
