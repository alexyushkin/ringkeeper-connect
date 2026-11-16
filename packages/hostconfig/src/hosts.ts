// Where each AI app keeps its connection settings (verified for M3 on
// 2026-11-16 against the apps' docs and a real Windows machine):
//
// - Claude Desktop: %APPDATA%\Claude\claude_desktop_config.json, or the Windows
//   Store (MSIX) copy under %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\
//   which the app reads instead when it exists; macOS ~/Library/Application
//   Support/Claude/. Also holds `preferences` and other keys we must not touch.
// - Cursor: ~/.cursor/mcp.json (user level). Expands ${env:NAME} and ${userHome}.
// - Claude Code: ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json), user-level
//   servers in the top-level `mcpServers`. Per-project servers under `projects`
//   and .mcp.json files are out of scope for v1. Expands ${VAR} and ${VAR:-default}.
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Claude Desktop: prefer the Windows Store copy when the app has one, because that's the file it reads. */
function claudeDesktopPath(r: Roots): { path: string; installed: boolean } {
  if (r.platform === "win32") {
    const normal = join(r.appData ?? join(r.home, "AppData", "Roaming"), "Claude");
    const packages = join(r.localAppData ?? join(r.home, "AppData", "Local"), "Packages");
    let storeDirs: string[] = [];
    try {
      storeDirs = fs.readdirSync(packages).filter((d) => /^(Anthropic\.)?Claude_/i.test(d));
    } catch {
      // No Packages folder.
    }
    for (const d of storeDirs) {
      const virtual = join(packages, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json");
      if (exists(virtual)) return { path: virtual, installed: true };
    }
    return { path: join(normal, "claude_desktop_config.json"), installed: exists(normal) || storeDirs.length > 0 };
  }
  const dir = join(r.home, "Library", "Application Support", "Claude");
  return { path: join(dir, "claude_desktop_config.json"), installed: exists(dir) };
}

export function locateHosts(r: Roots): HostLocation[] {
  const desktop = claudeDesktopPath(r);
  const cursorDir = join(r.home, ".cursor");
  const claudeCodeFile = r.claudeConfigDir ? join(r.claudeConfigDir, ".claude.json") : join(r.home, ".claude.json");
  const claudeCodeDir = r.claudeConfigDir ?? join(r.home, ".claude");

  const list: Array<Omit<HostLocation, "exists" | "label">> = [
    { id: "claude-desktop", configPath: desktop.path, installed: desktop.installed, entryStyle: "plain" },
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
