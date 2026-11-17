// AI apps Ringkeeper only reads from: it brings their connections in, and never
// writes to their files. Paths and shapes checked against each app's docs on
// 2026-11-17 (docs/proposal-tools-and-apps.md, section 4); several are marked
// unverified there, so every candidate path is tried and a file that can't be
// read is reported with a plain reason, never skipped silently.
import fs from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import type { ServerMap } from "./config-file-types.js";
import { HOST_LABELS, vscodeUserDir, type HostId, type Roots } from "./hosts.js";

export type ReadOnlyId =
  | "vscode-legacy"
  | "visual-studio"
  | "windsurf"
  | "windsurf-next"
  | "devin"
  | "gemini-cli"
  | "cline"
  | "roo-code"
  | "warp"
  | "lm-studio"
  | "junie"
  | "zed"
  | "continue"
  | "amazon-q";

/** Any app a connection can come from. */
export type SourceId = HostId | ReadOnlyId;

export const SOURCE_LABELS: Record<SourceId, string> = {
  ...HOST_LABELS,
  "vscode-legacy": "VS Code (older settings)",
  "visual-studio": "Visual Studio",
  windsurf: "Windsurf",
  "windsurf-next": "Windsurf Next",
  devin: "Devin Desktop",
  "gemini-cli": "Gemini CLI",
  cline: "Cline",
  "roo-code": "Roo Code",
  warp: "Warp",
  "lm-studio": "LM Studio",
  junie: "Junie",
  zed: "Zed",
  continue: "Continue",
  "amazon-q": "Amazon Q",
};

/** How an app writes variables in its connection settings. */
export type VariableSyntax = "cursor" | "shell" | "continue" | "none";

export const VARIABLE_SYNTAX: Record<SourceId, VariableSyntax> = {
  "claude-desktop": "none",
  cursor: "cursor",
  "claude-code": "shell",
  vscode: "shell",
  kiro: "shell",
  antigravity: "none",
  // Codex has no variables in the file; its env-var references are turned into ${env:NAME} when read.
  codex: "cursor",
  "vscode-legacy": "cursor",
  "visual-studio": "cursor",
  windsurf: "cursor",
  "windsurf-next": "cursor",
  devin: "cursor",
  "gemini-cli": "shell",
  cline: "cursor",
  "roo-code": "cursor",
  warp: "none",
  "lm-studio": "none",
  junie: "none",
  zed: "none",
  continue: "continue",
  "amazon-q": "none",
};

type FileFormat = { kind: "json"; key: string } | { kind: "yaml"; key: string };

interface ReadOnlySource {
  id: ReadOnlyId;
  files: Array<{ path: string; format: FileFormat }>;
}

const json = (key = "mcpServers"): FileFormat => ({ kind: "json", key });

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function listDir(dir: string, ext: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => ext.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export function locateReadOnly(r: Roots): ReadOnlySource[] {
  const win = r.platform === "win32";
  const roaming = r.appData ?? join(r.home, "AppData", "Roaming");
  const xdg = join(r.home, ".config");
  const codeUser = vscodeUserDir(r);
  const cursorUser = vscodeUserDir(r, "Cursor");
  const windsurfUser = vscodeUserDir(r, "Windsurf");
  const editorStorage = (ext: string, file: string) =>
    [codeUser, cursorUser, windsurfUser].map((u) => ({ path: join(u, "globalStorage", ext, "settings", file), format: json() }));
  const continueDir = join(r.home, ".continue");

  const sources: ReadOnlySource[] = [
    { id: "vscode-legacy", files: [{ path: join(codeUser, "mcp.json"), format: json("servers") }] },
    ...(win ? [{ id: "visual-studio" as const, files: [{ path: join(r.home, ".mcp.json"), format: json("servers") }] }] : []),
    { id: "windsurf", files: [{ path: join(r.home, ".codeium", "windsurf", "mcp_config.json"), format: json() }] },
    { id: "windsurf-next", files: [{ path: join(r.home, ".codeium", "windsurf-next", "mcp_config.json"), format: json() }] },
    { id: "devin", files: [{ path: win ? join(roaming, "devin", "mcp_config.json") : join(xdg, "devin", "mcp_config.json"), format: json() }] },
    { id: "gemini-cli", files: [{ path: join(r.home, ".gemini", "settings.json"), format: json() }] },
    {
      id: "cline",
      files: [
        { path: join(r.home, ".cline", "data", "settings", "cline_mcp_settings.json"), format: json() },
        ...editorStorage("saoudrizwan.claude-dev", "cline_mcp_settings.json"),
        { path: join(r.home, "Documents", "Cline", "MCP", "cline_mcp_settings.json"), format: json() },
      ],
    },
    { id: "roo-code", files: editorStorage("rooveterinaryinc.roo-cline", "mcp_settings.json") },
    { id: "warp", files: [{ path: join(r.home, ".warp", ".mcp.json"), format: json() }] },
    {
      id: "lm-studio",
      files: [
        { path: join(r.home, ".lmstudio", "mcp.json"), format: json() },
        { path: join(r.home, ".cache", "lm-studio", "mcp.json"), format: json() },
      ],
    },
    { id: "junie", files: [{ path: join(r.home, ".junie", "mcp", "mcp.json"), format: json() }] },
    { id: "zed", files: [{ path: win ? join(roaming, "Zed", "settings.json") : join(xdg, "zed", "settings.json"), format: json("context_servers") }] },
    {
      id: "continue",
      files: [
        { path: join(continueDir, "config.yaml"), format: { kind: "yaml", key: "mcpServers" } },
        ...listDir(join(continueDir, "mcpServers"), /\.ya?ml$/i).map((path) => ({ path, format: { kind: "yaml", key: "mcpServers" } as FileFormat })),
        ...listDir(join(continueDir, "mcpServers"), /\.json$/i).map((path) => ({ path, format: json() })),
      ],
    },
    {
      id: "amazon-q",
      files: [
        { path: join(r.home, ".aws", "amazonq", "mcp.json"), format: json() },
        { path: join(r.home, ".aws", "amazonq", "agents", "default.json"), format: json() },
      ],
    },
  ];
  return sources.map((s) => ({ ...s, files: s.files.filter((f) => exists(f.path)) })).filter((s) => s.files.length > 0);
}

export type FileRead = { status: "ok"; servers: ServerMap } | { status: "unreadable"; reason: string };

/** One read-only file's connections, as a map by name (Continue's list included). */
export function readSourceFile(path: string, format: FileFormat): FileRead {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8").replace(/^﻿/, "");
  } catch {
    return { status: "unreadable", reason: "Ringkeeper Connect isn't allowed to open it" };
  }
  if (text.trim() === "") return { status: "ok", servers: {} };
  let root: unknown;
  if (format.kind === "json") {
    const errors: ParseError[] = [];
    root = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length) return { status: "unreadable", reason: `it isn't valid (${printParseErrorCode(errors[0]!.error)} at character ${errors[0]!.offset})` };
  } else {
    try {
      root = parseYaml(text);
    } catch (err) {
      const line = (err as { linePos?: Array<{ line: number }> }).linePos?.[0]?.line;
      return { status: "unreadable", reason: line ? `it isn't valid (line ${line})` : "it isn't valid" };
    }
  }
  if (root === null || root === undefined) return { status: "ok", servers: {} };
  if (typeof root !== "object" || Array.isArray(root)) return { status: "unreadable", reason: "it doesn't contain settings in the expected shape" };
  const list = (root as Record<string, unknown>)[format.key];
  if (list === undefined || list === null) return { status: "ok", servers: {} };
  if (Array.isArray(list)) {
    // Continue: a list of { name, ... }.
    const servers: ServerMap = {};
    for (const item of list) {
      if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
        const { name, ...rest } = item as { name: string };
        servers[name] = rest;
      }
    }
    return { status: "ok", servers };
  }
  if (typeof list !== "object") return { status: "unreadable", reason: "its list of connections isn't in the expected shape" };
  return { status: "ok", servers: list as ServerMap };
}

export interface SourceSeen {
  id: SourceId;
  label: string;
  /** Connections found (Ringkeeper's own entry left out). */
  count: number;
  /** Files that couldn't be read, each with a plain reason. */
  problems: string[];
}

export interface ReadOnlyScan {
  found: Array<{ host: ReadOnlyId; name: string; value: unknown }>;
  seen: SourceSeen[];
}

export function scanReadOnly(r: Roots, ourEntry: string): ReadOnlyScan {
  const found: ReadOnlyScan["found"] = [];
  const seen: SourceSeen[] = [];
  for (const src of locateReadOnly(r)) {
    const label = SOURCE_LABELS[src.id];
    let count = 0;
    const problems: string[] = [];
    for (const f of src.files) {
      const res = readSourceFile(f.path, f.format);
      if (res.status === "unreadable") {
        problems.push(`Couldn't read ${label}'s settings (${f.path}): ${res.reason}.`);
        continue;
      }
      for (const [name, value] of Object.entries(res.servers)) {
        if (name === ourEntry) continue;
        found.push({ host: src.id, name, value });
        count++;
      }
    }
    seen.push({ id: src.id, label, count, problems });
  }
  return { found, seen };
}
