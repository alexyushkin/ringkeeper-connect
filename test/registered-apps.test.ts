// Ringkeeper Connect's own registered apps (Google, Microsoft): where their IDs
// come from, and that a connection keeps its app.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registeredApps } from "../apps/desktop/src/main/registered-apps.js";
import { CatalogActions } from "../apps/desktop/src/main/catalog.js";
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
    expect(apps.google).toMatchObject({
      id: "google",
      clientId: "g-id",
      clientSecret: "g-secret",
      authParams: { access_type: "offline", prompt: "consent select_account" },
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
    });
    expect(apps.microsoft).toMatchObject({ id: "microsoft", clientId: "ms-id", tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token" });
  });

  it("tools that don't need a registered app aren't marked unavailable; those that do are, in a build without it", () => {
    const deps = { store: store(), gateway: () => ({}) as never, oauthStore: { load: () => undefined, save: () => {} }, openExternal: () => {}, showSignInLink: () => {}, onChange: () => {} };
    for (const s of new CatalogActions(deps).services()) for (const o of s.options) expect("unavailable" in o, `${s.id}/${o.id}`).toBe(!!o.app);
  });

  it("a connection keeps its registered app and permissions, also through an edit and a copy", () => {
    const s = store();
    const a = s.addClient("Acme");
    const b = s.addClient("Globex");
    const url = "https://mail.example.com/mcp";
    const conn = s.addConnection(a.id, { kind: "remote", name: "Mail", url, auth: "oauth", oauthApp: "google", scope: "mail.read mail.send", fields: [] });
    expect(conn).toMatchObject({ kind: "remote", auth: "oauth", oauthApp: "google", scope: "mail.read mail.send" });

    // The window edits a connection from its view, renaming it: the app and permissions stay.
    s.updateConnection(a.id, conn.id, { kind: "remote", name: "Acme mail", url, auth: "oauth", fields: [] });
    expect(s.list().find((c) => c.id === a.id)!.connections[0]).toMatchObject({ name: "Acme mail", oauthApp: "google", scope: "mail.read mail.send" });

    const copied = s.cloneConnection(a.id, conn.id, b.id, {});
    expect(copied).toMatchObject({ oauthApp: "google" });
    expect(s.toGatewayConfig().clients.find((c) => c.id === b.id)!.connections[0]).toMatchObject({ oauth: { app: "google", scope: "mail.read mail.send" }, needsSignIn: true });
  });
});
