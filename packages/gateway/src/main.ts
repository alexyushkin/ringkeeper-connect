// Standalone gateway process for the M1 spike. In the app (M2+) the Electron
// main process starts the Gateway class directly instead.
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Gateway } from "./gateway.js";
import type { GatewayConfig } from "./config.js";
import { spikeDefaultConfig } from "./spike-config.js";
import { fileLogger } from "./log.js";
import {
  dataFiles,
  isGatewayAlive,
  loadOrCreateInstallSettings,
  readJson,
  readRuntimeInfo,
  resolveDataDir,
  writeJsonAtomic,
  type RuntimeInfo,
} from "./runtime.js";

async function main() {
  const dataDir = resolveDataDir();
  const files = dataFiles(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fileLogger(files.log, process.env.RINGKEEPER_LOG_STDERR === "1");

  const install = loadOrCreateInstallSettings(dataDir);
  const running = readRuntimeInfo(dataDir);
  if (running && (await isGatewayAlive(running.port))) {
    log({ ev: "already_running", port: running.port, pid: running.pid });
    return;
  }

  let config = readJson<GatewayConfig>(files.clients);
  if (!config) {
    const here = dirname(resolve(process.argv[1] ?? "."));
    config = spikeDefaultConfig(join(here, "fixture-server.mjs"));
    writeJsonAtomic(files.clients, config);
  }
  const state = readJson<{ activeClientId?: string }>(files.state) ?? {};

  const gateway = new Gateway({
    config,
    activeClientId: state.activeClientId ?? config.clients[0]?.id ?? "",
    token: install.token,
    port: install.port,
    log,
    onActiveClientChanged: (id) => writeJsonAtomic(files.state, { activeClientId: id }),
  });
  const port = await gateway.start();
  const info: RuntimeInfo = { version: 1, port, token: install.token, pid: process.pid, startedAt: new Date().toISOString() };
  writeJsonAtomic(files.runtime, info);

  const shutdown = async () => {
    log({ ev: "gateway_stopping" });
    const current = readRuntimeInfo(dataDir);
    if (current?.pid === process.pid) fs.rmSync(files.runtime, { force: true });
    await gateway.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Ringkeeper Connect couldn't start: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
