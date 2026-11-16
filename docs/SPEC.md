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
2. **Bridge**: a tiny stdio MCP shim, run by the **bundled Node** (not `ELECTRON_RUN_AS_NODE`). Claude Desktop's config file only takes stdio for local servers, so its entry points at the bridge, which reads the runtime file and forwards to the daemon. If Ringkeeper isn't running, the bridge starts it and waits. Cursor and Claude Code can use the HTTP URL directly if that proves reliable; otherwise use the bridge everywhere.
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
- **Backups are encrypted** with safeStorage, because parent configs often hold API keys. Restore decrypts them and writes the exact original bytes.
- **Scope of config editing in v1**: user-level files only (the paths below). Project-level files (`.cursor/mcp.json` in a project, `.mcp.json`, per-project entries under `projects` in `~/.claude.json`) are out of scope. To verify in M3: the Windows Store (MSIX) location of Claude Desktop's config, servers installed as Claude Desktop Extensions (not in `mcpServers`), other keys Claude Desktop keeps in its config (`preferences`), and safe writes to `~/.claude.json`, which Claude Code rewrites often.
- **Clients**: add, rename, clone a connection to another client and swap its credentials.
- **Catalog**: data-driven JSON of known services (start with n8n, Supabase, Airtable, Notion, Stripe). Prefer each vendor's **official remote MCP server with OAuth**; fall back to key fields with a "where to find this key" link. OAuth only where the vendor's OAuth is free. No Google services in v1. No paid third-party services.
- **Bundled runtimes**: ship Node and uv for win-x64, mac-arm64 and mac-x64. They mainly serve imported local servers (and run the bridge); rewrite imported npx/uvx commands to use the bundled copies. Errors must handle "no internet" on first run, since npx/uvx still download packages.
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
