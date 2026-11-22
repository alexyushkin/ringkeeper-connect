// A copy of the user's clients for another computer: every client with its tools, keys and
// sign-ins, the tools for every client, and the user's own Google, Microsoft and Meta apps.
// It's locked with a password the user chooses (scrypt, then AES-256-GCM), so the file is
// useless without it. The keys are only ever in the clear in memory, never on disk.
import { randomBytes, scrypt as scryptCb, createCipheriv, createDecipheriv, type ScryptOptions } from "node:crypto";
import { isActionChoice, isClientGuard, type ActionChoice, type ClientGuard } from "../guard.js";

/** A plain setting, or a key: its value, or null when none was saved. */
export type CopyField = { value: string } | { secret: string | null };

interface CopyConnectionBase {
  id: string;
  name: string;
  fields: Record<string, CopyField>;
  auth?: "oauth";
  oauthApp?: string;
  scope?: string;
  actions?: ActionChoice;
  off?: true;
  copiedFrom?: string;
  /** The saved sign-in, as kept on the old computer. */
  signIn?: string;
}
export type CopyConnection =
  | (CopyConnectionBase & { kind: "local"; command: string; args: string[] })
  | (CopyConnectionBase & { kind: "remote"; url: string; transport?: "sse" });

export interface CopyClient {
  name: string;
  guard?: ClientGuard;
  pinned?: true;
  archived?: true;
  connections: CopyConnection[];
}

export interface CopyOwnApp {
  id: string;
  vendor: "google" | "microsoft" | "meta";
  name: string;
  clientId: string;
  tenant?: string;
  secret?: string;
}

export interface CopyPayload {
  kind: "ringkeeper-connect-clients";
  version: 1;
  createdAt: string;
  clients: CopyClient[];
  everyClient: CopyConnection[];
  ownApps: CopyOwnApp[];
}

/** Said to the user as it is. */
export class CopyError extends Error {}

const FILE_KIND = "ringkeeper-connect-copy";
const AAD = Buffer.from(`${FILE_KIND} 1`);
/** About a quarter of a second on a recent laptop, and 128 MB, for every guess at the password. */
const KDF = { N: 2 ** 17, r: 8, p: 1 } as const;
export const MIN_PASSWORD = 8;

interface CopyFile {
  kind: typeof FILE_KIND;
  version: 1;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(password: string, salt: Buffer, kdf: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 32 * 1024 * 1024 };
  return new Promise((resolve, reject) => scryptCb(password.normalize("NFC"), salt, 32, options, (err, key) => (err ? reject(err) : resolve(key))));
}

export function checkNewPassword(password: string, repeat: string): void {
  if (password.length < MIN_PASSWORD) throw new CopyError(`Use a password of at least ${MIN_PASSWORD} characters.`);
  if (password !== repeat) throw new CopyError("The two passwords aren't the same. Type them again.");
}

/** The file's text: the copy, locked with the password. */
export async function sealCopy(payload: CopyPayload, password: string, kdf: { N: number; r: number; p: number } = KDF): Promise<string> {
  if (password.length < MIN_PASSWORD) throw new CopyError(`Use a password of at least ${MIN_PASSWORD} characters.`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt, kdf);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const file: CopyFile = {
    kind: FILE_KIND,
    version: 1,
    kdf: { name: "scrypt", ...kdf, salt: salt.toString("base64") },
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(file);
}

const DAMAGED = "This file isn't a copy of Ringkeeper Connect clients, or it's damaged. Make a new copy on the other computer and try again.";

/** Whether a file's text looks like a copy at all (before asking for the password). */
export function isCopyFile(text: string): boolean {
  return readHeader(text) !== null;
}

function readHeader(text: string): CopyFile | null {
  let f: unknown;
  try {
    f = JSON.parse(text);
  } catch {
    return null;
  }
  const x = f as Partial<CopyFile> | null;
  if (!x || x.kind !== FILE_KIND || x.version !== 1 || !x.kdf || x.kdf.name !== "scrypt") return null;
  const { N, r, p } = x.kdf;
  // Refuse settings that would take far too long or too much memory (a hand-made file).
  const sane = (n: unknown, max: number) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max;
  if (!sane(N, 2 ** 20) || !sane(r, 16) || !sane(p, 4) || ((N as number) & ((N as number) - 1)) !== 0) return null;
  if (typeof x.kdf.salt !== "string" || typeof x.iv !== "string" || typeof x.tag !== "string" || typeof x.data !== "string") return null;
  return x as CopyFile;
}

/** Open a copy with its password. */
export async function openCopy(text: string, password: string): Promise<CopyPayload> {
  const file = readHeader(text);
  if (!file) throw new CopyError(DAMAGED);
  const key = await deriveKey(password, Buffer.from(file.kdf.salt, "base64"), file.kdf);
  let plain: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(file.tag, "base64"));
    plain = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // A wrong password and a changed file look the same here; the password is far more likely.
    throw new CopyError("That password doesn't open this copy. Check it (it's the one chosen when the copy was made) and try again.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(plain);
  } catch {
    throw new CopyError(DAMAGED);
  }
  if (!isPayload(payload)) throw new CopyError(DAMAGED);
  return payload;
}

// ---------- checking what came out (it's ours, but never trust a file's shape) ----------

const str = (v: unknown, max = 10_000): v is string => typeof v === "string" && v.length <= max;
const optStr = (v: unknown) => v === undefined || str(v);

function isField(v: unknown): v is CopyField {
  const f = v as Record<string, unknown> | null;
  if (!f || typeof f !== "object") return false;
  if ("value" in f) return str(f.value, 100_000);
  return "secret" in f && (f.secret === null || str(f.secret, 100_000));
}

function isConnection(v: unknown): v is CopyConnection {
  const c = v as Record<string, unknown> | null;
  if (!c || typeof c !== "object" || !str(c.id, 200) || !c.id || !str(c.name, 200) || !c.name) return false;
  if (!c.fields || typeof c.fields !== "object" || Array.isArray(c.fields) || !Object.values(c.fields).every(isField)) return false;
  if (c.auth !== undefined && c.auth !== "oauth") return false;
  if (!optStr(c.oauthApp) || !optStr(c.scope) || !optStr(c.copiedFrom) || !(c.signIn === undefined || str(c.signIn, 200_000))) return false;
  if (c.actions !== undefined && !isActionChoice(c.actions)) return false;
  if (c.off !== undefined && c.off !== true) return false;
  if (c.kind === "local") return str(c.command, 2000) && Array.isArray(c.args) && c.args.every((a) => str(a, 10_000));
  if (c.kind === "remote") return str(c.url, 4000) && (c.transport === undefined || c.transport === "sse");
  return false;
}

function isPayload(v: unknown): v is CopyPayload {
  const p = v as Record<string, unknown> | null;
  if (!p || p.kind !== "ringkeeper-connect-clients" || p.version !== 1 || !Array.isArray(p.clients) || !Array.isArray(p.everyClient) || !Array.isArray(p.ownApps)) {
    return false;
  }
  const clientOk = (c: Record<string, unknown>) =>
    c &&
    str(c.name, 200) &&
    (c.guard === undefined || isClientGuard(c.guard)) &&
    (c.pinned === undefined || c.pinned === true) &&
    (c.archived === undefined || c.archived === true) &&
    Array.isArray(c.connections) &&
    c.connections.every(isConnection);
  const appOk = (a: Record<string, unknown>) =>
    a && str(a.id, 200) && ["google", "microsoft", "meta"].includes(a.vendor as string) && str(a.name, 200) && str(a.clientId, 2000) && optStr(a.tenant) && optStr(a.secret);
  return (p.clients as Record<string, unknown>[]).every(clientOk) && p.everyClient.every(isConnection) && (p.ownApps as Record<string, unknown>[]).every(appOk);
}
