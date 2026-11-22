// Send to Ringkeeper: every client, locked with the public key the full Ringkeeper app
// publishes in its own folder, and left there for it to bring in.
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CopyPayload } from "../packages/gateway/src/store/copy.js";
import { HANDOVER_KIND, HandoverError, NO_RINGKEEPER, ringkeeperFolder, ringkeeperKey, sealForRingkeeper, sendToRingkeeper } from "../packages/gateway/src/store/handover.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function folder(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "rk-handover-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** What the Ringkeeper app does: a key pair, its public half where Connect looks. */
function ringkeeper(dir: string) {
  const pair = generateKeyPairSync("x25519");
  const raw = Buffer.from(String(pair.publicKey.export({ format: "jwk" }).x), "base64url");
  fs.writeFileSync(join(dir, "ringkeeper.pub"), `${raw.toString("base64url")}\n`);
  return pair.privateKey;
}

/** What Ringkeeper does to open it (services/connect_handover.py, in Python). */
function openAsRingkeeper(text: string, privateKey: ReturnType<typeof createPrivateKey>): CopyPayload {
  const sealed = JSON.parse(text);
  const theirs = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: sealed.epk }, format: "jwk" });
  const shared = diffieHellman({ privateKey, publicKey: theirs });
  const context = Buffer.from("ringkeeper-connect-handover 1");
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(sealed.salt, "base64url"), context, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
  decipher.setAAD(context);
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
  const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64url")), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

const payload: CopyPayload = {
  kind: "ringkeeper-connect-clients",
  version: 1,
  createdAt: "2026-11-22T10:00:00.000Z",
  clients: [
    {
      name: "Acme Bakery",
      connections: [{ id: "notes", name: "Notes", kind: "local", command: "npx", args: ["-y", "notes-mcp"], fields: { NOTES_KEY: { secret: "fake-key-123" } } }],
    },
  ],
  everyClient: [],
  ownApps: [],
};

describe("where Ringkeeper looks", () => {
  it("is its own data folder, on each system", () => {
    expect(ringkeeperFolder("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "C:\\Users\\a")).toBe(join("C:\\Users\\a\\AppData\\Local", "Ringkeeper", "handover"));
    expect(ringkeeperFolder("darwin", {}, "/Users/a")).toBe(join("/Users/a", "Library", "Application Support", "Ringkeeper", "handover"));
    expect(ringkeeperFolder("linux", {}, "/home/a")).toBe(join("/home/a", ".local", "share", "ringkeeper", "handover"));
  });

  it("has no key when Ringkeeper isn't there, or its key isn't one", () => {
    const dir = folder();
    expect(ringkeeperKey(dir)).toBeNull();
    fs.writeFileSync(join(dir, "ringkeeper.pub"), "not-a-key");
    expect(ringkeeperKey(dir)).toBeNull();
  });
});

describe("sending", () => {
  it("only the Ringkeeper with that key can open it, and it holds every client", () => {
    const dir = folder();
    const privateKey = ringkeeper(dir);
    const text = sealForRingkeeper(payload, ringkeeperKey(dir)!);
    expect(text).not.toContain("fake-key-123");
    expect(JSON.parse(text).kind).toBe(HANDOVER_KIND);
    expect(openAsRingkeeper(text, privateKey)).toEqual(payload);
    const other = generateKeyPairSync("x25519").privateKey;
    expect(() => openAsRingkeeper(text, other)).toThrow();
  });

  it("leaves it in Ringkeeper's folder", () => {
    const dir = folder();
    const privateKey = ringkeeper(dir);
    const name = sendToRingkeeper(payload, dir, new Date("2026-11-22T10:05:09.123Z"));
    expect(name).toBe("from-connect-20261122T100509.json");
    expect(openAsRingkeeper(fs.readFileSync(join(dir, name), "utf8"), privateKey).clients[0]!.name).toBe("Acme Bakery");
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("says so when Ringkeeper isn't on this computer", () => {
    expect(() => sendToRingkeeper(payload, folder())).toThrow(HandoverError);
    expect(() => sendToRingkeeper(payload, folder())).toThrow(NO_RINGKEEPER);
  });
});
