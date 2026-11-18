// When Claude Desktop and Cursor were last started, so Ringkeeper can tell
// "added, restart to finish" (not restarted yet) from "not seeing us yet"
// (restarted, but still no contact). Checked in the background, never blocking.
// Claude Code is a command-line tool started per session, so it isn't tracked.
import { execFile } from "node:child_process";

export type StartTimes = Partial<Record<"claude-desktop" | "cursor", number>>;

/** Claude Desktop's own program, not the Claude Code CLI (also called claude.exe on Windows). */
export function isClaudeDesktopPath(path: string): boolean {
  if (/claude-code|[\\/]\.local[\\/]bin[\\/]|node_modules|[\\/]npm[\\/]/i.test(path)) return false;
  return (
    /[\\/]WindowsApps[\\/](Anthropic(PBC)?\.)?Claude_[^\\/]*[\\/]/i.test(path) ||
    /[\\/]AnthropicClaude[\\/]/i.test(path) ||
    /[\\/]Programs[\\/]Claude[\\/]/i.test(path) ||
    /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(path)
  );
}

export function isCursorPath(path: string): boolean {
  return /[\\/]cursor\.exe$/i.test(path) || /\/Cursor\.app\/Contents\/MacOS\/Cursor$/.test(path);
}

/** The earliest start among an app's processes is its main process. */
function collect(rows: Array<{ path: string; start: number }>): StartTimes {
  const out: StartTimes = {};
  for (const r of rows) {
    if (!Number.isFinite(r.start)) continue;
    const app = isClaudeDesktopPath(r.path) ? "claude-desktop" : isCursorPath(r.path) ? "cursor" : undefined;
    if (app && (out[app] === undefined || r.start < out[app]!)) out[app] = r.start;
  }
  return out;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) =>
    execFile(cmd, args, { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout)),
  );
}

export async function appStartTimes(platform: NodeJS.Platform = process.platform): Promise<StartTimes> {
  if (platform === "win32") {
    const ps =
      "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' OR Name='Cursor.exe'\" | " +
      "Select-Object ExecutablePath,@{n='Start';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    if (!out.trim()) return {};
    try {
      const parsed = JSON.parse(out) as { ExecutablePath?: string; Start?: string } | Array<{ ExecutablePath?: string; Start?: string }>;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return collect(list.map((p) => ({ path: p.ExecutablePath ?? "", start: Date.parse(p.Start ?? "") })));
    } catch {
      return {};
    }
  }
  if (platform === "darwin") {
    const out = await run("ps", ["-axo", "lstart=,comm="]);
    const rows = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        // "Mon Nov 17 10:00:00 2026 /Applications/Claude.app/Contents/MacOS/Claude"
        const m = l.match(/^(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
        return m ? { start: Date.parse(m[1]!), path: m[2]! } : { start: NaN, path: "" };
      });
    return collect(rows);
  }
  return {};
}

/** Keeps a recent copy so status checks never wait on the operating system. */
export class AppStartWatcher {
  private latest: StartTimes = {};
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly onChange: () => void) {}

  get times(): StartTimes {
    return this.latest;
  }

  private everyMs = 20_000;

  start(everyMs = 20_000): void {
    this.everyMs = everyMs;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), everyMs);
    this.timer.unref();
  }

  /** Look more or less often from now on (only while started). */
  setPace(everyMs: number): void {
    if (!this.timer || everyMs === this.everyMs) return;
    clearInterval(this.timer);
    this.everyMs = everyMs;
    this.timer = setInterval(() => void this.refresh(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const next = await appStartTimes();
      if (JSON.stringify(next) !== JSON.stringify(this.latest)) {
        this.latest = next;
        this.onChange();
      }
    } finally {
      this.busy = false;
    }
  }
}
