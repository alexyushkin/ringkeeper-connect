// Dozens of clients (pin, recent, archive, a new client like another, the "Needs attention"
// list) and moving to another computer (a password-locked copy of every client).
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVERY_CLIENT_ID } from "../packages/gateway/src/config.js";
import { ClientStore, StoreError, oauthKey, ownAppSecretKey, type ClientView, type ConnectionInput } from "../packages/gateway/src/store/client-store.js";
import { CopyError, checkNewPassword, isCopyFile, openCopy, sealCopy } from "../packages/gateway/src/store/copy.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";
import { clientGroups, needsAttention } from "../apps/desktop/src/renderer/client-list.js";
import { copyResultText } from "../apps/desktop/src/renderer/copy-text.js";
import { helpAnswer } from "../apps/desktop/src/main/help.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function fakeCipher(): Cipher {
  return {
    isAvailable: () => true,
    encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
    decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
  };
}

function setup() {
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-many-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cipher = fakeCipher();
  const secrets = new SecretStore(join(dir, "secrets.json"), cipher);
  const store = new ClientStore(join(dir, "clients.json"), secrets);
  const reopen = () => new ClientStore(join(dir, "clients.json"), new SecretStore(join(dir, "secrets.json"), cipher));
  const files = () => fs.readdirSync(dir).map((f) => fs.readFileSync(join(dir, f), "utf8")).join("\n");
  return { dir, store, secrets, reopen, files };
}

const n8n = (key = "acme-n8n-key-123", url = "https://acme.app.n8n.cloud/mcp"): ConnectionInput => ({
  kind: "remote",
  name: "n8n",
  url,
  fields: [{ name: "Authorization", secret: true, value: `Bearer ${key}` }],
});
const browser: ConnectionInput = { kind: "local", name: "Browser", command: "npx", args: ["@playwright/mcp"], fields: [] };
const notion: ConnectionInput = { kind: "remote", name: "Notion", url: "https://mcp.notion.com/mcp", auth: "oauth", fields: [] };
/** A low-cost password lock for tests (the app uses a slow one). */
const FAST = { N: 1024, r: 8, p: 1 };

describe("pinning, archiving and recent", () => {
  it("pins and archives a client, and keeps an archived one away from the AI apps", () => {
    const { store, reopen } = setup();
    const acme = store.addClient("Acme");
    const globex = store.addClient("Globex");
    store.addConnection(globex.id, n8n("globex-key"));
    store.setClientPinned(globex.id, true);
    expect(store.view(globex.id)).toMatchObject({ pinned: true, archived: false });

    store.setClientArchived(globex.id, true);
    const v = reopen().view(globex.id)!;
    expect(v).toMatchObject({ archived: true, pinned: false });
    expect(v.connections).toHaveLength(1);
    // Not in the AI apps' view at all; its key is still saved.
    expect(store.toGatewayConfig().clients.map((c) => c.id)).toEqual([acme.id]);
    expect(v.connections[0]!.missingKeys).toEqual([]);

    expect(() => store.setActiveClient(globex.id)).toThrow(/archived/);
    store.setClientArchived(globex.id, false);
    store.setActiveClient(globex.id);
    expect(store.toGatewayConfig().clients.map((c) => c.id)).toEqual([acme.id, globex.id]);
  });

  it("won't archive the active client, so no chat changes client without asking", () => {
    const { store } = setup();
    const acme = store.addClient("Acme");
    expect(store.activeClientId).toBe(acme.id);
    expect(() => store.setClientArchived(acme.id, true)).toThrow(/Switch to another client first/);
    expect(() => store.setClientPinned(EVERY_CLIENT_ID, true)).toThrow(StoreError);
  });

  it("removing the active client makes one that isn't archived active", () => {
    const { store } = setup();
    const a = store.addClient("A");
    const b = store.addClient("B");
    const c = store.addClient("C");
    store.setClientArchived(b.id, true);
    store.removeClient(a.id);
    expect(store.activeClientId).toBe(c.id);
  });

  it("records when a client was last switched to", () => {
    const { store } = setup();
    const a = store.addClient("A");
    const b = store.addClient("B");
    expect(store.view(a.id)!.lastUsedAt).toBeTypeOf("number");
    expect(store.view(b.id)!.lastUsedAt).toBeUndefined();
    store.setActiveClient(b.id);
    expect(store.view(b.id)!.lastUsedAt).toBeGreaterThanOrEqual(store.view(a.id)!.lastUsedAt!);
  });

  it("groups the list: pinned, recent once it's long, A to Z, archived apart; search finds archived too", () => {
    const view = (name: string, extra: Partial<ClientView> = {}): ClientView => ({
      id: name.toLowerCase(),
      name,
      active: false,
      connections: [],
      guard: "ask_delete",
      pinned: false,
      archived: false,
      ...extra,
    });
    const few = [view("Zeta"), view("alpha", { lastUsedAt: 5 }), view("Beta", { pinned: true })];
    expect(clientGroups(few, "")).toMatchObject({ recent: [] });
    expect(clientGroups(few, "").rest.map((c) => c.name)).toEqual(["alpha", "Zeta"]);
    expect(clientGroups(few, "").pinned.map((c) => c.name)).toEqual(["Beta"]);

    const many = [
      ...few,
      view("Client 10", { lastUsedAt: 30 }),
      view("Client 9", { lastUsedAt: 20 }),
      view("Old", { archived: true, lastUsedAt: 99 }),
      view("Delta"),
      view("Echo", { lastUsedAt: 1 }),
    ];
    const g = clientGroups(many, "");
    expect(g.rest.map((c) => c.name)).toEqual(["alpha", "Client 9", "Client 10", "Delta", "Echo", "Zeta"]);
    expect(g.recent.map((c) => c.name)).toEqual(["Client 10", "Client 9", "alpha", "Echo"]);
    expect(g.archived.map((c) => c.name)).toEqual(["Old"]);
    expect(clientGroups(many, "ol").matches.map((c) => c.name)).toEqual(["Old"]);
  });
});

describe("a new client like another", () => {
  it("copies the tools and settings, never the keys or sign-ins, and holds each tool back until it's checked", () => {
    const { store, secrets } = setup();
    const acme = store.addClient("Acme");
    store.setClientGuard(acme.id, "look_only");
    const n = store.addConnection(acme.id, n8n());
    store.addConnection(acme.id, browser);
    const no = store.addConnection(acme.id, notion);
    secrets.set(oauthKey(acme.id, no.id), JSON.stringify({ tokens: { access_token: "acme-token" } }));
    store.setConnectionActions(acme.id, n.id, ["list_workflows"]);

    const globex = store.addClient("Globex", acme.id);
    const v = store.view(globex.id)!;
    expect(v.guard).toBe("look_only");
    expect(v.connections.map((c) => [c.name, c.copiedFrom])).toEqual([
      ["n8n", "Acme"],
      ["Browser", "Acme"],
      ["Notion", "Acme"],
    ]);
    const copied = v.connections[0]!;
    expect(copied.missingKeys).toEqual(["Authorization"]);
    expect(copied.actions).toEqual(["list_workflows"]);
    expect(v.connections[2]!.signedIn).toBe(false);
    expect(secrets.keys().filter((k) => k.startsWith(`${globex.id}/`))).toEqual([]);

    // Not offered while unchecked, even the keyless browser helper.
    const gw = store.toGatewayConfig().clients.find((c) => c.id === globex.id)!;
    expect(gw.connections.every((c) => c.off === true)).toBe(true);
    // The template's own tools are untouched.
    expect(store.view(acme.id)!.connections.every((c) => !c.copiedFrom && c.missingKeys.length === 0)).toBe(true);

    // Saving (what the window does after Edit) checks it.
    store.updateConnection(globex.id, copied.id, n8n("globex-key", "https://globex.app.n8n.cloud/mcp"));
    expect(store.view(globex.id)!.connections[0]!.copiedFrom).toBe("Acme"); // an update alone (also made automatically) doesn't
    store.markChecked(globex.id, copied.id);
    const after = store.toGatewayConfig().clients.find((c) => c.id === globex.id)!.connections[0]!;
    expect(after.off).toBeUndefined();
    expect(store.view(globex.id)!.connections[0]!.copiedFrom).toBeUndefined();
  });

  it("refuses the tools for every client as a template", () => {
    const { store } = setup();
    expect(() => store.addClient("X", EVERY_CLIENT_ID)).toThrow(StoreError);
  });
});

describe("the Needs attention list", () => {
  it("lists every tool that needs something, in clients that aren't archived and in For every client", () => {
    const { store, secrets } = setup();
    const acme = store.addClient("Acme");
    store.addConnection(acme.id, { ...n8n(), fields: [{ name: "Authorization", secret: true }] });
    const ok = store.addConnection(acme.id, notion);
    secrets.set(oauthKey(acme.id, ok.id), "{}");
    const off = store.addConnection(acme.id, { ...notion, name: "Notion 2" });
    store.setConnectionOff(acme.id, off.id, true);
    const globex = store.addClient("Globex", acme.id);
    const old = store.addClient("Old");
    store.addConnection(old.id, notion);
    store.setClientArchived(old.id, true);
    store.addConnection(EVERY_CLIENT_ID, { ...notion, name: "Search" });
    const broken = store.addConnection(acme.id, browser);

    const statuses = [{ clientId: acme.id, connectionId: broken.id, name: "Browser", status: "error" as const, problem: "Couldn't start Browser." }];
    const list = needsAttention(store.list(), store.everyClient(), statuses as never, EVERY_CLIENT_ID);
    expect(list.map((a) => `${a.client.name}/${a.conn.name}/${a.fix}`)).toEqual([
      "Acme/n8n/edit",
      "Acme/Browser/edit",
      "Globex/n8n/check",
      "Globex/Notion/check",
      "every client/Search/signin",
    ]);
    expect(list.find((a) => a.conn.name === "Search")!.problem).toBe("Sign in with your account to use it.");
    expect(list[1]!.problem).toBe("Couldn't start Browser.");
  });
});

describe("a copy for another computer", () => {
  function filled() {
    const s = setup();
    const { store, secrets } = s;
    const acme = store.addClient("Acme");
    store.addConnection(acme.id, n8n());
    const no = store.addConnection(acme.id, notion);
    secrets.set(oauthKey(acme.id, no.id), JSON.stringify({ tokens: { access_token: "acme-notion-token" } }));
    store.setConnectionActions(acme.id, no.id, "read");
    store.setClientGuard(acme.id, "free");
    store.setClientPinned(acme.id, true);
    const globex = store.addClient("Globex");
    store.addConnection(globex.id, { ...n8n("globex-key-456"), fields: [{ name: "Authorization", secret: true }] }); // no key saved
    store.setClientArchived(globex.id, true);
    store.addConnection(EVERY_CLIENT_ID, browser);
    store.updateSettings({ ownApps: [{ id: "google:agency", vendor: "google", name: "Agency Google", clientId: "123.apps.googleusercontent.com" }] });
    secrets.set(ownAppSecretKey("google:agency"), "own-app-secret");
    return s;
  }

  it("locks with the password: the file never holds a key in the clear, and opens again with it", async () => {
    const { store } = filled();
    const text = await sealCopy(store.exportCopy(), "correct horse", FAST);
    expect(isCopyFile(text)).toBe(true);
    for (const secret of ["acme-n8n-key-123", "acme-notion-token", "own-app-secret", "Acme", "n8n"]) expect(text).not.toContain(secret);
    const back = await openCopy(text, "correct horse");
    expect(back.clients.map((c) => c.name)).toEqual(["Acme", "Globex"]);
    await expect(openCopy(text, "wrong horse")).rejects.toThrow(/password doesn't open/);
    // A changed file doesn't open either.
    const file = JSON.parse(text);
    file.data = Buffer.from(Buffer.from(file.data, "base64").map((b: number, i: number) => (i === 3 ? b ^ 1 : b))).toString("base64");
    await expect(openCopy(JSON.stringify(file), "correct horse")).rejects.toThrow(CopyError);
    await expect(openCopy("not a copy", "x")).rejects.toThrow(/isn't a copy/);
    expect(isCopyFile(JSON.stringify({ ...JSON.parse(text), kdf: { ...file.kdf, N: 2 ** 30 } }))).toBe(false);
  });

  it("asks for a real password", async () => {
    expect(() => checkNewPassword("short", "short")).toThrow(/at least 8/);
    expect(() => checkNewPassword("long enough", "long enougj")).toThrow(/aren't the same/);
    expect(() => checkNewPassword("long enough", "long enough")).not.toThrow();
    await expect(sealCopy({} as never, "short", FAST)).rejects.toThrow(CopyError);
  });

  it("brings everything into a new computer: tools, keys, sign-ins, choices, own apps", async () => {
    const old = filled();
    const text = await sealCopy(old.store.exportCopy(), "correct horse", FAST);
    const fresh = setup();
    const copy = await openCopy(text, "correct horse");
    expect(fresh.store.previewCopy(copy)).toEqual({
      clients: [
        { name: "Acme", tools: 2, archived: false, exists: false },
        { name: "Globex", tools: 1, archived: true, exists: false },
      ],
      everyClient: [{ name: "Browser", exists: false }],
      ownApps: [{ name: "Agency Google", exists: false }],
    });
    const result = fresh.store.importCopy(copy, { clients: ["Acme", "Globex"], everyClient: true });
    expect(result).toEqual({ clients: ["Acme", "Globex"], renamed: [], everyClient: ["Browser"], ownApps: ["Agency Google"] });

    const store = fresh.reopen();
    const acme = store.list().find((c) => c.name === "Acme")!;
    expect(acme).toMatchObject({ pinned: true, guard: "free", active: true });
    expect(acme.connections.map((c) => [c.name, c.missingKeys, c.signedIn ?? null, c.actions ?? null])).toEqual([
      ["n8n", [], null, null],
      ["Notion", [], true, "read"],
    ]);
    const gw = store.toGatewayConfig();
    const n = gw.clients.find((c) => c.id === acme.id)!.connections[0]!;
    expect(n.kind === "remote" && n.headers?.Authorization).toBe("Bearer acme-n8n-key-123");
    expect(fresh.secrets.get(oauthKey(acme.id, acme.connections[1]!.id))).toContain("acme-notion-token");
    const globex = store.list().find((c) => c.name === "Globex")!;
    expect(globex).toMatchObject({ archived: true });
    expect(globex.connections[0]!.missingKeys).toEqual(["Authorization"]);
    expect(store.everyClient().connections.map((c) => c.name)).toEqual(["Browser"]);
    expect(store.settings.ownApps).toEqual([{ id: "google:agency", vendor: "google", name: "Agency Google", clientId: "123.apps.googleusercontent.com" }]);
    expect(fresh.secrets.get(ownAppSecretKey("google:agency"))).toBe("own-app-secret");
    // Keys stay out of the plain files on the new computer too.
    expect(fresh.files()).not.toContain("acme-n8n-key-123");
    expect(fresh.files()).not.toContain("own-app-secret");
  });

  it("changes nothing that's already here: a taken name comes in as a second client, and only what's ticked", async () => {
    const old = filled();
    const copy = await openCopy(await sealCopy(old.store.exportCopy(), "correct horse", FAST), "correct horse");
    const here = setup();
    const mine = here.store.addClient("Acme");
    here.store.addConnection(mine.id, n8n("my-own-acme-key"));
    here.store.addConnection(EVERY_CLIENT_ID, browser);
    expect(here.store.previewCopy(copy).clients[0]).toMatchObject({ name: "Acme", exists: true });

    const r = here.store.importCopy(copy, { clients: ["Acme"], everyClient: true });
    expect(r).toEqual({ clients: ["Acme 2"], renamed: [{ from: "Acme", to: "Acme 2" }], everyClient: [], ownApps: ["Agency Google"] });
    const names = here.store.list().map((c) => c.name);
    expect(names).toEqual(["Acme", "Acme 2"]);
    expect(here.store.activeClientId).toBe(mine.id);
    const gw = here.store.toGatewayConfig();
    const keyOf = (id: string) => {
      const c = gw.clients.find((x) => x.id === id)!.connections[0]!;
      return c.kind === "remote" ? c.headers?.Authorization : undefined;
    };
    expect(keyOf(mine.id)).toBe("Bearer my-own-acme-key");
    expect(keyOf(here.store.list()[1]!.id)).toBe("Bearer acme-n8n-key-123");
    expect(here.store.everyClient().connections).toHaveLength(1);
    // Connection ids never clash with the tools for every client, so the AI apps can tell them apart.
    const everyIds = new Set(here.store.everyClient().connections.map((c) => c.id));
    expect(here.store.list().flatMap((c) => c.connections).some((c) => everyIds.has(c.id))).toBe(false);
  });

  it("says what was brought in, in plain words", () => {
    expect(copyResultText({ clients: ["Acme", "Globex", "Acme 2"], renamed: [{ from: "Acme", to: "Acme 2" }], everyClient: ["Browser"], ownApps: [] })).toBe(
      'Brought in Acme, Globex and Acme 2. Acme is called "Acme 2" here, because you already had a Acme. Rename either one any time. Also brought in for every client: Browser. If a tool says it needs a sign-in, sign in once more. Then delete the copy file: it holds your clients\' keys.',
    );
    expect(copyResultText({ clients: [], renamed: [], everyClient: [], ownApps: [] })).toMatch(/Nothing was brought in/);
  });
});

describe("what the AI apps' guide says", () => {
  it("lists archived clients apart and says a copied tool isn't checked yet", () => {
    const { store } = setup();
    const acme = store.addClient("Acme");
    store.addConnection(acme.id, browser);
    store.addClient("Globex", acme.id);
    const old = store.addClient("Old");
    store.setClientArchived(old.id, true);
    const text = helpAnswer({
      question: "why isn't it working",
      host: "Claude",
      clients: store.list(),
      everyClient: store.everyClient(),
      statuses: [],
      hosts: [],
      version: "0.2.6",
      packaged: true,
      settings: { requireClientArg: true, startAtLogin: true },
    });
    expect(text).toContain("- Archived (not offered to AI apps");
    expect(text).not.toContain("- Client Old");
    expect(text).toContain("Browser: copied from Acme, not checked yet");
    expect(text).toContain("## Moving to another computer");
  });
});
