# Ringkeeper Connect: product spec

Repo: alexyushkin/ringkeeper-connect (public, MIT, copyright Alexey Yushkin). It already exists with a LICENSE, a README stub and a Node .gitignore; build on those, don't recreate them.

## What it is

A desktop app for Windows and macOS that sits between AI apps (Claude Desktop, Cursor, Claude Code) and the user's MCP servers. The user connects each client's tools once (n8n for client A, n8n for client B, Airtable for client C...) and never switches connections again. Claude Desktop sees one connector: Ringkeeper Connect. (Internally the core is called the gateway; never show that word in the UI.) Target users are agency owners who aren't technical, so nothing may ever require a terminal, Docker, Node or Python.

## Stack (decided)

- Electron + TypeScript, electron-builder, electron-updater on GitHub Releases
- Official MCP TypeScript SDK: **v1** (`@modelcontextprotocol/sdk` 1.x) for v1.0; revisit v2 before M5 once its Node HTTP adapter catches up (decided in M2)
- Secrets encrypted with Electron safeStorage, never in plain JSON
- pnpm monorepo: `apps/desktop`, `packages/gateway`, `packages/bridge`, `packages/catalog`

## Architecture

1. **Gateway daemon** runs inside the app and serves MCP over Streamable HTTP on 127.0.0.1 with a per-install token. The port is picked at random **once, at install**, and kept; if it is taken at startup the gateway falls back to another port. The current port and token are written to a runtime file in the app's data folder, so the bridge never depends on a fixed port.
2. **Bridge**: a tiny stdio MCP shim, run by the **bundled Node** (not `ELECTRON_RUN_AS_NODE`). Claude Desktop's config file only takes stdio for local servers, so its entry points at the bridge, which reads the runtime file and forwards to the daemon. If Ringkeeper isn't running, the bridge starts it and waits. **Decided in M3: the bridge is used for all three apps.** Direct HTTP worked in M1, but only the bridge can start Ringkeeper when it isn't running, reconnect after it restarts, and keep the access token out of the apps' config files.
3. **Upstream servers**: the gateway launches or connects to each client's MCP servers (stdio or remote) and keeps them separated per client. Proxied tool names get a stable per-connection prefix, e.g. `n8n_main__create_workflow`, so two connections of the same service never collide.
4. **Tool exposure**: never dump every client's tools at once. Two modes, chosen per host from the name it reports when it connects (see [m1-results.md](m1-results.md)):
   - **Dynamic** (Claude Code, Cursor: verified in M1 to honour `tools/list_changed`): only the active client's tools, swapped via `tools/list_changed`, plus `ringkeeper_list_clients` and `ringkeeper_use_client`.
   - **Fixed** (default for **Claude Desktop** and any host not verified): a tool list that never changes: `ringkeeper_list_clients`, `ringkeeper_use_client`, `ringkeeper_search_tools`, and `ringkeeper_call_tool` (client + tool + arguments; the client must be the active one). Claude Desktop loads its tool list only at startup, so dynamic mode leaves it with stale tools.
   - The list of dynamic hosts is a setting, so a host that starts honouring `list_changed` can be moved without a code change.
5. **Active client is app-wide, not per chat.** Claude Desktop shares one connection across all its chats, so switching (from the tray or with `ringkeeper_use_client`) switches every open chat; the UI must say so. Safeguards: every tool result is labeled with the client it ran against, and the gateway refuses calls to tools that aren't in the active client, with a plain message. A required client argument (`ringkeeper_client` on proxied tools in dynamic mode; `client` on `ringkeeper_call_tool` in fixed mode) is checked against the active client. In M1 it caught a real wrong-client call, so it is **on by default** (decided in M2; can be turned off in settings). **When an AI app switches the client** with `ringkeeper_use_client`, the switch happens immediately and Ringkeeper shows a system notification ("Claude Desktop switched to Globex. Every chat now uses Globex."), and the tray updates.
6. **Keep client work inside Ringkeeper.** When a Ringkeeper tool was missing, Claude Desktop used the user's own built-in Airtable connector and searched the wrong account. Every model-facing text (server instructions, meta tool descriptions, proxied tool descriptions, "no such tool" errors) therefore states that all work on the user's clients goes through Ringkeeper Connect, names the clients, and says never to use another connector for a client's data, even one for the same service.

## v1 features

- **First-run wizard**: detect configs (Claude Desktop, Cursor, Claude Code global files), show the servers found, import them under a "Default" client, back up each config, then replace imported entries with the Ringkeeper bridge entry.
  - **Overlapping connectors warning.** For each service imported or added to a client (Airtable, Notion, n8n, ...), warn when the user may also have that service connected directly in an AI app, because the model will reach for it and use the user's own account instead of the client's (seen in M1). Wording along the lines of: "You also have Airtable connected directly in Claude. Claude might use it instead of your client's Airtable. Turn it off in Claude > Settings > Connectors, or keep it only for your own work." Detect what can be detected locally (Claude Desktop Extensions, other entries left in the parent configs). Built-in claude.ai connectors aren't stored locally, so for those the wizard asks once ("Do you also use Airtable in Claude directly?") and shows the same warning. Repeat the check when a connection is added later.
- **Config watcher**: when a new server appears in any parent app config, show a notification: "New connection X found in Claude Desktop. Add to which client?" On confirm, move it (remove it from the parent config) so tools never appear twice. Only touch the `mcpServers` section, write atomically, keep timestamped backups, and never break the file if the host app rewrites it.
- **Backups are encrypted** with safeStorage, because parent configs often hold API keys. **Restore** writes the exact original bytes when the file hasn't changed since Ringkeeper's last edit (or the app broke it). If the app changed other things since (e.g. Claude Desktop saved a preference), Restore undoes only what Ringkeeper did (removes its entry and puts back every connection it took, including ones moved in later) and keeps the app's own changes. Writing the old bytes back in that case would silently undo the user's newer settings.
- **Ringkeeper's entry dropped by the app**: some Claude Desktop versions rewrite the whole config file. The watcher puts the entry back (and notifies), but after 3 times in 2 minutes it stops and asks the user, so it never fights the app.
- **Scope of config editing in v1**: user-level files only (the paths below). Project-level files (`.cursor/mcp.json` in a project, `.mcp.json`, per-project entries under `projects` in `~/.claude.json`) are out of scope. Verified in M3 (see [m3-results.md](m3-results.md)): the Windows Store (MSIX) copy of Claude Desktop's config wins when it exists; Desktop Extensions live in `Claude Extensions/*/manifest.json` (detected for the overlap warning, not moved); Claude Desktop keeps `preferences` and `coworkUserFilesPath` beside `mcpServers`; Claude Code's user-level servers are the top-level `mcpServers` of `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`).
- **Clients**: add, rename, clone a connection to another client and swap its credentials.
- **Catalog**: data-driven JSON of known services (start with n8n, Supabase, Airtable, Notion, Stripe). Prefer each vendor's **official remote MCP server with OAuth**; fall back to key fields with a "where to find this key" link. OAuth only where the vendor's OAuth is free. No Google services in v1. No paid third-party services.
  - **As built in M4** (`packages/catalog/catalog.json`, checked 2026-11-16, see [m4-results.md](m4-results.md)): every service uses the vendor's official hosted connection. Sign-in (OAuth with automatic registration) for Supabase, Airtable and Notion; keys for n8n (its built-in MCP access token) and Stripe (a restricted key with agent access; full `sk_` keys are refused, as Stripe stops accepting them in December 2026). The vendors' local packages are deprecated (Notion, Stripe) or no longer documented (Supabase), so none is used.
  - Signing in opens the vendor's page in the system browser and returns to a short-lived 127.0.0.1 address (PKCE). Sign-ins are stored encrypted per client and connection; refreshed tokens are saved immediately. When a sign-in expires, the AI app is told to ask the user to sign in again; Ringkeeper never opens a browser by itself in the middle of a request.
- **Bundled runtimes**: ship Node and uv for win-x64, mac-arm64 and mac-x64. They mainly serve imported local servers (and run the bridge); rewrite imported npx/uvx commands to use the bundled copies. Errors must handle "no internet" on first run, since npx/uvx still download packages.
  - **As built in M4**: Node 24 LTS and uv are pinned with the publishers' SHA-256 checksums in `runtimes/runtimes.json` and fetched by `scripts/fetch-runtimes.mjs` (refuses mismatches). `npx`/`npm`/`node`/`uvx`/`uv` are rewritten to the bundled copies **when a connection starts**, not in the stored settings, so the user's setup and Restore stay exactly as written. The bundled folders also go first on PATH, and uv prefers its own Python. The bridge runs on the bundled Node too.
- **Tray (Windows) / menu bar (macOS)**: client switcher, status of each connection, settings, quit.
- **Restore**: one button that puts every parent config back exactly as it was before Ringkeeper.
- **Uninstall**: on Windows the uninstaller runs Restore. macOS has no uninstaller, so if the app is gone the bridge answers with a clear message ("Ringkeeper Connect isn't installed. Reinstall it, or restore your settings from ...") instead of failing silently.

## Config paths (verify against current docs before relying on them)

- Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json` and `~/Library/Application Support/Claude/claude_desktop_config.json`
- Cursor: `~/.cursor/mcp.json`
- Claude Code: `~/.claude.json`

## Release and CI

- GitHub Actions matrix (windows-latest, macos-latest), build on tag push, publish installers to GitHub Releases.
- Windows code signing plus macOS Developer ID signing and notarization, using repo secrets. Builds must still succeed unsigned when secrets are missing (for forks).
- Auto-update from Releases.
- **As built in M5** (see [m5-results.md](m5-results.md)): electron-builder config in `apps/desktop/electron-builder.config.cjs`. Windows uses a per-user one-click NSIS installer; macOS gets a dmg + zip for each architecture, built in one job so the update feed lists both. Windows signing uses Azure Artifact Signing with the same secret and variable names as the `ringkeeper` repo, or a .pfx. macOS uses a Developer ID certificate and notarization. Each is used only when its secrets are present. Updates download in the background and install on the next restart. The uninstaller runs `--restore`, except during updates (the same uninstaller runs then, and restoring would disconnect everything). The app starts at login in the background (a setting, on by default). The app archive holds only the bundled code (no node_modules), and only the English Chromium language pack ships.

## UX rules

Every process must be intuitive for a non-technical user. Plain-language errors that suggest a fix. No jargon in the UI ("connection", not "MCP server").

## README

Lead with the core idea: connect each client's tools once and never switch again, even across 100 clients. Then install steps, then screenshots. Setup help contact: yushkin.us and Alexey's LinkedIn.

## How to work

0. Keep this file at `docs/SPEC.md` and create a short `CLAUDE.md` that points to it and holds the standing rules (stack, UX rules, no jargon, tests for config editing).
1. Before writing code, give a short plan for the milestones below and flag anything in this spec that looks wrong.
2. **M1 spike**: bridge + gateway proxying one stdio server into Claude Desktop; test `list_changed` in Claude Desktop, Cursor and Claude Code. Report results before continuing.
3. **M2**: clients, active client switching, secrets.
4. **M3**: import wizard, config watcher, restore.
5. **M4**: catalog, bundled runtimes.
6. **M5**: tray/menu bar polish, CI, signing, auto-update, README.

Write tests for all config editing (import, move, restore), since that code can break the user's other apps.
