import { runBridge } from "./bridge.js";

runBridge().catch((err) => {
  process.stderr.write(`[ringkeeper-bridge] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
