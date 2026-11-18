// Ringkeeper Connect's own registered apps (Google, Microsoft): where their IDs
// come from, how the catalog shows tools that need one, and that a connection
// keeps its app.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registeredApps } from "../apps/desktop/src/main/registered-apps.js";
import { CatalogActions } from "../apps/desktop/src/main/catalog.js";
import { buildConnection } from "../packages/catalog/src/index.js";
import { ClientStore } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function store() {
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-apps-"));
  dirs.push(dir);
  const cipher: Cipher = {
    isAvailable: () => true,
    encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
    decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
  };
  return new ClientStore(join(dir, "clients.json"), new SecretStore(join(dir, "secrets.json"), cipher));
}

describe("registered apps", () => {
  it("come from the build, or from the environment for a development run; none without IDs", () => {
    expect(registeredApps({}, {})).toEqual({});
    const apps = registeredApps(
      { RINGKEEPER_MICROSOFT_CLIENT_ID: "ms-id" },
      { RINGKEEPER_GOOGLE_CLIENT_ID: "g-id", RINGKEEPER_GOOGLE_CLIENT_SECRET: "g-secret" },
    );
    expect(apps.google).toEqual({ id: "google", clientId: "g-id", clientSecret: "g-secret", authParams: { access_type: "offline", prompt: "consent" } });
    expect(apps.microsoft).toEqual({ id: "microsoft", clientId: "ms-id" });
  });

  it("the catalog marks Google tools unavailable in a build without the Google app", () => {
    const deps = { store: store(), gateway: () => ({}) as never, oauthStore: { load: () => undefined, save: () => {} }, openExternal: () => {}, showSignInLink: () => {}, onChange: () => {} };
    const without = new CatalogActions(deps).services().find((s) => s.id === "gmail")!;
    expect(without.options[0]).toMatchObject({ unavailable: true });
    const withApp = new CatalogActions({ ...deps, apps: { google: { id: "google", clientId: "x" } } }).services().find((s) => s.id === "gmail")!;
    expect(withApp.options[0]).not.toHaveProperty("unavailable");
    // Tools that don't need an app are untouched.
    expect(new CatalogActions(deps).services().find((s) => s.id === "notion")!.options.some((o) => "unavailable" in o)).toBe(false);
  });

  it("a Gmail connection keeps its app and permissions, also through an edit and a copy", () => {
    const s = store();
    const a = s.addClient("Acme");
    const b = s.addClient("Globex");
    const conn = s.addConnection(a.id, buildConnection("gmail", "signin", {}));
    expect(conn).toMatchObject({ kind: "remote", auth: "oauth", oauthApp: "google", url: "https://gmailmcp.googleapis.com/mcp/v1" });
    expect(conn.kind === "remote" && conn.scope).toContain("gmail.readonly");

    // The window edits a connection from its view, renaming it: the app and permissions stay.
    s.updateConnection(a.id, conn.id, { kind: "remote", name: "Acme mail", url: "https://gmailmcp.googleapis.com/mcp/v1", auth: "oauth", fields: [] });
    const edited = s.list().find((c) => c.id === a.id)!.connections[0]!;
    expect(edited).toMatchObject({ name: "Acme mail", oauthApp: "google" });
    expect(edited.kind === "remote" && edited.scope).toContain("gmail.readonly");

    const copied = s.cloneConnection(a.id, conn.id, b.id, {});
    expect(copied).toMatchObject({ oauthApp: "google" });
    expect(s.toGatewayConfig().clients.find((c) => c.id === b.id)!.connections[0]).toMatchObject({ oauth: { app: "google" }, needsSignIn: true });
  });
});
