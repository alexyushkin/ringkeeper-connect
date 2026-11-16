// Run local connections on the Node and uv that ship with Ringkeeper Connect,
// so nobody has to install them. Commands are rewritten when a connection is
// started, never in the stored settings, so the user's own setup (and
// Restore) stay exactly as written.
import fs from "node:fs";
import { basename, join } from "node:path";

export interface BundledRuntimes {
  /** Folder of the unpacked Node build (node.exe on Windows; bin/node elsewhere). */
  nodeDir?: string;
  /** Folder with uv and uvx. */
  uvDir?: string;
  platform?: NodeJS.Platform;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function paths(rt: BundledRuntimes) {
  const win = (rt.platform ?? process.platform) === "win32";
  const exe = win ? ".exe" : "";
  const nodeBin = rt.nodeDir ? (win ? join(rt.nodeDir, "node.exe") : join(rt.nodeDir, "bin", "node")) : undefined;
  const npmRoot = rt.nodeDir ? (win ? join(rt.nodeDir, "node_modules", "npm") : join(rt.nodeDir, "lib", "node_modules", "npm")) : undefined;
  return {
    win,
    nodeBin,
    nodeBinDir: rt.nodeDir ? (win ? rt.nodeDir : join(rt.nodeDir, "bin")) : undefined,
    npxCli: npmRoot && join(npmRoot, "bin", "npx-cli.js"),
    npmCli: npmRoot && join(npmRoot, "bin", "npm-cli.js"),
    uv: rt.uvDir && join(rt.uvDir, `uv${exe}`),
    uvx: rt.uvDir && join(rt.uvDir, `uvx${exe}`),
  };
}

/** True when the bundled copies are actually on disk. */
export function runtimesPresent(rt: BundledRuntimes): { node: boolean; uv: boolean } {
  const p = paths(rt);
  return { node: !!p.nodeBin && fs.existsSync(p.nodeBin), uv: !!p.uvx && fs.existsSync(p.uvx) };
}

/** "npx", "npx.cmd", "C:\\…\\npx.CMD" → "npx" */
function commandName(command: string): string {
  return basename(command).toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, "");
}

function withPathFirst(env: Record<string, string>, dirs: string[], win: boolean): Record<string, string> {
  if (!dirs.length) return env;
  // Windows env names are case-insensitive; keep whichever spelling is there.
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? (win ? "Path" : "PATH");
  const sep = win ? ";" : ":";
  return { ...env, [key]: [...dirs, env[key] ?? ""].filter(Boolean).join(sep) };
}

/**
 * Point npx/npm/node/uvx/uv at the bundled copies. Anything else runs as
 * written. The bundled folders also go first on PATH, so tools the server
 * starts (npm scripts calling `node`, for example) find them too.
 */
export function resolveLaunch(command: string, args: string[], env: Record<string, string>, rt: BundledRuntimes): LaunchSpec {
  const p = paths(rt);
  const present = runtimesPresent(rt);
  const name = commandName(command);
  const pathDirs = [present.node ? p.nodeBinDir : undefined, present.uv ? rt.uvDir : undefined].filter((d): d is string => !!d);
  let out: LaunchSpec = { command, args, env: withPathFirst(env, pathDirs, p.win) };

  if (present.node && name === "npx") out = { ...out, command: p.nodeBin!, args: [p.npxCli!, ...args] };
  else if (present.node && name === "npm") out = { ...out, command: p.nodeBin!, args: [p.npmCli!, ...args] };
  else if (present.node && name === "node") out = { ...out, command: p.nodeBin! };
  else if (present.uv && name === "uvx") out = { ...out, command: p.uvx! };
  else if (present.uv && name === "uv") out = { ...out, command: p.uv! };

  if (present.uv && (name === "uvx" || name === "uv")) {
    // Use uv's own Python where possible, so a missing or odd system Python doesn't matter.
    out.env = { UV_PYTHON_PREFERENCE: "managed", ...out.env };
  }
  return out;
}
