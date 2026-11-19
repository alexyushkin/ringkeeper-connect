// Editing one of Ringkeeper Connect's own tools (a Google or Microsoft account): its name and
// what the AI may do. Unticking keeps the sign-in; ticking something new needs a new one.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogActionError, CatalogActions } from "../apps/desktop/src/main/catalog.js";
import { registeredApps } from "../apps/desktop/src/main/registered-apps.js";
import { ClientStore, oauthKey, secretOAuthStore } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
};

function setup() {
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-edit-builtin-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secrets = new SecretStore(join(dir, "secrets.json"), cipher);
  const store = new ClientStore(join(dir, "clients.json"), secrets);
  const restarted: string[] = [];
  const actions = new CatalogActions({
    store,
    gateway: () => ({ applyConfig: () => {}, restartConnection: (_c: string, id: string) => restarted.push(id) }) as never,
    oauthStore: secretOAuthStore(secrets),
    openExternal: () => {},
    showSignInLink: () => {},
    onChange: () => {},
    apps: registeredApps({ RINGKEEPER_GOOGLE_CLIENT_ID: "ours.apps.googleusercontent.com", RINGKEEPER_MICROSOFT_CLIENT_ID: "11111111-2222-3333-4444-555555555555" }, {}),
  });
  const acme = store.addClient("Acme");
  const { connectionId } = actions.add(acme.id, "google", "signin", {}, "Google account 2", ["mail_read", "calendar_read"]);
  // As if signed in already.
  secrets.set(oauthKey(acme.id, connectionId), JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } }));
  const view = () => store.list()[0]!.connections[0]!;
  const ticks = () => view().fields.find((f) => f.name === "RINGKEEPER_ACCESS")?.value;
  return { store, secrets, actions, acme, connectionId, restarted, view, ticks };
}

describe("editing a built-in tool", () => {
  it("renames it and keeps its sign-in, permissions and app", () => {
    const t = setup();
    const before = t.view();
    expect(t.actions.editBuiltIn(t.acme.id, t.connectionId, "  Acme Gmail  ")).toEqual({ needsSignIn: false });
    expect(t.view()).toMatchObject({ name: "Acme Gmail", signedIn: true, oauthApp: "google", scope: before.scope });
    expect(t.ticks()).toBe("mail_read,calendar_read");
    expect(t.restarted).toEqual([t.connectionId]);
  });

  it("keeps the sign-in when something is unticked, and asks for a new one when something new is ticked", () => {
    const t = setup();
    expect(t.actions.editBuiltIn(t.acme.id, t.connectionId, "Google account 2", ["mail_read"])).toEqual({ needsSignIn: false });
    expect(t.ticks()).toBe("mail_read");
    expect(t.view()).toMatchObject({ signedIn: true });
    expect(t.view().scope).not.toContain("calendar");

    expect(t.actions.editBuiltIn(t.acme.id, t.connectionId, "Google account 2", ["mail_read", "mail_send"])).toEqual({ needsSignIn: true });
    expect(t.ticks()).toBe("mail_read,mail_send");
    expect(t.view()).toMatchObject({ signedIn: false });
    expect(t.view().scope).toContain("https://www.googleapis.com/auth/gmail.send");
  });

  it("refuses no ticks, a name another tool has, and tools that aren't built in", () => {
    const t = setup();
    expect(() => t.actions.editBuiltIn(t.acme.id, t.connectionId, "Google account 2", [])).toThrow(CatalogActionError);
    expect(() => t.actions.editBuiltIn(t.acme.id, t.connectionId, "Google account 2", ["nope"])).toThrow(/isn't offered anymore/);
    const other = t.store.addConnection(t.acme.id, { kind: "remote", name: "n8n", url: "https://example.com/mcp", fields: [] });
    expect(() => t.actions.editBuiltIn(t.acme.id, t.connectionId, "N8N")).toThrow(/already has a connection called "N8N"/);
    expect(() => t.actions.editBuiltIn(t.acme.id, other.id, "n8n 2")).toThrow("Only Ringkeeper Connect's own tools are edited here.");
    expect(t.view()).toMatchObject({ name: "Google account 2", signedIn: true });
  });
});
