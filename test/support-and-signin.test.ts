// When something goes wrong: "Details for support" (nothing secret in it) and the warning before a
// sign-in the service set to end runs out.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signInEndsAt } from "../packages/gateway/src/oauth.js";
import { ClientStore, oauthKey, type ConnectionInput } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";
import { EVERY_CLIENT_ID } from "../packages/gateway/src/config.js";
import { SIGN_IN_WARN_DAYS, signInEndWarning } from "../apps/desktop/src/shared/key-expiry.js";
import { needsAttention } from "../apps/desktop/src/renderer/client-list.js";
import { scrub, supportDetails, toolLogLines } from "../apps/desktop/src/main/support.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});
function tempDir(): string {
  const d = fs.mkdtempSync(join(tmpdir(), "rk-support-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString("utf8"),
};
const DAY = 24 * 60 * 60 * 1000;

describe("when a sign-in ends", () => {
  it("uses what the service said: the refresh token's lifetime, or the access token's when there's no refresh token", () => {
    expect(signInEndsAt({ obtainedAt: 1000, tokens: { access_token: "a", token_type: "bearer", refresh_token: "r", refresh_token_expires_in: 30 * 86400 } as never })).toBe(1000 + 30 * DAY);
    expect(signInEndsAt({ obtainedAt: 1000, tokens: { access_token: "a", token_type: "bearer", expires_in: 60 * 86400 } })).toBe(1000 + 60 * DAY);
  });

  it("says nothing when it isn't known, or when it's short by design", () => {
    // A refresh token with no stated end keeps renewing.
    expect(signInEndsAt({ obtainedAt: 1000, tokens: { access_token: "a", token_type: "bearer", refresh_token: "r", expires_in: 3600 } })).toBeUndefined();
    // An hour-long sign-in with nothing to renew it: redone as a matter of course, not warned about ahead.
    expect(signInEndsAt({ obtainedAt: 1000, tokens: { access_token: "a", token_type: "bearer", expires_in: 3600 } })).toBeUndefined();
    expect(signInEndsAt({ tokens: { access_token: "a", token_type: "bearer", expires_in: 60 * 86400 } })).toBeUndefined();
    expect(signInEndsAt(undefined)).toBeUndefined();
  });

  it("warns a week ahead, and once it has ended", () => {
    const now = Date.UTC(2026, 10, 22, 12);
    const conn = (endsIn: number) => ({ auth: "oauth", signedIn: true, signInEndsAt: now + endsIn });
    expect(signInEndWarning(conn(SIGN_IN_WARN_DAYS * DAY + 60_000), now)).toBeNull();
    expect(signInEndWarning(conn(3 * DAY), now)).toBe("This sign-in ends on November 25, as the service set it. Click Sign in before then to keep it working.");
    expect(signInEndWarning(conn(-DAY), now)).toBe("This sign-in ended on November 21. Click Sign in to sign in again.");
    expect(signInEndWarning({ ...conn(DAY), signedIn: false }, now)).toBeNull();
  });

  it("a tool shows when its sign-in ends, and Needs attention lists it a week ahead", () => {
    const dir = tempDir();
    const secrets = new SecretStore(join(dir, "secrets.json"), cipher);
    const store = new ClientStore(join(dir, "clients.json"), secrets);
    const acme = store.addClient("Acme");
    const ads: ConnectionInput = { kind: "remote", name: "Ads", url: "https://ads.example.com/mcp", auth: "oauth", fields: [] };
    const c = store.addConnection(acme.id, ads);
    const obtainedAt = Date.now() - 55 * DAY;
    secrets.set(oauthKey(acme.id, c.id), JSON.stringify({ obtainedAt, tokens: { access_token: "a", token_type: "bearer", expires_in: 60 * 86400 } }));
    const view = store.view(acme.id)!.connections[0]!;
    expect(view.signInEndsAt).toBe(obtainedAt + 60 * DAY);
    const list = needsAttention(store.list(), store.everyClient(), [], EVERY_CLIENT_ID);
    expect(list.map((a) => [a.conn.name, a.fix])).toEqual([["Ads", "signin"]]);
    expect(list[0]!.problem).toMatch(/^This sign-in ends on /);
    // A broken saved sign-in never breaks the window.
    secrets.set(oauthKey(acme.id, c.id), "not json");
    expect(store.view(acme.id)!.connections[0]!.signInEndsAt).toBeUndefined();
  });
});

describe("details for support", () => {
  it("takes out the tool's keys, tokens, long codes and the client's name", () => {
    const out = scrub(
      [
        "Acme Corp's n8n refused key n8n_api_12345678 (Authorization: Bearer abc.def.ghi)",
        "GET https://x.example.com/hook?token=s3cr3t&page=2 key=hunter22",
        "id 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 done",
      ].join("\n"),
      ["n8n_api_12345678"],
      "Acme Corp",
    );
    expect(out).not.toMatch(/n8n_api_12345678|abc\.def\.ghi|s3cr3t|hunter22|9f86d081|Acme/);
    expect(out).toContain("[client]'s n8n refused key •••");
    expect(out).toContain("Bearer •••");
    expect(out).toContain("token=•••&page=2 key=•••");
  });

  it("reads only this tool's last lines from the log, newest last", () => {
    const dir = tempDir();
    const log = join(dir, "gateway.log");
    const lines = [
      '{"cut off half a line',
      ...Array.from({ length: 20 }, (_, i) => JSON.stringify({ t: `2026-11-22T07:00:${String(i).padStart(2, "0")}Z`, ev: "upstream_stderr", client: "acme", conn: "n8n", text: `line ${i}` })),
      JSON.stringify({ t: "x", ev: "upstream_error", client: "globex", conn: "n8n", error: "not this one" }),
      JSON.stringify({ t: "y", ev: "upstream_ready", client: "acme", conn: "n8n", tools: 12 }),
    ];
    fs.writeFileSync(log, lines.join("\n") + "\n");
    const got = toolLogLines(log, "acme", "n8n", 5);
    expect(got.map((l) => l.text)).toEqual(["line 16", "line 17", "line 18", "line 19", "12 actions"]);
    expect(toolLogLines(join(dir, "missing.log"), "acme", "n8n")).toEqual([]);
  });

  it("puts it together without anything secret in it", () => {
    const text = supportDetails({
      version: "0.2.8",
      system: "Windows 10.0.26300 (x64)",
      clientName: "Acme",
      tool: { name: "n8n", service: "n8n", how: "web address on acme.app.n8n.cloud", status: "not working: n8n for Acme didn't accept the key", keys: "Authorization saved" },
      lines: [{ t: "2026-11-22T07:00:00Z", ev: "upstream_error", text: "401 Unauthorized for Bearer eyJhbGciOiJIUzI1NiJ9" }],
      secrets: ["Bearer eyJhbGciOiJIUzI1NiJ9"],
    });
    expect(text).toContain("Ringkeeper Connect 0.2.8 on Windows 10.0.26300 (x64)\nTool: n8n\n");
    expect(text).toContain("Status: not working: n8n for [client] didn't accept the key");
    expect(text).toContain("Last 1 log lines for this tool (oldest first):\n2026-11-22T07:00:00Z upstream_error: 401 Unauthorized for •••");
    expect(text).not.toContain("eyJ");
    expect(text).not.toContain("Acme");
    // The address's own wording is left alone (only the client's name as written is taken out).
    expect(text).toContain("Connects: web address on acme.app.n8n.cloud");
  });
});
