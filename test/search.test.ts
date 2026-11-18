import { describe, expect, it } from "vitest";
import { matchesWords } from "../apps/desktop/src/renderer/search.js";

describe("search in the window", () => {
  it("finds every typed word anywhere, ignoring case and accents", () => {
    expect(matchesWords("Acme Dental Group", "")).toBe(true);
    expect(matchesWords("Acme Dental Group", "  ")).toBe(true);
    expect(matchesWords("Acme Dental Group", "dent")).toBe(true);
    expect(matchesWords("Acme Dental Group", "group acme")).toBe(true);
    expect(matchesWords("Acme Dental Group", "acme law")).toBe(false);
    expect(matchesWords("Café Müller", "cafe muller")).toBe(true);
    expect(matchesWords("cafe muller", "Café")).toBe(true);
  });
});
