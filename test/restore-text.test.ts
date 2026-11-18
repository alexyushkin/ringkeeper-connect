import { describe, expect, it } from "vitest";
import { appsToRestore, listOf, restoreBody, RESTORE_POINTS } from "../apps/desktop/src/renderer/restore-text.js";

const hosts = [
  { label: "Claude Desktop", status: "connected" as const },
  { label: "Cursor", status: "not_connected" as const },
  { label: "Claude Code", status: "added" as const },
  { label: "VS Code", status: "not_seeing" as const },
  { label: "Kiro", status: "not_installed" as const },
  { label: "Codex / ChatGPT", status: "missing" as const },
];

describe("the Restore dialog's words", () => {
  it("names only the apps Ringkeeper actually changed", () => {
    expect(appsToRestore(hosts)).toEqual(["Claude Desktop", "Claude Code", "VS Code", "Codex / ChatGPT"]);
    expect(listOf(["A"])).toBe("A");
    expect(listOf(["A", "B"])).toBe("A and B");
    expect(listOf(["A", "B", "C"])).toBe("A, B and C");
  });

  it("says what's kept and what isn't", () => {
    const body = restoreBody(hosts);
    expect(body).toContain("out of Claude Desktop, Claude Code, VS Code and Codex / ChatGPT");
    expect(body).toContain("Anything you changed in those apps since stays as it is.");
    expect(body).toContain("aren't copied back");
    expect(body).not.toMatch(/MCP|gateway|stdio|JSON|port\b/);
    expect(restoreBody([{ label: "Cursor", status: "not_connected" }])).toContain("nothing to restore");
    for (const p of RESTORE_POINTS) expect(p).not.toMatch(/MCP|gateway|stdio|JSON|port\b/);
  });
});
