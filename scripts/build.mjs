// Bundles each runnable piece into one self-contained .mjs in dist/, so it
// runs on a plain (bundled) Node with no node_modules next to it.
import { build } from "esbuild";

const entries = {
  gateway: "packages/gateway/src/main.ts",
  bridge: "packages/bridge/src/main.ts",
  tools: "packages/tools/src/main.ts",
  "fixture-server": "spike/fixture-server.ts",
  "spike-tools": "spike/tools.ts",
  "fake-vendor": "spike/fake-vendor.ts",
};

await build({
  entryPoints: entries,
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  // Some dependencies still call require(); give ESM bundles one.
  banner: { js: "import { createRequire as __rkCreateRequire } from 'node:module'; const require = __rkCreateRequire(import.meta.url);" },
});
