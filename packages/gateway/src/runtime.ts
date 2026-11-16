// Shared between the gateway and the bridge: where the app keeps its files,
// the per-install port and token, and the runtime file that tells the bridge
// where the running gateway is.
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";

export const APP_DIR_NAME = "Ringkeeper Connect";

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RINGKEEPER_DATA_DIR) return env.RINGKEEPER_DATA_DIR;
  if (process.platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_DIR_NAME);
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP_DIR_NAME);
}

export function dataFiles(dataDir: string) {
  return {
    install: join(dataDir, "install.json"),
    runtime: join(dataDir, "runtime.json"),
    clients: join(dataDir, "clients.json"),
    state: join(dataDir, "state.json"),
    log: join(dataDir, "gateway.log"),
  };
}

/** Picked once per install and kept, so direct-HTTP host configs stay valid. */
export interface InstallSettings {
  port: number;
  token: string;
}

/** Written by the running gateway; the port may differ from the install port if that was taken. */
export interface RuntimeInfo {
  version: 1;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

// Stay below the Windows/macOS dynamic range (49152+), which Hyper-V and
// Docker often reserve on Windows.
const PORT_MIN = 20000;
const PORT_MAX = 45000;

export function pickInstallPort(): number {
  return randomInt(PORT_MIN, PORT_MAX);
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write to a temp file next to the target, then rename over it. */
export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.renameSync(tmp, path);
}

export function loadOrCreateInstallSettings(dataDir: string): InstallSettings {
  const file = dataFiles(dataDir).install;
  const existing = readJson<Partial<InstallSettings>>(file);
  if (existing && typeof existing.port === "number" && typeof existing.token === "string") {
    return { port: existing.port, token: existing.token };
  }
  const created = { port: pickInstallPort(), token: newToken() };
  writeJsonAtomic(file, created);
  return created;
}

export function readRuntimeInfo(dataDir: string): RuntimeInfo | null {
  const info = readJson<RuntimeInfo>(dataFiles(dataDir).runtime);
  if (!info || info.version !== 1 || typeof info.port !== "number" || typeof info.token !== "string") {
    return null;
  }
  return info;
}

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** True if a Ringkeeper gateway answers on this port. */
export async function isGatewayAlive(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { app?: string };
    return body.app === "ringkeeper-connect";
  } catch {
    return false;
  }
}
