// Builds the desktop app into apps/desktop/dist:
//   main.cjs, preload.cjs  (esbuild, CommonJS for Electron)
//   renderer/              (Vite + React)
//   bridge.mjs             (the stdio shim AI apps launch; M3 points host configs at it)
import { build } from "esbuild";
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import { resolve } from "node:path";

const root = resolve("apps/desktop");
const out = resolve(root, "dist");
fs.rmSync(out, { recursive: true, force: true });

// Prefer ES module builds: some packages (jsonc-parser) ship a UMD "main" that loads files at runtime, which a bundle can't follow.
const common = { bundle: true, platform: "node", target: "node22", format: "cjs", sourcemap: true, logLevel: "info", mainFields: ["module", "main"] };

await build({ ...common, entryPoints: { main: resolve(root, "src/main/main.ts") }, outdir: out, outExtension: { ".js": ".cjs" }, external: ["electron"] });
await build({ ...common, entryPoints: { preload: resolve(root, "src/main/preload.ts") }, outdir: out, outExtension: { ".js": ".cjs" }, external: ["electron"] });
await build({
  ...common,
  format: "esm",
  entryPoints: { bridge: resolve("packages/bridge/src/main.ts") },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  banner: { js: "import { createRequire as __rkCreateRequire } from 'node:module'; const require = __rkCreateRequire(import.meta.url);" },
});

await viteBuild({
  root: resolve(root, "src/renderer"),
  base: "./",
  plugins: [react()],
  logLevel: "warn",
  build: { outDir: resolve(out, "renderer"), emptyOutDir: true, sourcemap: true },
});
console.log(`desktop built → ${out}`);
