// Edits of Codex's config.toml that keep everything else exactly as written:
// comments, blank lines, key order and quoting. We only ever add or remove
// whole [mcp_servers.<name>] tables (with their sub-tables, like
// [mcp_servers.<name>.env]); the rest of the file is never re-serialised. The
// result is always parsed again and compared before anything is saved (see
// config-file.ts), so an edit this code gets wrong is refused, not written.
import { parse, stringify, TomlError } from "smol-toml";
import { HostConfigError, type Change, type ServerMap } from "./config-file-types.js";

export const TOML_KEY = "mcp_servers";

export type TomlParse = { ok: true; root: Record<string, unknown>; servers: ServerMap } | { ok: false; reason: string };

/** The parser makes prototype-less objects; turn them into ordinary ones so comparisons work. */
function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = plain(x);
    return out;
  }
  return v;
}

export function parseToml(text: string): TomlParse {
  let root: Record<string, unknown>;
  try {
    root = plain(parse(text.replace(/^﻿/, ""))) as Record<string, unknown>;
  } catch (err) {
    const line = err instanceof TomlError ? err.line : undefined;
    return { ok: false, reason: line ? `it isn't valid (line ${line})` : "it isn't valid" };
  }
  const servers = root[TOML_KEY];
  if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) {
    return { ok: false, reason: "its list of connections isn't in the expected shape" };
  }
  return { ok: true, root, servers: (servers ?? {}) as ServerMap };
}

/** Split a dotted TOML key ("a.\"b c\".d") into its parts; null if it isn't one. */
export function splitKey(raw: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  const s = raw.trim();
  while (i < s.length) {
    while (s[i] === " " || s[i] === "\t") i++;
    if (s[i] === '"') {
      let out = "";
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\") {
          const n = s[i + 1];
          const simple: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
          if (n && simple[n] !== undefined) {
            out += simple[n];
            i += 2;
            continue;
          }
          if (n === "u" || n === "U") {
            const len = n === "u" ? 4 : 8;
            const hex = s.slice(i + 2, i + 2 + len);
            if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return null;
            out += String.fromCodePoint(parseInt(hex, 16));
            i += 2 + len;
            continue;
          }
          return null;
        }
        out += s[i++];
      }
      if (s[i] !== '"') return null;
      i++;
      parts.push(out);
    } else if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      parts.push(s.slice(i + 1, end));
      i = end + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    while (s[i] === " " || s[i] === "\t") i++;
    if (i >= s.length) break;
    if (s[i] !== ".") return null;
    i++;
  }
  return parts.length ? parts : null;
}

interface Line {
  text: string;
  /** Header of a table ([a.b]) or an array of tables ([[a.b]]), outside multi-line strings. */
  header?: { path: string[] | null; array: boolean };
}

function lines(body: string): Line[] {
  const out: Line[] = [];
  let inMultiline: '"""' | "'''" | null = null;
  for (const text of body.split("\n")) {
    const line: Line = { text };
    if (!inMultiline) {
      const m = /^[ \t]*(\[\[?)([^\]#]*?)(\]\]?)[ \t]*(#.*)?\r?$/.exec(text);
      if (m && m[1]!.length === m[3]!.length) line.header = { path: splitKey(m[2]!), array: m[1] === "[[" };
    }
    // Track multi-line strings, so a "[...]" line inside one isn't taken for a header.
    for (const q of ['"""', "'''"] as const) {
      const count = text.split(q).length - 1;
      if (count % 2 === 1) {
        if (!inMultiline) inMultiline = q;
        else if (inMultiline === q) inMultiline = null;
      }
    }
    out.push(line);
  }
  return out;
}

const blankOrComment = (l: Line) => /^[ \t]*(#.*)?\r?$/.test(l.text);

/**
 * Line ranges [start, end) of every table belonging to one server: its own
 * [mcp_servers.<name>] and any [mcp_servers.<name>.<...>] sub-table. Blank and
 * comment lines at the end of a range belong to whatever follows, so they stay.
 */
function serverRanges(ls: Line[], name: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < ls.length; i++) {
    const h = ls[i]!.header;
    if (!h || !h.path || h.path[0] !== TOML_KEY || h.path[1] !== name) continue;
    let end = i + 1;
    while (end < ls.length && !ls[end]!.header) end++;
    while (end > i + 1 && blankOrComment(ls[end - 1]!)) end--;
    ranges.push([i, end]);
  }
  return ranges;
}

/** The server's table (and sub-tables) as lines. */
function render(name: string, value: unknown): string[] {
  return stringify({ [TOML_KEY]: { [name]: value } })
    .replace(/\n+$/, "")
    .split("\n");
}

/** Apply changes to the text of a TOML config file, touching only whole [mcp_servers.<name>] tables. */
export function applyTomlChanges(text: string, changes: Change[]): string {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  let body = bom ? text.slice(1) : text;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  // Work on "\n" lines; put the file's own line endings back at the end.
  body = body.replace(/\r\n/g, "\n");
  const before = parseToml(body);
  if (!before.ok) throw new HostConfigError(`Ringkeeper Connect left this file alone because ${before.reason}.`);
  if (/^[ \t]*mcp_servers[ \t]*=/m.test(body) || /^[ \t]*mcp_servers[ \t]*\.[^=\n]*=/m.test(body)) {
    throw new HostConfigError("Its connections are written in a compact form Ringkeeper Connect can't change safely, so nothing was changed.");
  }

  let ls = lines(body);
  for (const c of changes) {
    const ranges = serverRanges(ls, c.name);
    const defined = Object.prototype.hasOwnProperty.call((parseToml(ls.map((l) => l.text).join("\n")) as { servers?: ServerMap }).servers ?? {}, c.name);
    if (defined && ranges.length === 0) {
      throw new HostConfigError(`"${c.name}" is written in a form Ringkeeper Connect can't change safely, so nothing was changed.`);
    }
    // Remove the server's tables, bottom up so earlier ranges stay valid.
    let insertAt: number | null = ranges.length ? ranges[0]![0] : null;
    for (const [start, end] of [...ranges].reverse()) {
      let e = end;
      // Swallow one blank line after the removed table, so no gap is left behind
      // (when the line before it is blank, a comment, or the start of the file).
      if (e < ls.length && /^[ \t]*$/.test(ls[e]!.text) && (start === 0 || blankOrComment(ls[start - 1]!))) e++;
      ls = [...ls.slice(0, start), ...ls.slice(e)];
      if (insertAt !== null && start < insertAt) insertAt = start;
    }
    if (c.op === "remove") continue;

    const block = render(c.name, c.value).map((t) => ({ text: t }) as Line);
    if (insertAt === null) {
      // Append at the end, after one blank line.
      while (ls.length && /^[ \t]*$/.test(ls[ls.length - 1]!.text)) ls.pop();
      ls = ls.length ? [...ls, { text: "" }, ...block, { text: "" }] : [...block, { text: "" }];
    } else {
      const needsGapAfter = insertAt < ls.length && !/^[ \t]*$/.test(ls[insertAt]!.text);
      ls = [...ls.slice(0, insertAt), ...block, ...(needsGapAfter ? [{ text: "" }] : []), ...ls.slice(insertAt)];
    }
    ls = lines(ls.map((l) => l.text).join("\n"));
  }
  let out = ls.map((l) => l.text).join("\n");
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  return bom + out;
}
