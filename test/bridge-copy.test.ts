// AI apps run the bridge from a copy outside the install folder, so an update
// (which stops everything running from the install folder) doesn't stop it.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeHome, ensureBridgeCopy } from "../apps/desktop/src/main/bridge-copy.js";
import { bridgeLaunch } from "../apps/desktop/src/main/apps.js";

const made: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(join(tmpdir(), "rk-bridge-copy-"));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const win = process.platform === "win32";
const nodeName = win ? "node.exe" : "node";

/** An install folder with a (fake) Node and bridge script. */
function install(nodeText = "node v1", bridgeText = "bridge v1") {
  const root = tempDir();
  const nodeDir = join(root, "resources", "runtimes", "node");
  const nodePath = win ? join(nodeDir, "node.exe") : join(nodeDir, "bin", "node");
  fs.mkdirSync(join(nodePath, ".."), { recursive: true });
  fs.writeFileSync(nodePath, nodeText);
  const bridge = join(root, "resources", "bridge.mjs");
  fs.writeFileSync(bridge, bridgeText);
  return { root, node: nodePath, nodeDir, bridge, resources: join(root, "resources") };
}

describe("bridge copy", () => {
  it("lives in the per-computer app folder on Windows, in the data folder elsewhere and for test runs", () => {
    expect(bridgeHome({ platform: "win32", dataDir: "C:\\Users\\a\\AppData\\Roaming\\Ringkeeper Connect", localAppData: "C:\\Users\\a\\AppData\\Local", appDirName: "Ringkeeper Connect" })).toBe(
      join("C:\\Users\\a\\AppData\\Local", "Ringkeeper Connect", "bridge"),
    );
    expect(bridgeHome({ platform: "darwin", dataDir: "/Users/a/Library/Application Support/Ringkeeper Connect", appDirName: "Ringkeeper Connect" })).toBe(
      join("/Users/a/Library/Application Support/Ringkeeper Connect", "bridge"),
    );
    expect(bridgeHome({ platform: "win32", dataDir: "x", dataDirOverride: "D:\\test-data", localAppData: "C:\\L", appDirName: "Ringkeeper Connect" })).toBe(join("D:\\test-data", "bridge"));
  });

  it("copies Node and the bridge once, then leaves them alone while nothing changed", () => {
    const src = install();
    const dir = join(tempDir(), "bridge");
    const copy = ensureBridgeCopy({ node: src.node, bridge: src.bridge }, dir);
    expect(copy).toEqual({ node: join(dir, nodeName), bridge: join(dir, "bridge.mjs") });
    expect(fs.readFileSync(copy.node, "utf8")).toBe("node v1");
    expect(fs.readFileSync(copy.bridge, "utf8")).toBe("bridge v1");

    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(copy.node, old, old);
    fs.utimesSync(copy.bridge, old, old);
    ensureBridgeCopy({ node: src.node, bridge: src.bridge }, dir);
    expect(fs.statSync(copy.node).mtimeMs).toBe(old.getTime());
    expect(fs.statSync(copy.bridge).mtimeMs).toBe(old.getTime());
  });

  it("replaces whichever part a new version changed", () => {
    const dir = join(tempDir(), "bridge");
    const v1 = install("node v1", "bridge v1");
    const copy = ensureBridgeCopy({ node: v1.node, bridge: v1.bridge }, dir);

    const v2 = install("node v1", "bridge v2"); // same Node, new bridge
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(copy.node, old, old);
    ensureBridgeCopy({ node: v2.node, bridge: v2.bridge }, dir);
    expect(fs.readFileSync(copy.bridge, "utf8")).toBe("bridge v2");
    expect(fs.statSync(copy.node).mtimeMs).toBe(old.getTime()); // same content: not copied again

    const v3 = install("node v2 (longer)", "bridge v2");
    ensureBridgeCopy({ node: v3.node, bridge: v3.bridge }, dir);
    expect(fs.readFileSync(copy.node, "utf8")).toBe("node v2 (longer)");

    const v4 = install("node v3 (longer)", "bridge v2"); // same size, different content
    ensureBridgeCopy({ node: v4.node, bridge: v4.bridge }, dir);
    expect(fs.readFileSync(copy.node, "utf8")).toBe("node v3 (longer)");
  });

  it.runIf(win)("replaces Node even while an AI app is running the old copy, and removes the old one later", async () => {
    const dir = join(tempDir(), "bridge");
    const real = install();
    fs.copyFileSync(process.execPath, real.node);
    const copy = ensureBridgeCopy({ node: real.node, bridge: real.bridge }, dir);

    // An AI app running the bridge copy.
    const running = spawn(copy.node, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 500));
    try {
      const next = install("a newer node", "bridge v1");
      expect(ensureBridgeCopy({ node: next.node, bridge: next.bridge }, dir)).toEqual(copy);
      expect(fs.readFileSync(copy.node, "utf8")).toBe("a newer node");
      expect(fs.readdirSync(dir).filter((f) => f.includes(".old-"))).toHaveLength(1);
    } finally {
      running.kill();
      await new Promise((r) => running.once("exit", r));
    }
    const again = install("a newer node", "bridge v1");
    ensureBridgeCopy({ node: again.node, bridge: again.bridge }, dir);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".old-"))).toEqual([]);
  });

  it("points AI apps at the copy, and falls back to the install folder if it can't be made", () => {
    const src = install();
    const dir = join(tempDir(), "bridge");
    const opts = { packaged: true, resourcesPath: src.resources, distDir: "unused", runtimes: { nodeDir: src.nodeDir } };
    expect(bridgeLaunch({ ...opts, copyTo: dir })).toEqual({ command: join(dir, nodeName), args: [join(dir, "bridge.mjs")], env: undefined });

    const blocked = join(tempDir(), "a-file");
    fs.writeFileSync(blocked, "not a folder");
    const warnings: string[] = [];
    expect(bridgeLaunch({ ...opts, copyTo: join(blocked, "bridge"), warn: (m) => warnings.push(m) })).toEqual({ command: src.node, args: [src.bridge], env: undefined });
    expect(warnings).toHaveLength(1);
  });
});
