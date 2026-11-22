// Send to Ringkeeper: everything a copy for another computer holds (every client with its
// tools, keys and sign-ins, the tools for every client), handed to the full Ringkeeper app on
// this computer. No file to pick and no password: Ringkeeper publishes a public key in its own
// folder (handover/ringkeeper.pub), and what's sent is locked with it (X25519, HKDF-SHA256,
// AES-256-GCM), so only that Ringkeeper can open it. The keys are never on disk in the clear.
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import type { CopyPayload } from "./copy.js";

export const HANDOVER_KIND = "ringkeeper-connect-handover";
/** The key derivation's info and the cipher's associated data; Ringkeeper uses the same. */
const CONTEXT = Buffer.from("ringkeeper-connect-handover 1");
const PUBLIC = "ringkeeper.pub";

/** Said to the user as it is. */
export class HandoverError extends Error {}

export const NO_RINGKEEPER =
  "Ringkeeper isn't on this computer, or hasn't been opened yet. Install Ringkeeper, open it once, then try again.";

/** Where Ringkeeper looks for what's sent to it: its own data folder, per system. */
export function ringkeeperFolder(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Ringkeeper", "handover");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Ringkeeper", "handover");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "ringkeeper", "handover");
}

/** Ringkeeper's public key, or null when it hasn't published one (not installed, or never opened). */
export function ringkeeperKey(folder: string): Buffer | null {
  let text: string;
  try {
    text = fs.readFileSync(join(folder, PUBLIC), "utf8").trim();
  } catch {
    return null;
  }
  const raw = Buffer.from(text, "base64url");
  return raw.length === 32 ? raw : null;
}

/** The payload, locked so only the Ringkeeper with this public key can open it. */
export function sealForRingkeeper(payload: CopyPayload, publicKey: Buffer): string {
  const theirs = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: publicKey.toString("base64url") }, format: "jwk" });
  const mine = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: mine.privateKey, publicKey: theirs });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = Buffer.from(hkdfSync("sha256", shared, salt, CONTEXT, 32));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(CONTEXT);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const epk = String(mine.publicKey.export({ format: "jwk" }).x);
  return JSON.stringify({
    kind: HANDOVER_KIND,
    version: 1,
    createdAt: payload.createdAt,
    epk,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: data.toString("base64url"),
  });
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
}

/** Leave it where Ringkeeper looks. Returns the file's name. */
export function sendToRingkeeper(payload: CopyPayload, folder: string, now = new Date()): string {
  const key = ringkeeperKey(folder);
  if (!key) throw new HandoverError(NO_RINGKEEPER);
  const name = `from-connect-${stamp(now)}.json`;
  const path = join(folder, name);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, sealForRingkeeper(payload, key), { mode: 0o600 });
    fs.renameSync(tmp, path);
  } catch {
    fs.rmSync(tmp, { force: true });
    throw new HandoverError("Ringkeeper Connect couldn't hand your clients to Ringkeeper. Check that Ringkeeper is installed for this user, then try again.");
  }
  return name;
}
