// A sign-in that fails before the browser part says why, in plain words, with
// no technical text from the service.
import { describe, expect, it } from "vitest";
import { NOT_APPROVED, whySignInFailed } from "../packages/gateway/src/oauth.js";
import { NOT_APPROVED as SHOWN } from "../apps/desktop/src/shared/api.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Meta-like: a sign-in service that advertises registration (and refuses unknown apps). */
function web(withRegistration: boolean): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/.well-known/oauth-protected-resource")) return json({ resource: "https://mcp.example.com/ads", authorization_servers: ["https://auth.example.com"] });
    if (url.startsWith("https://auth.example.com/.well-known/")) {
      return json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
        ...(withRegistration ? { registration_endpoint: "https://auth.example.com/register" } : {}),
      });
    }
    return json({}, 404);
  }) as typeof fetch;
}

describe("why a sign-in couldn't start", () => {
  it("a service that only lets apps it approved register: say so, and don't suggest trying again", async () => {
    const msg = await whySignInFailed("Meta Ads for Seaside", "https://mcp.example.com/ads", false, web(true));
    expect(msg).toBe(
      `Meta Ads for Seaside ${NOT_APPROVED}, and Ringkeeper Connect isn't one of them yet, so this sign-in can't work. Nothing was changed. Use "Request a tool" to tell us you need it.`,
    );
    expect(msg).not.toMatch(/registration|client|dynamic/i);
  });

  it("a service with no sign-in for apps: suggest a key", async () => {
    expect(await whySignInFailed("X for Seaside", "https://mcp.example.com/ads", false, web(false))).toBe(
      "X for Seaside doesn't offer a sign-in that Ringkeeper Connect can use. Use a key instead, if the service offers one.",
    );
  });

  it("registered, but the sign-in page didn't open: try again later", async () => {
    expect(await whySignInFailed("Notion for Seaside", "https://mcp.example.com/ads", true, web(true))).toContain("Try again in a few minutes");
  });

  it("the window recognises the not-approved case by the same words", () => {
    expect(SHOWN).toBe(NOT_APPROVED);
  });
});
