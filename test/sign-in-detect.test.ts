// Sign-in instead of a key wherever the server allows it.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { offersSignIn } from "../packages/gateway/src/oauth.js";
import { ClientStore } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";
import { SignInFinder } from "../apps/desktop/src/main/sign-in-finder.js";
import { connectorByAddress } from "../apps/desktop/src/main/apps.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fake web: an MCP server at https://mcp.example.com/mcp and its sign-in service. */
function fakeWeb(opts: { status: number; registration?: boolean; prm?: boolean }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://mcp.example.com/mcp") {
      return json({}, opts.status, opts.status === 401 ? { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"' } : {});
    }
    if (url.includes("/.well-known/oauth-protected-resource")) {
      return opts.prm === false ? json({}, 404) : json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"] });
    }
    if (url.startsWith("https://auth.example.com/.well-known/")) {
      return json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
        ...(opts.registration === false ? {} : { registration_endpoint: "https://auth.example.com/register" }),
      });
    }
    return json({}, 404);
  }) as typeof fetch;
}

describe("does a web address let Ringkeeper sign in by itself?", () => {
  it("yes: it refuses a call without sign-in, names its sign-in service, and that lets new apps register", async () => {
    expect(await offersSignIn("https://mcp.example.com/mcp", { fetchFn: fakeWeb({ status: 401 }) })).toBe(true);
  });

  it("no: it works without any key, or its sign-in needs a registered app, or it names no sign-in service", async () => {
    expect(await offersSignIn("https://mcp.example.com/mcp", { fetchFn: fakeWeb({ status: 200 }) })).toBe(false);
    expect(await offersSignIn("https://mcp.example.com/mcp", { fetchFn: fakeWeb({ status: 401, registration: false }) })).toBe(false);
    expect(await offersSignIn("https://mcp.example.com/mcp", { fetchFn: fakeWeb({ status: 401, prm: false }) })).toBe(false);
  });

  it("no, without asking: not https, not an address, or the server can't be reached", async () => {
    let asked = false;
    const spy = (async () => {
      asked = true;
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await offersSignIn("http://mcp.example.com/mcp", { fetchFn: spy })).toBe(false);
    expect(await offersSignIn("not an address", { fetchFn: spy })).toBe(false);
    expect(asked).toBe(false);
    expect(await offersSignIn("https://mcp.example.com/mcp", { fetchFn: spy })).toBe(false);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function storeWith() {
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-signin-"));
  dirs.push(dir);
  const cipher: Cipher = {
    isAvailable: () => true,
    encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
    decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
  };
  return new ClientStore(join(dir, "clients.json"), new SecretStore(join(dir, "secrets.json"), cipher));
}

describe("keyless web connections get Sign in where their server allows it", () => {
  it("switches only keyless, not-yet-sign-in web connections whose server supports it, asking once per address", async () => {
    const store = storeWith();
    const gi = store.addClient("General Informatics");
    const n8n = store.addConnection(gi.id, { kind: "remote", name: "mass_home_comfort", url: "https://n8n.example.com/mcp-server/http", fields: [] });
    const open = store.addConnection(gi.id, { kind: "remote", name: "open", url: "https://open.example.com/mcp", fields: [] });
    const keyed = store.addConnection(gi.id, {
      kind: "remote",
      name: "keyed",
      url: "https://n8n.example.com/mcp-server/http",
      fields: [{ name: "Authorization", value: "Bearer x", secret: true }],
    });
    const local = store.addConnection(gi.id, { kind: "local", name: "local", command: "npx", args: ["x@1.0.0"], fields: [] });
    const seaside = store.addClient("Seaside");
    const again = store.addConnection(seaside.id, { kind: "remote", name: "n8n", url: "https://n8n.example.com/mcp-server/http", fields: [] });

    const asked: string[] = [];
    const finder = new SignInFinder({
      store,
      probe: async (u) => {
        asked.push(u);
        return u.startsWith("https://n8n.");
      },
    });
    expect(await finder.run()).toBe(2);
    const auth = (clientId: string, id: string) => {
      const c = store.list().find((x) => x.id === clientId)!.connections.find((x) => x.id === id)!;
      return c.kind === "remote" ? c.auth : "local";
    };
    expect(auth(gi.id, n8n.id)).toBe("oauth");
    expect(auth(seaside.id, again.id)).toBe("oauth");
    expect(auth(gi.id, open.id)).toBeUndefined();
    expect(auth(gi.id, keyed.id)).toBeUndefined(); // has a key: left alone
    expect(auth(gi.id, local.id)).toBe("local");
    expect(asked.sort()).toEqual(["https://n8n.example.com/mcp-server/http", "https://open.example.com/mcp"]);

    // Nothing left to switch, and no new questions.
    expect(await finder.run()).toBe(0);
    expect(asked).toHaveLength(2);
  });

  it("an online connector added by address becomes a keyless web connection", () => {
    expect(connectorByAddress({ name: "", url: "n8n.geninfos.com/mcp-server/http" })).toEqual({
      kind: "remote",
      name: "n8n",
      url: "https://n8n.geninfos.com/mcp-server/http",
      fields: [],
    });
    expect(connectorByAddress({ name: " My CRM ", url: "https://mcp.example.com/mcp" }).name).toBe("My CRM");
    expect(() => connectorByAddress({ name: "", url: "http://insecure.example.com/mcp" })).toThrow(/https/);
  });
});
