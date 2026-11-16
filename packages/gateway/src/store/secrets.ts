// Secrets (API keys, tokens) live only here, encrypted with the OS keychain
// via Electron safeStorage. clients.json holds references, never values.
import fs from "node:fs";
import { readJson, writeJsonAtomic } from "../runtime.js";

/** What Electron's safeStorage provides; tests pass a fake. */
export interface Cipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export class SecretStorageUnavailableError extends Error {
  constructor() {
    super(
      "Your computer's secure storage isn't available, so Ringkeeper Connect can't save keys safely. " +
        "On a Mac, unlock your keychain; on Windows, sign in to your user account normally, then try again.",
    );
  }
}

interface SecretsFile {
  version: 1;
  /** key → base64 of the encrypted value */
  entries: Record<string, string>;
}

export class SecretStore {
  private entries: Record<string, string>;

  constructor(
    private readonly path: string,
    private readonly cipher: Cipher,
  ) {
    const file = readJson<SecretsFile>(path);
    this.entries = file?.version === 1 && file.entries ? { ...file.entries } : {};
  }

  has(key: string): boolean {
    return key in this.entries;
  }

  get(key: string): string | undefined {
    const enc = this.entries[key];
    if (enc === undefined) return undefined;
    if (!this.cipher.isAvailable()) throw new SecretStorageUnavailableError();
    return this.cipher.decrypt(Buffer.from(enc, "base64"));
  }

  set(key: string, value: string): void {
    if (!this.cipher.isAvailable()) throw new SecretStorageUnavailableError();
    this.entries[key] = this.cipher.encrypt(value).toString("base64");
    this.save();
  }

  delete(key: string): void {
    if (!(key in this.entries)) return;
    delete this.entries[key];
    this.save();
  }

  /** Delete every secret whose key starts with `prefix` (a client or connection). */
  deletePrefix(prefix: string): void {
    const doomed = Object.keys(this.entries).filter((k) => k.startsWith(prefix));
    if (!doomed.length) return;
    for (const k of doomed) delete this.entries[k];
    this.save();
  }

  keys(): string[] {
    return Object.keys(this.entries);
  }

  private save(): void {
    if (Object.keys(this.entries).length === 0 && !fs.existsSync(this.path)) return;
    writeJsonAtomic(this.path, { version: 1, entries: this.entries } satisfies SecretsFile);
  }
}
