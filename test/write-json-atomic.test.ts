// Saving the clients and keys files survives Windows briefly locking a file
// that was just written (a virus scanner or the search indexer).
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../packages/gateway/src/runtime.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = fs.mkdtempSync(join(tmpdir(), "rk-write-"));
  dirs.push(d);
  return d;
};
const locked = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

describe("saving a settings file", () => {
  it("retries while the file is briefly locked, then saves", () => {
    const file = join(tempDir(), "clients.json");
    const real = fs.renameSync;
    let failures = 2;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (failures-- > 0) throw locked("EPERM");
      return real(from, to);
    });
    writeJsonAtomic(file, { a: 1 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1 });
    expect(fs.readdirSync(join(file, ".."))).toEqual(["clients.json"]); // no temp file left
  });

  it("gives up after a while, without leaving a temp file, and says why", () => {
    const dir = tempDir();
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw locked("EBUSY");
    });
    expect(() => writeJsonAtomic(join(dir, "secrets.json"), { b: 2 })).toThrow(/EBUSY/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("doesn't retry other errors", () => {
    const dir = tempDir();
    let calls = 0;
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      calls++;
      throw locked("ENOSPC");
    });
    expect(() => writeJsonAtomic(join(dir, "x.json"), {})).toThrow(/ENOSPC/);
    expect(calls).toBe(1);
  });
});
