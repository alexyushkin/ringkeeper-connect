// Safe reads and edits of an AI app's config file. The rules (CLAUDE.md):
// only touch the app's list of connections (`mcpServers` in most apps,
// [mcp_servers.*] in Codex's TOML); keep every other byte; write atomically;
// if the file is unreadable, do nothing and say so; if the app changes the
// file while we work, start over on the new content.
import fs from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { HostConfigError, MCP_JSON, type Change, type ConfigFormat, type ServerMap } from "./config-file-types.js";
import { applyTomlChanges, parseToml } from "./toml-file.js";

export { HostConfigError, MCP_JSON, CODEX_TOML, type Change, type ConfigFormat, type ServerMap } from "./config-file-types.js";

export type ReadResult =
  | { status: "missing" }
  | { status: "unreadable"; reason: string }
  | { status: "ok"; text: string; servers: ServerMap };

const BOM = "﻿";

type Parsed = { ok: true; root: Record<string, unknown>; servers: ServerMap } | { ok: false; reason: string };

function parseConfig(text: string, format: ConfigFormat = MCP_JSON): Parsed {
  return format.kind === "toml" ? parseToml(text) : parseJson(text, format.key);
}

/** The connections in a file's text (empty when it can't be read); tolerant of comments. */
export function serversInText(text: string, format: ConfigFormat = MCP_JSON): ServerMap {
  if (text.trim() === "") return {};
  const p = parseConfig(text, format);
  return p.ok ? p.servers : {};
}

function parseJson(text: string, key: string): Parsed {
  const errors: ParseError[] = [];
  const root = parse(text.startsWith(BOM) ? text.slice(1) : text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0]!;
    return { ok: false, reason: `it isn't valid (${printParseErrorCode(first.error)} at character ${first.offset})` };
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return { ok: false, reason: "it doesn't contain settings in the expected shape" };
  const servers = (root as Record<string, unknown>)[key];
  if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) {
    return { ok: false, reason: "its list of connections isn't in the expected shape" };
  }
  return { ok: true, root: root as Record<string, unknown>, servers: (servers ?? {}) as ServerMap };
}

export function readHostConfig(path: string, format: ConfigFormat = MCP_JSON): ReadResult {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "unreadable", reason: "Ringkeeper Connect isn't allowed to open it" };
  }
  if (text.trim() === "") return { status: "ok", text, servers: {} };
  const parsed = parseConfig(text, format);
  return parsed.ok ? { status: "ok", text, servers: parsed.servers } : { status: "unreadable", reason: parsed.reason };
}

function formatting(text: string) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const m = text.match(/\n([ \t]+)\S/);
  const indent = m?.[1] ?? "  ";
  return { eol, insertSpaces: !indent.startsWith("\t"), tabSize: indent.startsWith("\t") ? 1 : indent.length };
}

/** Apply changes to the text of a config file, touching only its connections. Exported for tests. */
export function applyChanges(text: string, changes: Change[], format: ConfigFormat = MCP_JSON): string {
  if (format.kind === "toml") return applyTomlChanges(text, changes);
  const bom = text.startsWith(BOM) ? BOM : "";
  let body = bom ? text.slice(1) : text;
  if (body.trim() === "") body = "{}\n";
  const fmt = formatting(body);
  for (const c of changes) {
    const edits = modify(body, [format.key, c.name], c.op === "set" ? c.value : undefined, {
      formattingOptions: { insertSpaces: fmt.insertSpaces, tabSize: fmt.tabSize, eol: fmt.eol },
    });
    body = applyEdits(body, edits);
  }
  return bom + body;
}

function expectedServers(before: ServerMap, changes: Change[]): ServerMap {
  const out: ServerMap = { ...before };
  for (const c of changes) {
    if (c.op === "set") out[c.name] = c.value;
    else delete out[c.name];
  }
  return out;
}

/**
 * Never write unless the result parses, the servers are exactly what we
 * meant, and every other setting is unchanged.
 */
function verify(beforeText: string, afterText: string, changes: Change[], format: ConfigFormat): void {
  const before: Parsed = beforeText.trim() === "" ? { ok: true, root: {}, servers: {} } : parseConfig(beforeText, format);
  const after = parseConfig(afterText, format);
  if (!before.ok || !after.ok) throw new HostConfigError("The edited settings didn't come out right, so nothing was saved.");
  if (!isDeepStrictEqual(after.servers, expectedServers(before.servers, changes))) {
    throw new HostConfigError("The edited connections didn't come out as expected, so nothing was saved.");
  }
  const { [format.key]: _a, ...restBefore } = before.root;
  const { [format.key]: _b, ...restAfter } = after.root;
  if (!isDeepStrictEqual(restBefore, restAfter)) {
    throw new HostConfigError("Saving would have changed other settings in this file, so nothing was saved.");
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readTextOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write via a temp file in the same folder, then rename over the target. Retries briefly if the app holds the file. */
export function writeAtomic(path: string, text: string | Uint8Array, mode?: number): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.ringkeeper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: mode ?? 0o600 });
  // Windows can briefly lock a file that was just written (a virus scanner reading it, say).
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 8) {
        sleepSync(50 * (attempt + 1));
        continue;
      }
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

export interface EditResult {
  /** The file's text before our change (null if it didn't exist). */
  before: string | null;
  after: string;
  changed: boolean;
}

/**
 * Edit `mcpServers` in a config file. `plan` sees the current servers and
 * returns the changes; if the file changes underneath us, `plan` runs again on
 * the new content. `onBeforeWrite` runs with the original text right before
 * writing (for backups).
 */
export function editHostConfig(
  path: string,
  plan: (servers: ServerMap) => Change[],
  opts: { createIfMissing?: boolean; onBeforeWrite?: (before: string | null) => void; format?: ConfigFormat } = {},
): EditResult {
  const format = opts.format ?? MCP_JSON;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = readTextOrNull(path);
    if (before === null && !opts.createIfMissing) {
      throw new HostConfigError("The settings file isn't there anymore, so nothing was changed.");
    }
    let servers: ServerMap = {};
    if (before !== null && before.trim() !== "") {
      const parsed = parseConfig(before, format);
      if (!parsed.ok) throw new HostConfigError(`Ringkeeper Connect left this file alone because ${parsed.reason}.`);
      servers = parsed.servers;
    }
    const changes = plan(servers);
    if (!changes.length) return { before, after: before ?? "", changed: false };

    const after = applyChanges(before ?? "", changes, format);
    verify(before ?? "", after, changes, format);

    // The app may have rewritten the file while we worked: start over on its version.
    if (readTextOrNull(path) !== before) continue;
    opts.onBeforeWrite?.(before);
    let mode: number | undefined;
    try {
      mode = fs.statSync(path).mode & 0o777;
    } catch {
      mode = undefined;
    }
    writeAtomic(path, after, mode);
    return { before, after, changed: true };
  }
  throw new HostConfigError("The app kept changing its settings while Ringkeeper Connect was saving. Close it and try again.");
}
