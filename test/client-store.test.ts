import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientStore, StoreError, looksSecret, slug, type ConnectionInput } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, SecretStorageUnavailableError, type Cipher } from "../packages/gateway/src/store/secrets.js";

/** Reversible stand-in for safeStorage that leaves no plaintext behind. */
function fakeCipher(available = true): Cipher {
  return {
    isAvailable: () => available,
    encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
    decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(cipher = fakeCipher()) {
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-store-"));
  dirs.push(dir);
  const secrets = new SecretStore(join(dir, "secrets.json"), cipher);
  const store = new ClientStore(join(dir, "clients.json"), secrets);
  const reopen = () => new ClientStore(join(dir, "clients.json"), new SecretStore(join(dir, "secrets.json"), cipher));
  const files = () => fs.readdirSync(dir).map((f) => fs.readFileSync(join(dir, f), "utf8")).join("\n");
  return { dir, store, secrets, reopen, files };
}

const n8n = (key = "n8n-key-acme-123456"): ConnectionInput => ({
  kind: "local",
  name: "n8n",
  command: "npx",
  args: ["-y", "n8n-mcp"],
  fields: [
    { name: "N8N_API_URL", value: "https://acme.app.n8n.cloud", secret: false },
    { name: "N8N_API_KEY", value: key, secret: true },
  ],
});

describe("clients", () => {
  it("the first client becomes active; names must be unique", () => {
    const { store } = setup();
    const acme = store.addClient("Acme");
    expect(acme.active).toBe(true);
    store.addClient("Globex");
    expect(store.activeClientId).toBe("acme");
    expect(() => store.addClient("  acme ")).toThrow(/already have a client called "acme"/);
    expect(() => store.addClient("   ")).toThrow(StoreError);
  });

  it("renaming keeps the id, so tool names and saved keys stay stable", () => {
    const { store, reopen } = setup();
    store.addClient("Acme");
    store.addConnection("acme", n8n());
    store.renameClient("acme", "Acme Corp");
    const again = reopen();
    expect(again.list()[0]).toMatchObject({ id: "acme", name: "Acme Corp" });
    expect(again.toGatewayConfig().clients[0]!.connections[0]).toMatchObject({ env: { N8N_API_KEY: "n8n-key-acme-123456" } });
  });

  it("removing a client deletes its keys and moves the active client", () => {
    const { store, secrets } = setup();
    store.addClient("Acme");
    store.addClient("Globex");
    store.addConnection("acme", n8n());
    store.addConnection("globex", n8n("globex-key-999999"));
    store.removeClient("acme");
    expect(store.activeClientId).toBe("globex");
    expect(secrets.keys()).toEqual(["globex/n8n/N8N_API_KEY"]);
  });
});

describe("connections and keys", () => {
  it("never writes a key in plain text, and never shows it back", () => {
    const { store, files } = setup();
    store.addClient("Acme");
    const view = store.addConnection("acme", n8n());
    expect(files()).not.toContain("n8n-key-acme-123456");
    expect(files()).toContain("https://acme.app.n8n.cloud");
    const key = view.fields.find((f) => f.name === "N8N_API_KEY")!;
    expect(key).toEqual({ name: "N8N_API_KEY", secret: true, isSet: true });
    expect(JSON.stringify(store.list())).not.toContain("n8n-key-acme-123456");
  });

  it("gives the gateway the real values, in memory", () => {
    const { store } = setup();
    store.addClient("Acme");
    store.addConnection("acme", n8n());
    const conn = store.toGatewayConfig().clients[0]!.connections[0]!;
    expect(conn).toMatchObject({
      id: "n8n",
      kind: "local",
      command: "npx",
      env: { N8N_API_URL: "https://acme.app.n8n.cloud", N8N_API_KEY: "n8n-key-acme-123456" },
    });
    expect(conn.missingKeys).toBeUndefined();
  });

  it("an update without a new key keeps the saved one; a new value replaces it", () => {
    const { store } = setup();
    store.addClient("Acme");
    store.addConnection("acme", n8n());
    const keep = n8n();
    keep.fields[1] = { name: "N8N_API_KEY", secret: true };
    store.updateConnection("acme", "n8n", keep);
    expect(store.toGatewayConfig().clients[0]!.connections[0]).toMatchObject({ env: { N8N_API_KEY: "n8n-key-acme-123456" } });
    store.updateConnection("acme", "n8n", n8n("rotated-key-7777777"));
    expect(store.toGatewayConfig().clients[0]!.connections[0]).toMatchObject({ env: { N8N_API_KEY: "rotated-key-7777777" } });
  });

  it("removing a setting forgets its key", () => {
    const { store, secrets } = setup();
    store.addClient("Acme");
    store.addConnection("acme", n8n());
    const input = n8n();
    input.fields = input.fields.filter((f) => f.name !== "N8N_API_KEY");
    store.updateConnection("acme", "n8n", input);
    expect(secrets.keys()).toEqual([]);
  });

  it("a key with no value is reported as missing", () => {
    const { store } = setup();
    store.addClient("Acme");
    const view = store.addConnection("acme", { ...n8n(), fields: [{ name: "N8N_API_KEY", secret: true }] });
    expect(view.missingKeys).toEqual(["N8N_API_KEY"]);
    expect(store.toGatewayConfig().clients[0]!.connections[0]!.missingKeys).toEqual(["N8N_API_KEY"]);
  });

  it("connection ids are unique per client and safe as tool prefixes", () => {
    const { store } = setup();
    store.addClient("Acme");
    store.addConnection("acme", { ...n8n(), name: "n8n (production)" });
    const second = store.addConnection("acme", { ...n8n(), name: "N8N Production!" });
    expect(store.list()[0]!.connections.map((c) => c.id)).toEqual(["n8n_production", "n8n_production_2"]);
    expect(second.id).toMatch(/^[a-z0-9_]+$/);
  });

  it("refuses web addresses that would send keys unencrypted", () => {
    const { store } = setup();
    store.addClient("Acme");
    expect(() => store.addConnection("acme", { kind: "remote", name: "Notion", url: "http://mcp.example.com", fields: [] })).toThrow(/https/);
    expect(() => store.addConnection("acme", { kind: "remote", name: "Notion", url: "not a url", fields: [] })).toThrow(/doesn't look right/);
    expect(store.addConnection("acme", { kind: "remote", name: "Notion", url: "https://mcp.notion.com/mcp", fields: [] }).kind).toBe("remote");
  });
});

describe("copy a connection to another client", () => {
  it("copies the settings but not the keys; the new client's own key is used", () => {
    const { store } = setup();
    store.addClient("Acme");
    store.addClient("Globex");
    store.addConnection("acme", n8n());
    const copy = store.cloneConnection("acme", "n8n", "globex", { N8N_API_KEY: "globex-key-424242" });
    expect(copy.missingKeys).toEqual([]);
    const globex = store.toGatewayConfig().clients.find((c) => c.id === "globex")!.connections[0]!;
    expect(globex).toMatchObject({ command: "npx", env: { N8N_API_URL: "https://acme.app.n8n.cloud", N8N_API_KEY: "globex-key-424242" } });
  });

  it("without a new key, the copy needs one instead of reusing the original", () => {
    const { store } = setup();
    store.addClient("Acme");
    store.addClient("Globex");
    store.addConnection("acme", n8n());
    const copy = store.cloneConnection("acme", "n8n", "globex", {});
    expect(copy.missingKeys).toEqual(["N8N_API_KEY"]);
    expect(JSON.stringify(store.toGatewayConfig().clients[1])).not.toContain("n8n-key-acme");
  });

  it("names the copy so it doesn't clash", () => {
    const { store } = setup();
    store.addClient("Acme");
    store.addConnection("acme", n8n());
    expect(store.cloneConnection("acme", "n8n", "acme", {}).name).toBe("n8n (copy)");
  });
});

describe("safety", () => {
  it("won't overwrite a clients file it can't read", () => {
    const { dir, secrets } = setup();
    const file = join(dir, "clients.json");
    fs.writeFileSync(file, "{ not json");
    expect(() => new ClientStore(file, secrets)).toThrow(/couldn't read your clients file/);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("refuses to save a key when secure storage is unavailable, in plain words", () => {
    const { store } = setup(fakeCipher(false));
    store.addClient("Acme");
    expect(() => store.addConnection("acme", n8n())).toThrow(SecretStorageUnavailableError);
    expect(() => store.addConnection("acme", n8n())).toThrow(/secure storage isn't available/);
  });

  it("guesses which settings are secrets", () => {
    for (const n of ["N8N_API_KEY", "AIRTABLE_TOKEN", "client_secret", "Authorization", "DB_PASSWORD"]) expect(looksSecret(n)).toBe(true);
    for (const n of ["N8N_API_URL", "BASE_ID", "REGION"]) expect(looksSecret(n)).toBe(false);
  });

  it("makes ids from names", () => {
    expect(slug("Acme & Sons, Ltd.", "client")).toBe("acme_sons_ltd");
    expect(slug("Ünïcödé", "client")).toBe("unicode");
    expect(slug("!!!", "client")).toBe("client");
  });
});
