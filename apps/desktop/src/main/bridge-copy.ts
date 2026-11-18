// AI apps run the bridge from a copy outside Ringkeeper's install folder.
//
// Ringkeeper's installer (and every automatic update, which runs the same
// installer) stops all programs running from the install folder before it
// replaces files. A bridge running from there was stopped too, and Claude
// Desktop then said "ringkeeper-connect stopped running" until it was
// restarted. A copy elsewhere keeps running through updates; it reconnects to
// the restarted app by itself.
//
// The copy's paths never change, so updates don't need to touch the AI apps'
// settings. When a new version brings a different Node or bridge, the copy is
// replaced in place. On Windows a running program can't be overwritten or
// deleted, but it can be renamed: the old one is moved aside and deleted on a
// later start, once nothing runs it.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { basename, join } from "node:path";
import { writeAtomic } from "@ringkeeper/hostconfig";

export interface BridgeCopy {
  node: string;
  bridge: string;
}

/** Where the copy lives: the per-computer app-data folder (never a roaming profile on Windows). */
export function bridgeHome(opts: { platform: NodeJS.Platform; dataDir: string; dataDirOverride?: string; localAppData?: string; appDirName: string }): string {
  if (opts.dataDirOverride) return join(opts.dataDirOverride, "bridge");
  if (opts.platform === "win32" && opts.localAppData) return join(opts.localAppData, opts.appDirName, "bridge");
  return join(opts.dataDir, "bridge");
}

interface Manifest {
  /** The source Node we last copied: size and time, to skip hashing when nothing changed. */
  nodeSource?: { size: number; mtimeMs: number; sha256: string };
}

function sha256(path: string): string {
  return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

function readManifest(path: string): Manifest {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as Manifest;
  } catch {
    return {};
  }
}

/** Delete copies moved aside earlier; still-running ones stay until next time. */
function removeOldCopies(dir: string): void {
  for (const f of fs.readdirSync(dir)) {
    if (!f.includes(".old-")) continue;
    try {
      fs.rmSync(join(dir, f), { force: true });
    } catch {
      // An AI app still runs it.
    }
  }
}

/** Put `from` at `to`, even if `to` is a program an AI app is running right now. */
function replaceFile(from: string, to: string, mode: number): void {
  const tmp = `${to}.new-${process.pid}-${Date.now()}`;
  fs.copyFileSync(from, tmp);
  fs.chmodSync(tmp, mode);
  try {
    fs.renameSync(tmp, to);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
  // Windows: the old copy is running. Move it aside, then put the new one in.
  try {
    fs.renameSync(to, `${to}.old-${Date.now()}`);
    fs.renameSync(tmp, to);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Make sure `dir` has an up-to-date copy of Node and the bridge. Cheap when
 * nothing changed (a few file reads). Throws if the copy can't be made.
 */
export function ensureBridgeCopy(source: BridgeCopy, dir: string): BridgeCopy {
  fs.mkdirSync(dir, { recursive: true });
  removeOldCopies(dir);
  const target: BridgeCopy = { node: join(dir, basename(source.node)), bridge: join(dir, basename(source.bridge)) };

  // The bridge script is small: compare it byte for byte. Node reads it once at
  // start, so replacing it never disturbs a running bridge.
  const script = fs.readFileSync(source.bridge);
  let current: Buffer | null = null;
  try {
    current = fs.readFileSync(target.bridge);
  } catch {
    current = null;
  }
  if (!current || !current.equals(script)) writeAtomic(target.bridge, script, 0o644);

  // Node is large: only hash it when the installed one looks different from last time.
  const manifestPath = join(dir, "copy.json");
  const manifest = readManifest(manifestPath);
  const st = fs.statSync(source.node);
  const known = manifest.nodeSource;
  let haveTarget = false;
  try {
    haveTarget = fs.statSync(target.node).size === st.size;
  } catch {
    haveTarget = false;
  }
  if (!(haveTarget && known && known.size === st.size && known.mtimeMs === st.mtimeMs)) {
    const hash = sha256(source.node);
    if (!(haveTarget && sha256(target.node) === hash)) replaceFile(source.node, target.node, 0o755);
    writeAtomic(manifestPath, JSON.stringify({ nodeSource: { size: st.size, mtimeMs: st.mtimeMs, sha256: hash } } satisfies Manifest, null, 2), 0o644);
  }
  return target;
}
