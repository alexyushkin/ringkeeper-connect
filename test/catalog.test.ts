import { describe, expect, it } from "vitest";
import { CatalogInputError, GROUPS, buildConnection, catalog, findService, validateCatalog } from "../packages/catalog/src/index.js";

describe("the catalog data", () => {
  it("is consistent: every placeholder has a field, links and addresses are https, patterns compile", () => {
    expect(validateCatalog(catalog)).toEqual([]);
  });

  it("covers the MVP's tools, Twilio and the official servers Ringkeeper has (Meta Ads waits for an approved app of our own), with no Google services", () => {
    expect(catalog.services.map((s) => s.id).sort()).toEqual(
      [
        "n8n", "supabase", "airtable", "notion", "stripe",
        "neon", "netlify", "github", "apollo", "leadfeeder", "upwork", "retell",
        "make", "zapier", "gohighlevel", "pipedrive", "monday", "close", "klaviyo", "resend",
        "wordpress-com", "wordpress", "webflow", "wix", "paypal", "trello", "atlassian", "linear", "canva",
        "calendly", "calcom", "tavily", "apify", "elevenlabs", "twilio",
        "sentry", "cloudflare", "posthog", "attio", "freshbooks", "zoho-books", "odoo", "sanity", "contentful", "strapi", "payload",
        "mollie", "paddle", "gocardless", "pipeboard",
      ].sort(),
    );
    expect(JSON.stringify(catalog)).not.toMatch(/google/i);
  });

  it("puts every tool in a known group, and marks the ones not yet tried with a real sign-in as Beta", () => {
    for (const s of catalog.services) expect(GROUPS, s.id).toContain(s.group);
    const proven = catalog.services.filter((s) => !s.beta).map((s) => s.id).sort();
    expect(proven).toEqual(["airtable", "calcom", "elevenlabs", "github", "n8n", "neon", "netlify", "notion", "stripe", "supabase", "twilio", "upwork"]);
  });

  it("uses only https vendor servers that sign in by themselves, or keys, or the client's own address", () => {
    for (const s of catalog.services) {
      for (const o of s.options) {
        if (o.kind === "local") {
          // A program on this computer: pinned to one version.
          expect(o.args.join(" "), `${s.id}/${o.id}`).toMatch(/==\d|@\d/);
          continue;
        }
        // Sign-in: no key to paste. It may ask for the client's own address (n8n), never for a secret.
        if (o.auth === "oauth") expect(o.fields.filter((f) => f.secret || (f.required && !o.url.includes(`{{${f.id}}}`))), `${s.id}/${o.id}`).toEqual([]);
        else expect(Object.keys(o.headers ?? {}).length > 0 || o.url.includes("{{"), `${s.id}/${o.id}`).toBe(true);
      }
    }
  });

  it("validation catches an unknown group, a long tag and a Basic template without fields", () => {
    const bad = {
      version: 1 as const,
      checked: "x",
      services: [
        {
          id: "x",
          name: "X",
          group: "Nope" as never,
          description: "",
          tags: ["This tag is far too long to fit on a tile"],
          options: [{ id: "o", label: "o", kind: "remote" as const, url: "https://x", headers: { Authorization: "Basic {{basic:U:P}}" }, fields: [] }],
        },
      ],
    };
    expect(validateCatalog(bad)).toEqual(["x: unknown group Nope", 'x: tag "This tag is far too long to fit on a tile" must be short', "x/o: {{U}} has no field", "x/o: {{P}} has no field"]);
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

  it("n8n and Stripe: sign-in is offered first, so no key has to be made", () => {
    expect(findService("n8n")!.options.map((o) => [o.id, !!o.recommended])).toEqual([["signin", true], ["token", false]]);
    expect(buildConnection("n8n", "signin", { N8N_URL: "acme.app.n8n.cloud" })).toEqual({
      kind: "remote",
      name: "n8n",
      url: "https://acme.app.n8n.cloud/mcp-server/http",
      fields: [],
      auth: "oauth",
    });
    expect(findService("stripe")!.options.map((o) => [o.id, !!o.recommended])).toEqual([["signin", true], ["agent-key", false]]);
    expect(buildConnection("stripe", "signin", {})).toEqual({ kind: "remote", name: "Stripe", url: "https://mcp.stripe.com/", fields: [], auth: "oauth" });
  });

  it("servers from Ringkeeper: the client's own address checked, keys kept secret in their own format", () => {
    expect(buildConnection("odoo", "signin", { ODOO_URL: "https://acme.odoo.com/mcp" })).toEqual({ kind: "remote", name: "Odoo", url: "https://acme.odoo.com/mcp", fields: [], auth: "oauth" });
    expect(() => buildConnection("odoo", "signin", { ODOO_URL: "http://acme.odoo.com/mcp" })).toThrow();
    expect(() => buildConnection("odoo", "signin", { ODOO_URL: "https://acme.odoo.com" })).toThrow();
    expect(buildConnection("strapi", "token", { STRAPI_URL: "https://cms.example.com/mcp", STRAPI_TOKEN: "st_1" })).toEqual({
      kind: "remote",
      name: "Strapi",
      url: "https://cms.example.com/mcp",
      fields: [{ name: "Authorization", value: "Bearer st_1", secret: true }],
    });
    expect(buildConnection("payload", "key", { PAYLOAD_URL: "https://cms.example.com/api/mcp", PAYLOAD_KEY: "k1" }).fields).toEqual([{ name: "Authorization", value: "users API-Key k1", secret: true }]);
    expect(buildConnection("sentry", "token", { SENTRY_TOKEN: "sntryu_1" }).fields).toEqual([{ name: "Authorization", value: "Sentry-Bearer sntryu_1", secret: true }]);
    expect(buildConnection("notion", "token", { NOTION_TOKEN: "ntn_1" }).fields).toEqual([{ name: "Authorization", value: "Bearer ntn_1", secret: true }]);
    expect(buildConnection("contentful", "signin-eu", {})).toMatchObject({ url: "https://mcp.eu.contentful.com/mcp", auth: "oauth" });
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

  it("WordPress (own site): sends the username and application password as one secret Basic credential", () => {
    const c = buildConnection("wordpress", "app-password", {
      WP_MCP_URL: "https://acme.example/wp-json/mcp/mcp-adapter-default-server",
      WP_USER: "pat",
      WP_APP_PASSWORD: "abcd efgh ijkl mnop",
    });
    expect(c).toEqual({
      kind: "remote",
      name: "WordPress (own site)",
      url: "https://acme.example/wp-json/mcp/mcp-adapter-default-server",
      fields: [{ name: "Authorization", value: `Basic ${Buffer.from("pat:abcd efgh ijkl mnop").toString("base64")}`, secret: true }],
    });
    expect(() => buildConnection("wordpress", "app-password", { WP_MCP_URL: "http://acme.example/mcp", WP_USER: "pat", WP_APP_PASSWORD: "x" })).toThrow(/https/);
  });

  it("GitHub: a token, with a read-only choice that uses GitHub's read-only address", () => {
    expect(buildConnection("github", "token-readonly", { GITHUB_TOKEN: "github_pat_ABC123" })).toMatchObject({
      url: "https://api.githubcopilot.com/mcp/readonly",
      fields: [{ name: "Authorization", value: "Bearer github_pat_ABC123", secret: true }],
    });
    expect(() => buildConnection("github", "token", { GITHUB_TOKEN: "hello" })).toThrow(/github_pat_/);
  });

  it("ElevenLabs: runs ElevenLabs' own program, pinned, with the key kept secret", () => {
    expect(buildConnection("elevenlabs", "key", { ELEVENLABS_API_KEY: "sk_123" })).toEqual({
      kind: "local",
      name: "ElevenLabs",
      command: "uvx",
      args: ["elevenlabs-mcp==0.12.2"],
      fields: [{ name: "ELEVENLABS_API_KEY", value: "sk_123", secret: true }],
    });
  });

  it("Twilio: runs Twilio's own program, pinned; only the IDs are in its arguments, the secret is kept secret", () => {
    const sid = `AC${"a".repeat(32)}`;
    const key = `SK${"b".repeat(32)}`;
    const conn = buildConnection("twilio", "key", { TWILIO_ACCOUNT_SID: sid, TWILIO_API_KEY: key, TWILIO_API_SECRET: "the-secret-value" });
    expect(conn).toEqual({
      kind: "local",
      name: "Twilio",
      command: "npx",
      args: ["-y", "@twilio-alpha/mcp@0.7.0", "-a", sid, "-k", key, "-s", "${TWILIO_API_SECRET}"],
      fields: [{ name: "TWILIO_API_SECRET", value: "the-secret-value", secret: true }],
    });
    expect(JSON.stringify(conn.kind === "local" && conn.args)).not.toContain("the-secret-value");
    // The program refuses anything else, so the form does too.
    expect(() => buildConnection("twilio", "key", { TWILIO_ACCOUNT_SID: key, TWILIO_API_KEY: key, TWILIO_API_SECRET: "x" })).toThrow();
    expect(() => buildConnection("twilio", "key", { TWILIO_ACCOUNT_SID: sid, TWILIO_API_KEY: sid, TWILIO_API_SECRET: "x" })).toThrow();
  });

  it("never lets a secret into a program's plain arguments", () => {
    const bad = {
      services: [
        {
          id: "x",
          name: "X",
          group: "Other",
          description: "",
          options: [
            {
              id: "o",
              label: "o",
              kind: "local",
              command: "npx",
              args: ["-y", "x@1.0.0", "{{S}}", "${NOT_A_SETTING}"],
              env: { S: "{{S}}" },
              fields: [{ id: "S", label: "S", secret: true, required: true }],
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof validateCatalog>[0];
    expect(validateCatalog(bad)).toEqual(["x/o: secret {{S}} in the command or arguments", "x/o: ${NOT_A_SETTING} isn't one of its settings"]);
  });
});
