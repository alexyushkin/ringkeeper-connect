import { describe, expect, it } from "vitest";
import { CatalogInputError, buildConnection, catalog, findService, validateCatalog } from "../packages/catalog/src/index.js";

describe("the catalog data", () => {
  it("is consistent: every placeholder has a field, links and addresses are https, patterns compile", () => {
    expect(validateCatalog(catalog)).toEqual([]);
  });

  it("covers the v1 services, with no Google services", () => {
    expect(catalog.services.map((s) => s.id)).toEqual(["n8n", "supabase", "airtable", "notion", "stripe"]);
    expect(JSON.stringify(catalog)).not.toMatch(/google/i);
  });

  it("prefers sign-in where the vendor's sign-in works for any app", () => {
    for (const id of ["supabase", "airtable", "notion"]) {
      const rec = findService(id)!.options.find((o) => o.recommended)!;
      expect(rec.kind === "remote" && rec.auth).toBe("oauth");
    }
  });

  it("gives every key a place to find it", () => {
    for (const s of catalog.services) for (const o of s.options) for (const f of o.fields) if (f.secret) expect(f.where?.url, `${s.id}/${f.id}`).toMatch(/^https:\/\//);
  });
});

describe("turning answers into a connection", () => {
  it("n8n: accepts the plain address or the full MCP address, and keeps the token secret", () => {
    for (const address of ["https://acme.app.n8n.cloud", "acme.app.n8n.cloud", "https://acme.app.n8n.cloud/mcp-server/http", "https://acme.app.n8n.cloud/home/workflows"]) {
      const c = buildConnection("n8n", "token", { N8N_URL: address, N8N_MCP_TOKEN: " tok_123 " });
      expect(c).toEqual({
        kind: "remote",
        name: "n8n",
        url: "https://acme.app.n8n.cloud/mcp-server/http",
        fields: [{ name: "Authorization", value: "Bearer tok_123", secret: true }],
      });
    }
    expect(() => buildConnection("n8n", "token", { N8N_URL: "http://acme.example.com", N8N_MCP_TOKEN: "x" })).toThrow(/https/);
  });

  it("Supabase: sign-in, with the optional project kept to the address only when given", () => {
    expect(buildConnection("supabase", "oauth", {})).toEqual({ kind: "remote", name: "Supabase", url: "https://mcp.supabase.com/mcp", fields: [], auth: "oauth" });
    expect(buildConnection("supabase", "oauth", { PROJECT_REF: "abcdefghijklmnopqrst" }).kind === "remote" && buildConnection("supabase", "oauth", { PROJECT_REF: "abcdefghijklmnopqrst" })).toMatchObject({
      url: "https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnopqrst",
    });
  });

  it("Stripe: takes an agent key, and explains why other keys won't do", () => {
    expect(buildConnection("stripe", "agent-key", { STRIPE_AGENT_KEY: "rk_live_abc123" })).toMatchObject({
      url: "https://mcp.stripe.com/",
      fields: [{ name: "Authorization", value: "Bearer rk_live_abc123", secret: true }],
    });
    expect(() => buildConnection("stripe", "agent-key", { STRIPE_AGENT_KEY: "sk_live_abc" })).toThrow(/no longer accepts those/);
    expect(() => buildConnection("stripe", "agent-key", { STRIPE_AGENT_KEY: "pk_live_abc" })).toThrow(/publishable key/);
    expect(() => buildConnection("stripe", "agent-key", { STRIPE_AGENT_KEY: "hello" })).toThrow(/rk_live_/);
  });

  it("asks for missing answers by their label", () => {
    expect(() => buildConnection("airtable", "token", {})).toThrow(new CatalogInputError('Fill in "Personal access token".'));
  });

  it("uses the name the user gives, e.g. a second Airtable", () => {
    expect(buildConnection("airtable", "oauth", {}, "Airtable (marketing)").name).toBe("Airtable (marketing)");
  });
});
