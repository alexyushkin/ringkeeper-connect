// Where each AI app keeps its connection settings.
//
// Claude Desktop (verified 2026-11-17; see docs/m6-results.md):
//   Windows, newest builds: %LOCALAPPDATA%\Claude-Data\<install id>\claude_desktop_config.json
//     (seen on a real install: Claude-Data\claude_pzs8sxrjxfjjc; the folder name is
//     an install/package id, so we look for any folder there)
//   Windows Store (MSIX), older builds: %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\
//   Windows classic: %APPDATA%\Claude\
//   "3P" variant (own AI provider): %LOCALAPPDATA%\Claude-3p\ (earlier %APPDATA%\Claude-3p\)
//   macOS: ~/Library/Application Support/Claude/ (3P variant: .../Claude-3p/).
//     No Claude-Data layout is documented on macOS.
//   The file also holds `preferences` and other keys we must not touch.
// Cursor: ~/.cursor/mcp.json (user level). Expands ${env:NAME} and ${userHome}.
// Claude Code: ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json), user-level
//   servers in the top-level `mcpServers`. Per-project servers under `projects`
//   and .mcp.json files are out of scope for v1. Expands ${VAR} and ${VAR:-default}.
import fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type HostId = "claude-desktop" | "cursor" | "claude-code";

export const HOST_LABELS: Record<HostId, string> = {
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  "claude-code": "Claude Code",
};

/** The folders hosts live under; injectable so tests never touch the real ones. */
export interface Roots {
  platform: NodeJS.Platform;
  home: string;
  /** Windows %APPDATA% */
  appData?: string;
  /** Windows %LOCALAPPDATA% */
  localAppData?: string;
  claudeConfigDir?: string;
}

export function systemRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): Roots {
  return {
    platform: process.platform,
    home,
    appData: env.APPDATA,
    localAppData: env.LOCALAPPDATA,
    claudeConfigDir: env.CLAUDE_CONFIG_DIR,
  };
}

export interface HostLocation {
  id: HostId;
  label: string;
  /** The file we read and edit. */
  configPath: string;
  /** The app looks installed (its folder exists), even if the file doesn't yet. */
  installed: boolean;
  /** The file exists. */
  exists: boolean;
  /** Format quirks for the entry we add. */
  entryStyle: "plain" | "typed";
  /** Plain-language note about which file was chosen, when there was a choice. */
  note?: string;
}

const CONFIG = "claude_desktop_config.json";

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}

interface DesktopChoice {
  path: string;
  installed: boolean;
  note?: string;
}

/**
 * Which claude_desktop_config.json Claude Desktop reads on this computer.
 *
 * Windows order: a Claude-Data folder that has the file (newest first) →
 * the Store copy → the classic %APPDATA% file → the 3P variant. A Claude-Data
 * folder without the file still wins when there's no classic file, because
 * newer builds create it there.
 */
function claudeDesktopPath(r: Roots): DesktopChoice {
  if (r.platform !== "win32") {
    const support = join(r.home, "Library", "Application Support");
    const standard = join(support, "Claude");
    const thirdParty = join(support, "Claude-3p");
    if (exists(standard) || !exists(thirdParty)) return { path: join(standard, CONFIG), installed: exists(standard) };
    return { path: join(thirdParty, CONFIG), installed: true, note: "Using the settings of Claude Desktop's 3P edition." };
  }

  const local = r.localAppData ?? join(r.home, "AppData", "Local");
  const roaming = r.appData ?? join(r.home, "AppData", "Roaming");

  // 1. Newest builds: %LOCALAPPDATA%\Claude-Data\<install id>\
  const dataDirs = subdirs(join(local, "Claude-Data"));
  const withFile = dataDirs
    .map((d) => join(d, CONFIG))
    .filter(exists)
    .sort((a, b) => mtime(b) - mtime(a));
  if (withFile.length) {
    const chosen = withFile[0]!;
    const note =
      withFile.length > 1
        ? `Claude Desktop has settings in ${withFile.length} places; using the most recently changed one (${basename(dirname(chosen))}).`
        : undefined;
    return { path: chosen, installed: true, note };
  }

  // 2. Store (MSIX) builds that keep a private copy.
  const packages = join(local, "Packages");
  let storeDirs: string[] = [];
  try {
    storeDirs = fs.readdirSync(packages).filter((d) => /^(Anthropic(PBC)?\.)?Claude_/i.test(d));
  } catch {
    // No Packages folder.
  }
  for (const d of storeDirs) {
    const virtual = join(packages, d, "LocalCache", "Roaming", "Claude", CONFIG);
    if (exists(virtual)) return { path: virtual, installed: true };
  }

  // 3. Classic install.
  const classicDir = join(roaming, "Claude");
  const classic = join(classicDir, CONFIG);
  if (exists(classic)) return { path: classic, installed: true };

  // A Claude-Data folder without the file yet: newer builds read it from there.
  if (dataDirs.length) {
    const newest = [...dataDirs].sort((a, b) => mtime(b) - mtime(a))[0]!;
    return { path: join(newest, CONFIG), installed: true };
  }

  // 4. The 3P variant (only when nothing standard is present).
  for (const dir of [join(local, "Claude-3p"), join(roaming, "Claude-3p")]) {
    if (exists(dir) && !exists(classicDir)) {
      return { path: join(dir, CONFIG), installed: true, note: "Using the settings of Claude Desktop's 3P edition." };
    }
  }

  return { path: classic, installed: exists(classicDir) || storeDirs.length > 0 };
}

export function locateHosts(r: Roots): HostLocation[] {
  const desktop = claudeDesktopPath(r);
  const cursorDir = join(r.home, ".cursor");
  const claudeCodeFile = r.claudeConfigDir ? join(r.claudeConfigDir, ".claude.json") : join(r.home, ".claude.json");
  const claudeCodeDir = r.claudeConfigDir ?? join(r.home, ".claude");

  const list: Array<Omit<HostLocation, "exists" | "label">> = [
    {
      id: "claude-desktop",
      configPath: desktop.path,
      installed: desktop.installed,
      entryStyle: "plain",
      ...(desktop.note ? { note: desktop.note } : {}),
    },
    { id: "cursor", configPath: join(cursorDir, "mcp.json"), installed: exists(cursorDir), entryStyle: "typed" },
    {
      id: "claude-code",
      configPath: claudeCodeFile,
      installed: exists(claudeCodeFile) || exists(claudeCodeDir),
      entryStyle: "typed",
    },
  ];
  return list.map((h) => ({ ...h, label: HOST_LABELS[h.id], exists: exists(h.configPath) }));
}
