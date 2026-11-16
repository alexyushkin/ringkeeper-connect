// The e2e tests run the real bundles (bridge, gateway, fixture), so build them first.
import { execFileSync } from "node:child_process";

export default function setup() {
  execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
}
