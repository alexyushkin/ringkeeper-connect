// Choosing which of a tool's actions the AI apps get, turning a tool off, and
// tools every client gets ("For every client").
import fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Gateway } from "../packages/gateway/src/gateway.js";
import { EVERY_CLIENT_ID, type ClientConfig, type ConnectionConfig, type GatewayConfig } from "../packages/gateway/src/config.js";
import { isActionChoice, offersAction, type Activity, type ClientGuard } from "../packages/gateway/src/guard.js";
import { mcpUrl, newToken } from "../packages/gateway/src/runtime.js";
import { ClientStore, StoreError, oauthKey, type ConnectionInput } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";
import { actionsNote, sameToolIn } from "../apps/desktop/src/renderer/tool-actions-text.js";

const fixture = join(resolve("dist"), "fixture-server.mjs");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
  const d = fs.mkdtempSync(join(tmpdir(), "rk-actions-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

const crm = (account: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig =>
  ({ id: "crm", name: "CRM", command: process.execPath, args: [fixture, "--service", "crm", "--account", account], ...extra }) as ConnectionConfig;
const helper = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig =>
  ({ id: "helper", name: "Helper", command: process.execPath, args: [fixture, "--service", "crm", "--account", "Shared"], ...extra }) as ConnectionConfig;
const client = (id: string, name: string, conn: ConnectionConfig, guard?: ClientGuard): ClientConfig => ({ id, name, connections: [conn], ...(guard ? { guard } : {}) });

async function start(clients: ClientConfig[], everyClient?: ConnectionConfig[]) {
  const config: GatewayConfig = { clients: structuredClone(clients), ...(everyClient ? { everyClient: structuredClone(everyClient) } : {}), options: { requireClientArg: false } };
  const token = newToken();
  const activity: Activity[] = [];
  const gateway = new Gateway({ config, activeClientId: clients[0]!.id, token, port: await freePort(), onActivity: (a) => activity.push(a), upstreamEnv: {} });
  await gateway.start();
  cleanups.push(() => gateway.stop());
  const c = new Client({ name: "cursor-vscode", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(gateway.port)), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  cleanups.push(() => c.close());
  const call = async (tool: string, args: Record<string, unknown> = {}) => (await c.callTool({ name: tool, arguments: args })) as CallToolResult;
  const names = async () => (await c.listTools()).tools.map((t) => t.name).filter((n) => !n.startsWith("ringkeeper_"));
  return { gateway, c, call, names, activity, config };
}

const text = (r: CallToolResult) => (r.content ?? []).map((x) => (x.type === "text" ? x.text : "")).join("\n");

describe("which actions a tool offers", () => {
  it("offers everything by default, only reading actions for \"read\", and only the named ones for a list", () => {
    const find = { name: "find_contacts" };
    const update = { name: "update_contact" };
    expect(offersAction(undefined, update)).toBe(true);
    expect(offersAction("read", find)).toBe(true);
    expect(offersAction("read", update)).toBe(false);
    expect(offersAction(["update_contact"], update)).toBe(true);
    expect(offersAction(["update_contact"], find)).toBe(false);
  });

  it("accepts only a real choice", () => {
    expect(isActionChoice("read")).toBe(true);
    expect(isActionChoice(["a"])).toBe(true);
    expect(isActionChoice([])).toBe(false);
    expect(isActionChoice("all")).toBe(false);
    expect(isActionChoice([1])).toBe(false);
  });
});

describe("the AI apps get only the chosen actions", () => {
  it("lists only the reading actions and refuses the rest, without running them", async () => {
    const { call, names, gateway } = await start([client("acme", "Acme", crm("Acme", { actions: "read" }))]);
    expect(await names()).toEqual(["crm__find_contacts"]);
    const r = await call("crm__update_contact", { id: "c1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/isn't one of the actions chosen for CRM/);
    expect(text(r)).not.toMatch(/updated/);
    expect(gateway.connectionStatuses()[0]).toMatchObject({ tools: 3, offered: 1 });
  });

  it("offers just the chosen ones, and a new choice applies without restarting the tool", async () => {
    const { call, names, gateway, config } = await start([client("acme", "Acme", crm("Acme", { actions: ["update_contact"] }))]);
    expect(await names()).toEqual(["crm__update_contact"]);
    expect(text(await call("crm__update_contact", { id: "c1" }))).toMatch(/updated c1 for Acme/);
    expect((await call("crm__find_contacts")).isError).toBe(true);

    const next = structuredClone(config);
    next.clients[0]!.connections[0]!.actions = undefined;
    gateway.applyConfig(next);
    expect(await names()).toEqual(["crm__find_contacts", "crm__update_contact", "crm__delete_contact"]);
  });

  it("lists every action with what kind it is, for choosing", async () => {
    const { gateway } = await start([client("acme", "Acme", crm("Acme"))]);
    const actions = await gateway.actionsOf("acme", "crm");
    expect(actions.map((a) => [a.name, a.kind])).toEqual([
      ["find_contacts", "read"],
      ["update_contact", "change"],
      ["delete_contact", "delete"],
    ]);
  });
});

describe("a tool turned off", () => {
  it("isn't started or listed, and says so when the AI asks for it", async () => {
    const { call, names, gateway } = await start([client("acme", "Acme", crm("Acme", { off: true }))]);
    expect(await names()).toEqual([]);
    expect(gateway.connectionStatuses()).toEqual([]);
    const r = await call("crm__find_contacts");
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/CRM is turned off in Ringkeeper Connect/);
    await expect(gateway.actionsOf("acme", "crm")).rejects.toThrow(/turned off\. Turn it on first/);
    expect(text(await call("ringkeeper_list_clients"))).toMatch(/CRM: turned off/);
  });
});

describe("tools for every client", () => {
  it("come with whichever client is active, labelled as for every client", async () => {
    const { call, names, gateway, activity } = await start([client("acme", "Acme", crm("Acme")), client("globex", "Globex", crm("Globex"))], [helper()]);
    expect(await names()).toContain("helper__find_contacts");
    const r = await call("helper__find_contacts");
    expect(text(r)).toMatch(/\[Client: Acme · Helper, for every client\]/);
    expect(text(r)).toMatch(/Shared contact/);
    expect(activity.at(-1)).toMatchObject({ clientId: "acme", connectionName: "Helper (for every client)", outcome: "ran" });

    gateway.setActiveClient("globex");
    expect(await names()).toContain("helper__find_contacts");
    expect(text(await call("helper__find_contacts"))).toMatch(/\[Client: Globex · Helper, for every client\]/);
    expect(activity.at(-1)).toMatchObject({ clientId: "globex" });

    const listed = await (async () => (await (gateway as unknown as { listExposedTools: () => Promise<Array<{ name: string; description?: string }>> }).listExposedTools()))();
    expect(listed.find((t) => t.name === "helper__find_contacts")?.description).toMatch(/^\[Helper, for every client \(now Globex\), via Ringkeeper Connect\]/);
    expect(text(await call("ringkeeper_list_clients"))).toMatch(/For every client \(whichever is active\): Helper/);
  });

  it("follow the active client's rules: a look-only client can't change anything with them", async () => {
    const { call } = await start([client("acme", "Acme", crm("Acme"), "look_only")], [helper()]);
    const r = await call("helper__update_contact", { id: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Acme is set to "Look only"/);
    expect(text(await call("helper__find_contacts"))).toMatch(/Shared contact/);
  });

  it("can have their actions chosen and be turned off too", async () => {
    const { names, gateway } = await start([client("acme", "Acme", crm("Acme"))], [helper({ actions: "read" })]);
    expect((await names()).filter((n) => n.startsWith("helper__"))).toEqual(["helper__find_contacts"]);
    expect((await gateway.actionsOf(EVERY_CLIENT_ID, "helper")).length).toBe(3);

    const off = await start([client("acme", "Acme", crm("Acme"))], [helper({ off: true })]);
    expect((await off.names()).filter((n) => n.startsWith("helper__"))).toEqual([]);
  });
});

// ---------- the store ----------

function fakeCipher(): Cipher {
  return {
    isAvailable: () => true,
    encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
    decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
  };
}

function setup() {
  const dir = tempDir();
  const cipher = fakeCipher();
  const secrets = new SecretStore(join(dir, "secrets.json"), cipher);
  const store = new ClientStore(join(dir, "clients.json"), secrets);
  const reopen = () => new ClientStore(join(dir, "clients.json"), new SecretStore(join(dir, "secrets.json"), cipher));
  const files = () => fs.readdirSync(dir).map((f) => fs.readFileSync(join(dir, f), "utf8")).join("\n");
  return { dir, store, secrets, reopen, files };
}

const n8nInput = (key = "n8n-key-acme-123456"): ConnectionInput => ({
  kind: "local",
  name: "n8n",
  command: "npx",
  args: ["-y", "n8n-mcp"],
  fields: [
    { name: "N8N_API_KEY", value: key, secret: true },
    { name: "N8N_API_URL", value: "https://acme.app.n8n.cloud", secret: false },
  ],
});
const browserInput: ConnectionInput = { kind: "local", name: "Browser", command: "npx", args: ["@playwright/mcp"], fields: [] };

describe("saving the choice of actions and turning off", () => {
  it("keeps the choice through an edit and after reopening, and hands it to the AI side", () => {
    const { store, reopen } = setup();
    const acme = store.addClient("Acme");
    const conn = store.addConnection(acme.id, n8nInput());
    expect(store.setConnectionActions(acme.id, conn.id, "read").actions).toBe("read");
    store.updateConnection(acme.id, conn.id, { ...n8nInput(), name: "n8n main", fields: [{ name: "N8N_API_KEY", secret: true }, { name: "N8N_API_URL", value: "https://acme.app.n8n.cloud", secret: false }] });
    expect(reopen().list()[0]!.connections[0]).toMatchObject({ name: "n8n main", actions: "read" });
    expect(store.toGatewayConfig().clients[0]!.connections[0]!.actions).toBe("read");

    expect(store.setConnectionActions(acme.id, conn.id, ["list_workflows", "list_workflows", " get_workflow "]).actions).toEqual(["list_workflows", "get_workflow"]);
    expect(store.setConnectionActions(acme.id, conn.id, "all").actions).toBeUndefined();
    expect(() => store.setConnectionActions(acme.id, conn.id, [])).toThrow(/Choose at least one action, or turn n8n main off/);
  });

  it("turns a tool off and on again without losing its key", () => {
    const { store, reopen } = setup();
    const acme = store.addClient("Acme");
    const conn = store.addConnection(acme.id, n8nInput());
    expect(store.setConnectionOff(acme.id, conn.id, true).off).toBe(true);
    const gw = reopen().toGatewayConfig().clients[0]!.connections[0]!;
    expect(gw.off).toBe(true);
    expect(gw.kind === "local" && gw.env?.N8N_API_KEY).toBe("n8n-key-acme-123456");
    expect(store.setConnectionOff(acme.id, conn.id, false).off).toBeUndefined();
  });

  it("copies the choice along with a tool, but not the key", () => {
    const { store } = setup();
    const acme = store.addClient("Acme");
    const globex = store.addClient("Globex");
    const conn = store.addConnection(acme.id, n8nInput());
    store.setConnectionActions(acme.id, conn.id, ["list_workflows"]);
    const copy = store.cloneConnection(acme.id, conn.id, globex.id, {});
    expect(copy).toMatchObject({ actions: ["list_workflows"], missingKeys: ["N8N_API_KEY"] });
  });
});

describe("saving tools for every client", () => {
  it("keeps them apart from the clients, with their keys encrypted", () => {
    const { store, reopen, files } = setup();
    store.addClient("Acme");
    store.addConnection(EVERY_CLIENT_ID, { kind: "remote", name: "Search", url: "https://search.example.com/mcp", fields: [{ name: "Authorization", value: "Bearer search-secret-999", secret: true }] });
    expect(store.list().map((c) => c.name)).toEqual(["Acme"]);
    expect(reopen().everyClient().connections.map((c) => c.name)).toEqual(["Search"]);
    const gw = store.toGatewayConfig();
    expect(gw.everyClient?.map((c) => c.id)).toEqual(["search"]);
    expect(gw.everyClient?.[0]?.kind === "remote" && gw.everyClient[0].headers?.Authorization).toBe("Bearer search-secret-999");
    expect(files()).not.toContain("search-secret-999");
    expect(store.view(EVERY_CLIENT_ID)?.connections).toHaveLength(1);
  });

  it("never gives a tool for every client the same id as one of a client's", () => {
    const { store } = setup();
    const acme = store.addClient("Acme");
    store.addConnection(acme.id, browserInput);
    expect(store.addConnection(EVERY_CLIENT_ID, browserInput).id).toBe("browser_2");
    store.addConnection(EVERY_CLIENT_ID, { ...browserInput, name: "Search" });
    const globex = store.addClient("Globex");
    expect(store.addConnection(globex.id, { ...browserInput, name: "Search" }).id).toBe("search_2");
  });

  it("can't be made active, renamed, guarded or deleted like a client", () => {
    const { store } = setup();
    store.addClient("Acme");
    expect(() => store.setActiveClient(EVERY_CLIENT_ID)).toThrow(StoreError);
    expect(() => store.renameClient(EVERY_CLIENT_ID, "X")).toThrow(StoreError);
    expect(() => store.setClientGuard(EVERY_CLIENT_ID, "free")).toThrow(StoreError);
    expect(() => store.removeClient(EVERY_CLIENT_ID)).toThrow(StoreError);
  });

  it("reads a clients file saved before there were tools for every client", () => {
    const { dir, reopen } = setup();
    fs.writeFileSync(join(dir, "clients.json"), JSON.stringify({ version: 1, activeClientId: "acme", clients: [{ id: "acme", name: "Acme", connections: [] }], settings: {} }));
    const store = reopen();
    expect(store.everyClient().connections).toEqual([]);
    expect(store.toGatewayConfig().everyClient).toBeUndefined();
  });
});

describe("moving a tool to every client and back", () => {
  it("takes the key and the sign-in along, and leaves nothing behind in the client", () => {
    const { store, secrets, files } = setup();
    const acme = store.addClient("Acme");
    const conn = store.addConnection(acme.id, { ...n8nInput("move-me-key-777"), name: "Browser" });
    secrets.set(oauthKey(acme.id, conn.id), JSON.stringify({ tokens: { access_token: "signed-in-token-555" } }));
    store.setConnectionActions(acme.id, conn.id, "read");

    const moved = store.moveConnection(acme.id, conn.id, EVERY_CLIENT_ID);
    expect(store.list()[0]!.connections).toEqual([]);
    expect(moved).toMatchObject({ name: "Browser", actions: "read", missingKeys: [] });
    const gw = store.toGatewayConfig().everyClient![0]!;
    expect(gw.kind === "local" && gw.env?.N8N_API_KEY).toBe("move-me-key-777");
    expect(secrets.get(oauthKey(EVERY_CLIENT_ID, moved.id))).toContain("signed-in-token-555");
    expect(secrets.get(oauthKey(acme.id, conn.id))).toBeUndefined();
    expect(secrets.get(`${acme.id}/${conn.id}/N8N_API_KEY`)).toBeUndefined();
    expect(files()).not.toContain("move-me-key-777");

    const back = store.moveConnection(EVERY_CLIENT_ID, moved.id, acme.id);
    expect(store.everyClient().connections).toEqual([]);
    const again = store.toGatewayConfig().clients[0]!.connections[0]!;
    expect(again.id).toBe(back.id);
    expect(again.kind === "local" && again.env?.N8N_API_KEY).toBe("move-me-key-777");
  });

  it("gets a new id when another client has the same one, and refuses a name that's taken", () => {
    const { store } = setup();
    const acme = store.addClient("Acme");
    const globex = store.addClient("Globex");
    const a = store.addConnection(acme.id, browserInput);
    store.addConnection(globex.id, browserInput);
    // Globex still has its own "browser", so the moved one can't be "browser" too.
    expect(store.moveConnection(acme.id, a.id, EVERY_CLIENT_ID).id).toBe("browser_2");
    const b = store.addConnection(acme.id, { ...browserInput, name: "Other" });
    store.updateConnection(acme.id, b.id, { ...browserInput, name: "Browser" });
    expect(() => store.moveConnection(acme.id, b.id, EVERY_CLIENT_ID)).toThrow(/already a tool called "Browser" for every client/);
  });
});

describe("words and checks in the window", () => {
  it("says how many actions the AI gets", () => {
    expect(actionsNote({})).toBeNull();
    expect(actionsNote({ actions: "read", off: true })).toBeNull();
    expect(actionsNote({ actions: "read" }, { tools: 214, offered: 87 })).toBe("The AI gets only the actions that read (87 of 214).");
    expect(actionsNote({ actions: ["a"] })).toBe("The AI gets 1 chosen action.");
    expect(actionsNote({ actions: ["a", "b"] }, { tools: 10, offered: 2 })).toBe("The AI gets 2 chosen actions of 10.");
  });

  it("finds the same tool in other clients by address or program", () => {
    const local = (id: string, args: string[]) => ({ kind: "local" as const, id, name: id, command: "npx", args, fields: [], missingKeys: [] });
    const remote = (id: string, url: string) => ({ kind: "remote" as const, id, name: id, url, fields: [], missingKeys: [] });
    const clients = [
      { id: "acme", name: "Acme", active: true, guard: "ask_delete" as const, pinned: false, archived: false, connections: [local("pw", ["@playwright/mcp"])] },
      { id: "globex", name: "Globex", active: false, guard: "ask_delete" as const, pinned: false, archived: false, connections: [local("playwright", ["@playwright/mcp"]), local("other", ["x"]), remote("s", "https://Search.example.com/mcp/")] },
    ];
    expect(sameToolIn(clients, clients[0]!.connections[0]!, "acme").map((x) => `${x.client.id}/${x.conn.id}`)).toEqual(["globex/playwright"]);
    expect(sameToolIn(clients, remote("q", "https://search.example.com/mcp"), "acme").map((x) => x.conn.id)).toEqual(["s"]);
  });
});
