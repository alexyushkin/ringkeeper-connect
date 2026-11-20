// ringkeeper_help: AI apps can answer questions about Ringkeeper Connect from a
// guide, the catalog's advice and what's set up here, never seeing a key.
import net from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Gateway } from "../packages/gateway/src/gateway.js";
import { spikeDefaultConfig } from "../packages/gateway/src/spike-config.js";
import { mcpUrl, newToken } from "../packages/gateway/src/runtime.js";
import { serverInstructions } from "../packages/gateway/src/meta-tools.js";
import { GUIDE, MOST_SERVICES, helpAnswer, servicesNamed, type HelpInput } from "../apps/desktop/src/main/help.js";
import { catalog } from "../packages/catalog/src/index.js";
import type { ClientView, HostView } from "../apps/desktop/src/shared/api.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const PLANTED = "tok_must_never_show_123";

const clients: ClientView[] = [
  {
    id: "acme",
    name: "Acme",
    active: true,
    connections: [
      {
        kind: "remote",
        id: "n8n",
        name: "n8n",
        url: "https://acme.app.n8n.cloud/mcp-server/http",
        fields: [{ name: "Authorization", secret: true, isSet: true }, { name: "X-Note", secret: false, value: PLANTED, isSet: true }],
        missingKeys: [],
      },
      { kind: "remote", id: "airtable", name: "Airtable", url: "https://mcp.airtable.com/mcp", auth: "oauth", signedIn: false, fields: [], missingKeys: [] },
      { kind: "local", id: "stripe", name: "Stripe", command: "npx", args: ["-y", "@stripe/mcp"], fields: [{ name: "STRIPE_SECRET_KEY", secret: true, isSet: false }], missingKeys: ["STRIPE_SECRET_KEY"] },
    ],
  },
  { id: "globex", name: "Globex", active: false, connections: [] },
];

const hosts = [
  { id: "claude-desktop", label: "Claude Desktop", status: "connected" },
  { id: "cursor", label: "Cursor", status: "added" },
  { id: "kiro", label: "Kiro", status: "not_installed" },
] as unknown as HostView[];

function input(question: string, extra: Partial<HelpInput> = {}): HelpInput {
  return {
    question,
    host: "Claude Desktop",
    clients,
    statuses: [{ clientId: "acme", connectionId: "n8n", status: "error", problem: "Couldn't reach n8n for Acme. Check the key in Acme > n8n.", tools: 0 }],
    hosts,
    version: "0.2.0",
    update: { status: "up-to-date", checkedAt: "2026-11-20T09:00:00Z" },
    packaged: true,
    settings: { requireClientArg: true, startAtLogin: true },
    ...extra,
  };
}

describe("the help answer", () => {
  it("says what's set up now: clients, each tool's state and fix, the AI apps", () => {
    const a = helpAnswer(input("Why isn't n8n working?"));
    expect(a).toContain("Client Acme (active): n8n: not working — Couldn't reach n8n for Acme. Check the key in Acme > n8n.");
    expect(a).toContain("Airtable: needs sign-in");
    expect(a).toContain("Stripe: needs a key");
    expect(a).toContain("Client Globex: no tools yet.");
    expect(a).toContain("Claude Desktop: connected and working");
    expect(a).toMatch(/Cursor: set up; restart it/);
    expect(a).not.toContain("Kiro");
    expect(a).toContain("Ringkeeper Connect 0.2.0. Updates: Up to date.");
    expect(a).toContain(GUIDE);
  });

  it("never includes a key or a field's value, and tells the AI not to ask for keys in the chat", () => {
    const a = helpAnswer(input("What's the n8n key for Acme?"));
    expect(a).not.toContain(PLANTED);
    expect(a).not.toMatch(/Authorization|STRIPE_SECRET_KEY/);
    expect(a).toMatch(/never ask them to paste a key into the chat/);
  });

  it("gives the catalog's advice for the services the question names, and for tools that need attention", () => {
    const a = helpAnswer(input("How do I add Basecamp for Globex?"));
    expect(a).toContain("### Basecamp (Beta");
    expect(a).toContain(catalog.services.find((s) => s.id === "basecamp")!.notes![0]!);
    expect(a).toContain('Option "Sign in with Basecamp" (recommended)');
    // Acme's n8n, Airtable and Stripe need attention, so their advice comes too, with where to find a key.
    expect(a).toContain("### Stripe");
    expect(a).toMatch(/### n8n[\s\S]*https:\/\//);
  });

  it("names services by name or id, and keeps a vague answer short", () => {
    expect(servicesNamed("Can I connect Meta Ads and google ads?", catalog.services).map((s) => s.id)).toContain("meta_ads");
    expect(servicesNamed("set up zoho books please", catalog.services).map((s) => s.id)).toEqual(["zoho-books"]);
    expect(servicesNamed("How do I switch clients?", catalog.services)).toEqual([]);
    const all = catalog.services.map((s) => s.name).join(" ");
    expect(helpAnswer(input(all)).match(/^### /gm)!.length).toBeLessThanOrEqual(MOST_SERVICES);
  });

  it("lists what's in Add a tool when the question names no service", () => {
    const calm = input("Which tools can I add?", { clients: [{ id: "x", name: "X", active: true, connections: [] }], statuses: [] });
    const a = helpAnswer(calm);
    expect(a).toMatch(/## Services in Add a tool\n- /);
    expect(a).toContain("Basecamp (Beta)");
  });

  it("works before anything is set up", () => {
    const a = helpAnswer(input("How do I start?", { clients: [], statuses: [], hosts: [] }));
    expect(a).toContain("No clients yet.");
    expect(a).toContain("No AI apps found on this computer.");
  });
});

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

describe("ringkeeper_help in the AI apps", () => {
  it("is offered read-only in both modes, named in the instructions, and answered by the app", async () => {
    const asked: Array<{ question: string; host: string }> = [];
    const token = newToken();
    const gateway = new Gateway({
      config: spikeDefaultConfig(join(resolve("dist"), "fixture-server.mjs")),
      activeClientId: "acme",
      token,
      port: await freePort(),
      help: (q) => {
        asked.push(q);
        return "Here's how.";
      },
    });
    await gateway.start();
    cleanups.push(() => gateway.stop());

    for (const host of ["claude-code", "claude-ai"]) {
      const client = new Client({ name: host, version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(gateway.port)), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      cleanups.push(() => client.close());
      const tool = (await client.listTools()).tools.find((t) => t.name === "ringkeeper_help");
      expect(tool?.annotations?.readOnlyHint, host).toBe(true);
      expect(client.getInstructions()).toMatch(/call ringkeeper_help/);
      const res = (await client.callTool({ name: "ringkeeper_help", arguments: { question: "How do I add a key?" } })) as CallToolResult;
      expect(res.isError).toBeFalsy();
      expect(res.content).toEqual([{ type: "text", text: "Here's how." }]);
    }
    expect(asked).toEqual([
      { question: "How do I add a key?", host: "Claude Code" },
      { question: "How do I add a key?", host: "Claude Desktop" },
    ]);
    expect(serverInstructions("fixed", [])).toMatch(/ringkeeper_help/);
  });
});
