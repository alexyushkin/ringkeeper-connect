# M4 results: catalog, sign-in, bundled runtimes

Date: 2026-11-16.

## What each vendor offers (checked against their docs, 2026-11-16)

| Service | Official hosted connection | Sign-in any app can use? | Key alternative | In the catalog |
| --- | --- | --- | --- | --- |
| n8n | `https://<instance>/mcp-server/http` (built into n8n) | Not confirmed in n8n's docs | MCP access token (Settings > Instance-level MCP), `Authorization: Bearer …` | **Key.** Note: each workflow must be switched on for AI access. |
| Supabase | `https://mcp.supabase.com/mcp` (`project_ref` optional) | Yes (dynamic registration) | Access token from dashboard/account/tokens | **Sign-in** (recommended) or token; optional project ID |
| Airtable | `https://mcp.airtable.com/mcp` | Yes, all plans | Personal access token (pre-filled link with the right permissions) | **Sign-in** (recommended) or token |
| Notion | `https://mcp.notion.com/mcp` | Yes (discovery, registration, PKCE; refresh tokens rotate) | Notion's own MCP tokens are Business/Enterprise only; the local package is deprecated | **Sign-in** only |
| Stripe | `https://mcp.stripe.com` | Not confirmed in Stripe's docs | **Restricted key with agent access** (`rk_live_…`). Full `sk_` keys are rejected from December 2026 | **Key**, refusing `sk_`/`pk_` keys with an explanation |

The local packages for Notion and Stripe are deprecated, and Supabase no longer documents one, so the catalog uses only the hosted connections. Facts the vendors' docs didn't confirm were left out.

## What was built

- **`packages/catalog`**: the catalog as data (`catalog.json`), plus:
  - a consistency check: every placeholder has a field, links and addresses are https, patterns compile
  - `buildConnection()`: turns answers into a connection, keeps keys secret, accepts either form of the n8n address, and adds the optional Supabase project ID to the address only when given
- **Sign-in** (`packages/gateway/src/oauth.ts`):
  - Uses the official SDK's OAuth (discovery, dynamic registration, PKCE) with a short-lived `127.0.0.1` return address and a check against forged sign-in replies.
  - Tokens are stored encrypted for each client and connection.
  - The gateway refreshes tokens quietly and saves rotated refresh tokens immediately (Notion revokes access if an old one is reused).
  - When the vendor refuses (expired, revoked), the connection shows **Needs sign-in** and the AI app is told so. Ringkeeper never opens a browser by itself.
- **Bundled runtimes:**
  - **Node 24.22.3 LTS** (same major as Electron's own Node) and **uv 0.13.8**, pinned with the publishers' checksums in `runtimes/runtimes.json`.
  - `scripts/fetch-runtimes.mjs` downloads and verifies them for win-x64, mac-arm64 and mac-x64 and refuses any mismatch.
  - When a connection starts, `npx`/`npm`/`node`/`uvx`/`uv` run on the bundled copies; the stored settings aren't changed, so Restore and the user's setup stay as written.
  - The bundled folders go first on PATH, and uv prefers its own Python.
  - A download that fails offline is explained ("Couldn't download what n8n for Acme needs to start. Check your internet connection…").
  - The bridge runs on the bundled Node too.
- **App:**
  - "Add connection" now opens a catalog picker (n8n, Supabase, Airtable, Notion, Stripe, or "Something else (advanced)" for the old form).
  - Each service shows its notes, its options with the recommended one first, field help and "where to find this" links. Only catalog links can be opened.
  - Sign-in waits while you finish in the browser, with a **Copy link** fallback for when the browser is signed in to the wrong account.
  - Connections that need it get a **Sign in** button.

## Verified

- **110 automated tests**, including:
  - **Sign-in end to end** against a fake vendor that follows the real rules: discovery, registration, PKCE checked server-side, refresh-token rotation with revoke-on-reuse, and a 401 challenge. Covered:
    - sign in, then use the connection
    - an expired access token refreshed quietly, with the rotated refresh token saved
    - a revoked sign-in showing "needs you to sign in again"
    - a cancelled sign-in
    - a service without usable sign-in
  - **Catalog:** data consistency, building each service's connection, Stripe key checks.
  - **Runtimes:** Windows and macOS layouts, PATH handling, uvx; the real downloaded Node reports the pinned version.
  - **Store:** sign-in state; copies need their own sign-in; changing the address forgets the sign-in.
- **In the running app** (fake user folder plus a local fake vendor; no real accounts):
  - Bundled Node and uv were found, and the n8n and airtable test connections ran on the bundled Node.
  - "Sign in" opened the browser, the round trip finished in under 3 seconds, and the connection turned Ready. The tokens are stored encrypted.
  - The catalog picker, the Notion form (note plus "Add and sign in") and the Stripe form all look right. A `sk_live_` key is refused inside the form with the explanation.
  - **Fixed after trying it:** form errors were showing behind the dialog.

## Not verified yet

- Signing in to the **real** Notion, Airtable and Supabase. I didn't create registrations with real vendors or use your accounts. The flow follows their documented OAuth and was tested against a fake that enforces the same rules. Worth one real sign-in each before release.
- macOS runtimes in practice (the layout is tested, the binaries weren't run).
- Size: the unpacked Node is about 107 MB and uv about 32 MB. M5 should trim Node's headers and docs before packaging.
