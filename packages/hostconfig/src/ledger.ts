// What Ringkeeper changed in each AI app's settings, so Restore can undo it.
// Everything here can contain keys (the connections we moved out), so the
// ledger and every backup are encrypted with safeStorage.
import fs from "node:fs";
import { join } from "node:path";
import { SecretStorageUnavailableError, type Cipher } from "@ringkeeper/gateway";
import type { HostId } from "./hosts.js";

export interface TakenEntry {
  name: string;
  value: unknown;
  takenAt: string;
}

export interface HostLedger {
  /** The file we edited. */
  path: string;
  /** Exact text before Ringkeeper first touched it; null if the file didn't exist. */
  originalText: string | null;
  /** What we last wrote, to recognise our own writes and "unchanged since". */
  lastWrittenText: string | null;
  /** Connections moved out of this app into Ringkeeper, oldest first. */
  taken: TakenEntry[];
  /**
   * When our entry was added, or changed in a way the app must reload to see
   * (a different program or bridge). The app counts as using us only after
   * contacting us since then.
   */
  entryWrittenAt?: number;
}

interface LedgerData {
  version: 1;
  hosts: Partial<Record<HostId, HostLedger>>;
  /** Connections the user chose to leave in the app; don't ask about them again. */
  ignored: Partial<Record<HostId, string[]>>;
}

const MAX_BACKUPS_PER_HOST = 20;

export class Ledger {
  private data: LedgerData;
  private readonly file: string;
  readonly backupDir: string;

  constructor(
    dir: string,
    private readonly cipher: Cipher,
  ) {
    this.file = join(dir, "host-ledger.enc");
    this.backupDir = join(dir, "backups");
    this.data = this.load();
  }

  private load(): LedgerData {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.file);
    } catch {
      return { version: 1, hosts: {}, ignored: {} };
    }
    if (!this.cipher.isAvailable()) throw new SecretStorageUnavailableError();
    const parsed = JSON.parse(this.cipher.decrypt(raw)) as LedgerData;
    return { version: 1, hosts: parsed.hosts ?? {}, ignored: parsed.ignored ?? {} };
  }

  private save(): void {
    if (!this.cipher.isAvailable()) throw new SecretStorageUnavailableError();
    fs.mkdirSync(join(this.file, ".."), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, this.cipher.encrypt(JSON.stringify(this.data)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  host(id: HostId): HostLedger | undefined {
    const h = this.data.hosts[id];
    return h ? { ...h, taken: [...h.taken] } : undefined;
  }

  hosts(): HostId[] {
    return Object.keys(this.data.hosts) as HostId[];
  }

  /** Called right before each write to an app's file. Keeps the very first original. */
  beforeWrite(id: HostId, path: string, before: string | null): void {
    const h = this.data.hosts[id];
    if (!h) this.data.hosts[id] = { path, originalText: before, lastWrittenText: null, taken: [] };
    this.backup(id, before);
    this.save();
  }

  afterWrite(id: HostId, after: string, taken: Array<{ name: string; value: unknown }> = [], entryChanged = false, at = Date.now()): void {
    const h = this.data.hosts[id];
    if (!h) return;
    h.lastWrittenText = after;
    if (entryChanged) h.entryWrittenAt = at;
    const takenAt = new Date(at).toISOString();
    for (const t of taken) {
      h.taken = h.taken.filter((x) => x.name !== t.name);
      h.taken.push({ name: t.name, value: t.value, takenAt });
    }
    this.save();
  }

  forgetHost(id: HostId): void {
    delete this.data.hosts[id];
    this.save();
  }

  ignore(id: HostId, name: string): void {
    const list = new Set(this.data.ignored[id] ?? []);
    list.add(name);
    this.data.ignored[id] = [...list];
    this.save();
  }

  isIgnored(id: HostId, name: string): boolean {
    return (this.data.ignored[id] ?? []).includes(name);
  }

  /** Encrypted, timestamped copy of the file as it was before a change. */
  private backup(id: HostId, text: string | null): void {
    if (text === null) return;
    const dir = join(this.backupDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(join(dir, `${stamp}.enc`), this.cipher.encrypt(text), { mode: 0o600 });
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".enc")).sort();
    for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS_PER_HOST))) fs.rmSync(join(dir, old), { force: true });
  }

  /** Newest first. */
  listBackups(id: HostId): string[] {
    try {
      return fs
        .readdirSync(join(this.backupDir, id))
        .filter((f) => f.endsWith(".enc"))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  readBackup(id: HostId, file: string): string {
    return this.cipher.decrypt(fs.readFileSync(join(this.backupDir, id, file)));
  }
}
