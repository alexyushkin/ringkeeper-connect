// "Copy details for support" on a tool: what someone helping needs to see (the version, the tool,
// its status, and its last few log lines), with keys, tokens and the client's name taken out.
// The person sees all of it before copying or sending it.
import fs from "node:fs";

/** How many of a tool's log lines go in, newest last. */
export const SUPPORT_LOG_LINES = 15;
/** Only the end of the log is read: recent lines are what matter, and the file can be large. */
const READ_TAIL_BYTES = 1024 * 1024;

export interface LogLine {
  t: string;
  ev: string;
  text?: string;
}

/** The last lines the log has for one tool of one client (or of the tools for every client). */
export function toolLogLines(logPath: string, clientId: string, connectionId: string, max = SUPPORT_LOG_LINES): LogLine[] {
  let text: string;
  try {
    const size = fs.statSync(logPath).size;
    const fd = fs.openSync(logPath, "r");
    try {
      const start = Math.max(0, size - READ_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: LogLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // the first line read may be cut off
    }
    if (e.client !== clientId || e.conn !== connectionId) continue;
    const detail = [e.error, e.text, typeof e.tools === "number" ? `${e.tools} actions` : undefined].find((x) => typeof x === "string" && x) as string | undefined;
    out.push({ t: String(e.t ?? ""), ev: String(e.ev ?? ""), ...(detail ? { text: detail } : {}) });
  }
  return out.slice(-max);
}

/**
 * Take out anything that could be a key: the tool's own saved values, anything after "Bearer" or
 * "key="/"token=", and long runs of letters and digits; and the client's name.
 */
export function scrub(text: string, secrets: string[], clientName: string): string {
  let out = text;
  for (const s of [...secrets].filter((x) => x.length >= 6).sort((a, b) => b.length - a.length)) out = out.split(s).join("•••");
  out = out.replace(/\b(Bearer|Basic|Token)\s+[^\s"',;]+/gi, "$1 •••");
  out = out.replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|key|sig|code)=)[^&\s"']+/gi, "$1•••");
  out = out.replace(/[A-Za-z0-9_\-+/=.]{32,}/g, "•••");
  if (clientName.trim().length >= 2) out = out.split(clientName).join("[client]");
  return out;
}

export interface SupportInput {
  version: string;
  system: string;
  clientName: string;
  tool: { name: string; service?: string; how: string; status: string; keys: string; signIn?: string };
  lines: LogLine[];
  secrets: string[];
}

/** The text shown, copied or emailed. Everything in it goes through scrub(). */
export function supportDetails(input: SupportInput): string {
  const t = input.tool;
  const head = [
    `Ringkeeper Connect ${input.version} on ${input.system}`,
    `Tool: ${t.name}${t.service && t.service !== t.name ? ` (${t.service})` : ""}`,
    `Connects: ${t.how}`,
    `Status: ${t.status}`,
    `Keys: ${t.keys}`,
    ...(t.signIn ? [`Sign-in: ${t.signIn}`] : []),
    "",
    input.lines.length ? `Last ${input.lines.length} log lines for this tool (oldest first):` : "The log has nothing for this tool yet.",
    ...input.lines.map((l) => `${l.t} ${l.ev}${l.text ? `: ${l.text.replace(/\s+/g, " ").slice(0, 400)}` : ""}`),
  ];
  return scrub(head.join("\n"), input.secrets, input.clientName);
}
