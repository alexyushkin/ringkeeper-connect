import fs from "node:fs";
import { dirname } from "node:path";

export type LogEvent = { ev: string } & Record<string, unknown>;
export type Logger = (e: LogEvent) => void;

/** JSON-lines log. Never pass secrets or tool arguments to it. */
export function fileLogger(path: string, alsoStderr = false): Logger {
  fs.mkdirSync(dirname(path), { recursive: true });
  return (e) => {
    const line = JSON.stringify({ t: new Date().toISOString(), ...e });
    try {
      fs.appendFileSync(path, line + "\n");
    } catch {
      // Logging must never break the gateway.
    }
    if (alsoStderr) process.stderr.write(line + "\n");
  };
}

export const nullLogger: Logger = () => {};
