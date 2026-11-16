// Writes runtimes/runtimes.json: the exact Node and uv builds Ringkeeper ships,
// with checksums taken from the publishers' own checksum files. Re-run only
// when upgrading a version; fetch-runtimes.mjs verifies against these.
//   node scripts/pin-runtimes.mjs <node-version> <uv-version>
import fs from "node:fs";

const [nodeVersion = "24.22.3", uvVersion = "0.13.8"] = process.argv.slice(2);

const nodeTargets = {
  "win32-x64": { file: `node-v${nodeVersion}-win-x64.zip`, archive: "zip" },
  "darwin-arm64": { file: `node-v${nodeVersion}-darwin-arm64.tar.gz`, archive: "tar.gz" },
  "darwin-x64": { file: `node-v${nodeVersion}-darwin-x64.tar.gz`, archive: "tar.gz" },
};
const uvTargets = {
  "win32-x64": { file: "uv-x86_64-pc-windows-msvc.zip", archive: "zip" },
  "darwin-arm64": { file: "uv-aarch64-apple-darwin.tar.gz", archive: "tar.gz" },
  "darwin-x64": { file: "uv-x86_64-apple-darwin.tar.gz", archive: "tar.gz" },
};

async function text(url) {
  const res = await fetch(url, { headers: { "User-Agent": "ringkeeper-connect-build" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const nodeBase = `https://nodejs.org/dist/v${nodeVersion}`;
const shasums = await text(`${nodeBase}/SHASUMS256.txt`);
const node = { version: nodeVersion, targets: {} };
for (const [target, t] of Object.entries(nodeTargets)) {
  const line = shasums.split("\n").find((l) => l.trim().endsWith(`  ${t.file}`));
  if (!line) throw new Error(`No checksum for ${t.file}`);
  node.targets[target] = { url: `${nodeBase}/${t.file}`, sha256: line.split(/\s+/)[0], archive: t.archive };
}

const uvBase = `https://github.com/astral-sh/uv/releases/download/${uvVersion}`;
const uv = { version: uvVersion, targets: {} };
for (const [target, t] of Object.entries(uvTargets)) {
  const sum = (await text(`${uvBase}/${t.file}.sha256`)).trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(sum)) throw new Error(`Bad checksum file for ${t.file}`);
  uv.targets[target] = { url: `${uvBase}/${t.file}`, sha256: sum, archive: t.archive };
}

fs.mkdirSync("runtimes", { recursive: true });
fs.writeFileSync("runtimes/runtimes.json", JSON.stringify({ node, uv }, null, 2) + "\n");
console.log(`pinned Node ${nodeVersion} and uv ${uvVersion} → runtimes/runtimes.json`);
