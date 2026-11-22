// "Did it work?" after the first sign-in to a tool: which sign-ins ask, and the email either answer
// opens (the user reads it and chooses to send it; nothing is sent by itself).
import { describe, expect, it } from "vitest";
import { catalog } from "../packages/catalog/src/index.js";
import { FEEDBACK_EMAIL, feedbackMailto, feedbackServiceFor } from "../apps/desktop/src/main/catalog.js";
import type { ConnectionView } from "../apps/desktop/src/shared/api.js";

const notion: ConnectionView = { kind: "remote", id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", auth: "oauth", signedIn: true, fields: [], missingKeys: [] };

function parse(mailto: string) {
  const u = new URL(mailto);
  return { to: u.pathname, subject: u.searchParams.get("subject")!, body: u.searchParams.get("body")! };
}

describe("which sign-ins ask", () => {
  it("asks the first time for a service, and never again once it's answered", () => {
    expect(feedbackServiceFor(notion, undefined)?.id).toBe("notion");
    expect(feedbackServiceFor(notion, {})?.id).toBe("notion");
    for (const answer of ["worked", "problem", "skipped"]) expect(feedbackServiceFor(notion, { notion: answer })).toBeUndefined();
    // Another service's answer doesn't count.
    expect(feedbackServiceFor(notion, { airtable: "worked" })?.id).toBe("notion");
  });

  it("doesn't ask about a connection that isn't a service in Add a tool", () => {
    const own: ConnectionView = { ...notion, name: "Our own server", url: "https://tools.example.com/mcp" };
    expect(feedbackServiceFor(own, undefined, catalog.services)).toBeUndefined();
  });
});

describe("the email", () => {
  const base = {
    service: { id: "hootsuite", name: "Hootsuite", beta: true },
    how: "web address, signed in",
    status: "not working: Couldn't reach Hootsuite for Acme Corp. Sign in again for Acme Corp.",
    clientName: "Acme Corp",
    version: "0.2.7",
    system: "Windows 10.0.26300 (x64)",
  };

  it("goes to the address given, says what worked, and leaves the client's name out", () => {
    const m = parse(feedbackMailto({ ...base, worked: true }));
    expect(FEEDBACK_EMAIL).toBe("alexey@yushkin.us");
    expect(m.to).toBe("alexey@yushkin.us");
    expect(m.subject).toBe("Ringkeeper Connect: Hootsuite worked");
    expect(m.body).toContain("Tool: Hootsuite (Beta)\r\n");
    expect(m.body).toContain("Result: Worked");
    expect(m.body).toContain("Ringkeeper Connect 0.2.7 on Windows 10.0.26300 (x64)");
    expect(m.body).toContain("Couldn't reach Hootsuite for [client]. Sign in again for [client].");
    expect(m.body).not.toContain("Acme");
    expect(m.body).toContain("Anything else (optional): ");
  });

  it("a problem report leaves room to say what happened", () => {
    const m = parse(feedbackMailto({ ...base, worked: false, service: { id: "notion", name: "Notion" } }));
    expect(m.subject).toBe("Ringkeeper Connect: a problem with Notion");
    expect(m.body).toContain("Tool: Notion\r\n");
    expect(m.body).toContain("Result: Had a problem");
    expect(m.body).toContain("What happened: ");
    expect(m.body).toContain("What you expected: ");
  });

  it("keeps a long status short", () => {
    const m = parse(feedbackMailto({ ...base, worked: false, status: "x".repeat(5000) }));
    expect(m.body).toContain(`Status in Ringkeeper Connect: ${"x".repeat(500)}\r\n`);
  });
});
