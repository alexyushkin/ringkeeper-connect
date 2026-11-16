// Downloads the pinned Node and uv builds, checks their SHA-256 against
// runtimes/runtimes.json, and unpacks them to apps/desktop/runtimes/<target>/
//   node/  (node, npm, npx)
//   uv/    (uv, uvx)
// The packaged app ships the folder for its own platform (M5).
//   node scripts/fetch-runtimes.mjs [win32-x64|darwin-arm64|darwin-x64|all]
// Default: this computer's target.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const manifest = JSON.parse(fs.readFileSync("runtimes/runtimes.json", "utf8"));
const here = `${process.platform}-${process.arch}`;
const wanted = process.argv[2] ?? here;
const targets = wanted === "all" ? Object.keys(manifest.node.targets) : [wanted];
const outRoot = resolve("apps/desktop/runtimes");

async function download(url) {
  const res = await fetch(url, { headers: { "User-Agent": "ringkeeper-connect-build" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function unpack(buf, archive, dest) {
  const work = fs.mkdtempSync(join(tmpdir(), "rk-runtime-"));
  const file = join(work, archive === "zip" ? "a.zip" : "a.tar.gz");
  fs.writeFileSync(file, buf);
  const extracted = join(work, "x");
  fs.mkdirSync(extracted);
  // bsdtar (built into Windows 10+ and macOS) reads both zip and tar.gz. On
  // Windows, name it explicitly: Git's GNU tar may come first on PATH and
  // can't read zip files.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", file, "-C", extracted], { stdio: "inherit" });
  // Most archives have one top folder (node-v…/, uv-…/); flatten it.
  const entries = fs.readdirSync(extracted);
  const root = entries.length === 1 && fs.statSync(join(extracted, entries[0])).isDirectory() ? join(extracted, entries[0]) : extracted;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(root, dest, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(work, { recursive: true, force: true });
}

/**
 * Drop what running connections never needs: C headers, docs, the changelog
 * and corepack. npm (and npx) stay.
 */
function trimNode(dir) {
  const doomed = [
    "include", "share", "CHANGELOG.md", "README.md",
    "node_modules/corepack", "lib/node_modules/corepack",
    "corepack", "corepack.cmd", "corepack.ps1", "bin/corepack",
    "install_tools.bat", "nodevars.bat",
  ];
  let freed = 0;
  for (const rel of doomed) {
    const p = join(dir, rel);
    if (!fs.existsSync(p)) continue;
    freed += size(p);
    fs.rmSync(p, { recursive: true, force: true });
  }
  return freed;
}

function size(p) {
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, e) => n + size(join(p, e)), 0);
}

for (const target of targets) {
  for (const name of ["node", "uv"]) {
    const t = manifest[name].targets[target];
    if (!t) throw new Error(`No ${name} build pinned for ${target}`);
    const dest = join(outRoot, target, name);
    const stamp = join(dest, ".pinned");
    if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === t.sha256) {
      const freed = name === "node" ? trimNode(dest) : 0;
      console.log(`${name} ${manifest[name].version} for ${target}: already here${freed ? ` (trimmed ${(freed / 1e6).toFixed(0)} MB)` : ""}`);
      continue;
    }
    process.stdout.write(`${name} ${manifest[name].version} for ${target}: downloading… `);
    const buf = await download(t.url);
    const sum = createHash("sha256").update(buf).digest("hex");
    if (sum !== t.sha256) throw new Error(`Checksum mismatch for ${t.url}: expected ${t.sha256}, got ${sum}. Not using it.`);
    unpack(buf, t.archive, dest);
    if (name === "node") trimNode(dest);
    fs.writeFileSync(stamp, t.sha256);
    console.log(`ok (${(buf.length / 1e6).toFixed(1)} MB, checksum verified)`);
  }
}
