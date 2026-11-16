import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLaunch, runtimesPresent } from "../packages/gateway/src/runtimes.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A fake unpacked runtime folder laid out like the real downloads. */
function fakeRuntimes(platform: NodeJS.Platform) {
  const root = fs.mkdtempSync(join(tmpdir(), "rk-rt-"));
  dirs.push(root);
  const nodeDir = join(root, "node");
  const uvDir = join(root, "uv");
  const win = platform === "win32";
  const touch = (p: string) => {
    fs.mkdirSync(join(p, ".."), { recursive: true });
    fs.writeFileSync(p, "");
  };
  touch(win ? join(nodeDir, "node.exe") : join(nodeDir, "bin", "node"));
  touch(join(nodeDir, win ? "node_modules" : "lib/node_modules", "npm", "bin", "npx-cli.js"));
  touch(join(uvDir, win ? "uvx.exe" : "uvx"));
  touch(join(uvDir, win ? "uv.exe" : "uv"));
  return { nodeDir, uvDir, platform };
}

describe("running connections on the bundled Node and uv", () => {
  it("rewrites npx (in any spelling) to the bundled node + npx, keeping the arguments", () => {
    const rt = fakeRuntimes("win32");
    for (const cmd of ["npx", "npx.cmd", "C:\\Program Files\\nodejs\\npx.CMD"]) {
      const l = resolveLaunch(cmd, ["-y", "n8n-mcp"], { Path: "C:\\Windows" }, rt);
      expect(l.command).toBe(join(rt.nodeDir, "node.exe"));
      expect(l.args).toEqual([join(rt.nodeDir, "node_modules", "npm", "bin", "npx-cli.js"), "-y", "n8n-mcp"]);
    }
  });

  it("puts the bundled folders first on PATH, keeping Windows' own spelling of the name", () => {
    const rt = fakeRuntimes("win32");
    const l = resolveLaunch("npx", [], { Path: "C:\\Windows" }, rt);
    expect(l.env.Path).toBe(`${rt.nodeDir};${rt.uvDir};C:\\Windows`);
    expect(l.env.PATH).toBeUndefined();
  });

  it("uses the macOS layout (bin/node, lib/node_modules) on macOS", () => {
    const rt = fakeRuntimes("darwin");
    const l = resolveLaunch("node", ["server.js"], { PATH: "/usr/bin" }, rt);
    expect(l.command).toBe(join(rt.nodeDir, "bin", "node"));
    expect(l.env.PATH).toBe(`${join(rt.nodeDir, "bin")}:${rt.uvDir}:/usr/bin`);
  });

  it("runs uvx on the bundled uv and prefers uv's own Python", () => {
    const rt = fakeRuntimes("win32");
    const l = resolveLaunch("uvx", ["mcp-server-fetch"], {}, rt);
    expect(l.command).toBe(join(rt.uvDir, "uvx.exe"));
    expect(l.env.UV_PYTHON_PREFERENCE).toBe("managed");
  });

  it("leaves other programs alone, and changes nothing when the bundled copies aren't there", () => {
    const rt = fakeRuntimes("win32");
    expect(resolveLaunch("C:\\tools\\server.exe", ["--x"], {}, rt)).toMatchObject({ command: "C:\\tools\\server.exe", args: ["--x"] });
    const none = { nodeDir: join(tmpdir(), "rk-nope", "node"), uvDir: join(tmpdir(), "rk-nope", "uv"), platform: "win32" as const };
    expect(runtimesPresent(none)).toEqual({ node: false, uv: false });
    expect(resolveLaunch("npx", ["-y", "a"], { Path: "C:\\Windows" }, none)).toEqual({ command: "npx", args: ["-y", "a"], env: { Path: "C:\\Windows" } });
  });

  it("works with the real downloaded Node, when present", () => {
    const target = `${process.platform}-${process.arch}`;
    const nodeDir = resolve("apps/desktop/runtimes", target, "node");
    if (!fs.existsSync(nodeDir)) return; // fetched by scripts/fetch-runtimes.mjs; not in a fresh checkout
    const l = resolveLaunch("node", ["-e", "process.stdout.write(process.version)"], { ...process.env } as Record<string, string>, { nodeDir });
    const out = execFileSync(l.command, l.args, { env: l.env, encoding: "utf8" });
    const pinned = JSON.parse(fs.readFileSync("runtimes/runtimes.json", "utf8")).node.version;
    expect(out).toBe(`v${pinned}`);
  });
});
