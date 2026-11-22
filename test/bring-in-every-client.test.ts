// Bringing tools in straight to "For every client": the setup sends the ones the user marks there
// (a browser helper), the rest to the client, and the AI apps' settings change as usual. Run
// against a made-up home folder, never the real AI apps.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppsService, sharedHelper } from "../apps/desktop/src/main/apps.js";
import { EVERY_CLIENT_ID } from "../packages/gateway/src/config.js";
import { ClientStore } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
};

function fakeHomeSetup() {
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-every-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  execFileSync(process.execPath, [resolve("spike/make-fake-home.mjs"), home], { stdio: "ignore" });
  // The made-up home is laid out like Windows; on a Mac, Claude Desktop keeps its settings under
  // Library/Application Support instead (the other apps' files are the same on both).
  if (process.platform === "darwin") {
    fs.cpSync(join(home, "AppData", "Roaming", "Claude"), join(home, "Library", "Application Support", "Claude"), { recursive: true });
  }
  const before = process.env.RINGKEEPER_FAKE_HOME;
  process.env.RINGKEEPER_FAKE_HOME = home;
  cleanups.push(() => {
    if (before === undefined) delete process.env.RINGKEEPER_FAKE_HOME;
    else process.env.RINGKEEPER_FAKE_HOME = before;
  });
  const data = join(dir, "data");
  fs.mkdirSync(data, { recursive: true });
  const secrets = new SecretStore(join(data, "secrets.json"), cipher);
  const store = new ClientStore(join(data, "clients.json"), secrets);
  const apps = new AppsService({
    dataDir: data,
    cipher,
    store,
    launch: () => ({ command: process.execPath, args: ["bridge.mjs"] }),
    onChange: () => {},
    notify: () => {},
  });
  return { home, store, apps };
}

describe("suggesting For every client", () => {
  it("suggests browser helpers and general tools, never one that keeps notes or files, nor a client's service", () => {
    const local = (args: string[], command = "npx") => ({ kind: "local" as const, name: "x", command, args, fields: [] });
    expect(sharedHelper("playwright", local(["-y", "@playwright/mcp"]))).toBe(true);
    expect(sharedHelper("browser", local(["-y", "@executeautomation/playwright-mcp-server"]))).toBe(true);
    expect(sharedHelper("puppeteer", local(["-y", "@modelcontextprotocol/server-puppeteer"]))).toBe(true);
    expect(sharedHelper("docs", { kind: "remote", name: "docs", url: "https://mcp.context7.com/mcp", fields: [] })).toBe(true);
    expect(sharedHelper("fetch", local(["mcp-server-fetch"], "uvx"))).toBe(true);
    expect(sharedHelper("memory", local(["-y", "@modelcontextprotocol/server-memory"]))).toBe(false);
    expect(sharedHelper("files", local(["-y", "@modelcontextprotocol/server-filesystem", "C:/work"]))).toBe(false);
    expect(sharedHelper("n8n", { kind: "remote", name: "n8n", url: "https://acme.app.n8n.cloud/mcp-server/http", fields: [] })).toBe(false);
    expect(sharedHelper("airtable", undefined)).toBe(false);
  });
});

describe("the setup bringing a helper in for every client", () => {
  it("sends the marked helper to For every client and the rest to the client, and moves both out of the AI app", () => {
    const { home, store, apps } = fakeHomeSetup();
    const scan = apps.scan();
    const playwright = scan.candidates.find((c) => c.name === "playwright")!;
    const n8n = scan.candidates.find((c) => c.name === "n8n")!;
    expect(playwright.shared).toBe(true);
    expect(n8n.shared).toBeUndefined();

    const out = apps.setup({ client: { newName: "Acme" }, take: [playwright.key, n8n.key], everyClient: [playwright.key], hosts: ["claude-desktop"], tools: [] });
    expect(out.problems).toEqual([]);
    expect(out.imported.sort()).toEqual(["n8n", "playwright"]);
    expect(out.toEveryClient).toEqual(["playwright"]);
    expect(store.everyClient().connections.map((c) => c.name)).toEqual(["playwright"]);
    const acme = store.list().find((c) => c.name === "Acme")!;
    expect(acme.connections.map((c) => c.name)).toEqual(["n8n"]);
    // The n8n key came along, kept with the client; the helper had none.
    expect(acme.connections[0]!.missingKeys).toEqual([]);
    // Claude Desktop now reaches both through Ringkeeper Connect, and keeps its other settings.
    const desktopDir = process.platform === "darwin" ? join(home, "Library", "Application Support", "Claude") : join(home, "AppData", "Roaming", "Claude");
    const desktop = JSON.parse(fs.readFileSync(join(desktopDir, "claude_desktop_config.json"), "utf8"));
    expect(Object.keys(desktop.mcpServers)).toEqual(["ringkeeper-connect"]);
    expect(desktop.preferences).toEqual({ sidebarMode: "chat", menuBarEnabled: false });

    // Seen again later, the helper shows as already there for every client.
    const again = apps.scan().candidates.find((c) => c.name === "playwright");
    if (again) expect(again.inClients).toContainEqual({ clientId: EVERY_CLIENT_ID, clientName: "every client", same: true });
  });

  it("without the mark, everything goes to the client as before", () => {
    const { store, apps } = fakeHomeSetup();
    const scan = apps.scan();
    const keys = scan.candidates.filter((c) => !c.problem && ["playwright", "n8n"].includes(c.name)).map((c) => c.key);
    const out = apps.setup({ client: { newName: "Acme" }, take: keys, hosts: ["claude-desktop"], tools: [] });
    expect(out.toEveryClient).toEqual([]);
    expect(store.everyClient().connections).toEqual([]);
    expect(store.list()[0]!.connections.map((c) => c.name).sort()).toEqual(["n8n", "playwright"]);
  });
});
