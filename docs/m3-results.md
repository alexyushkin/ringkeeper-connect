# M3 results: setup wizard, config watcher, Restore

Date: 2026-11-16.

## Verified before relying on it

Checked against the apps' docs and a real Windows machine (key names only, never values):

| App | File | What else is in it | Notes |
| --- | --- | --- | --- |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json`, or the Windows Store copy `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\…` when it exists (the app reads that one instead) · macOS `~/Library/Application Support/Claude/` | `preferences`, `coworkUserFilesPath` | No variable expansion. Extensions live in `Claude Extensions/*/manifest.json`, not in this file. Known bugs where Claude Desktop rewrites or wipes the file. |
| Cursor | `~/.cursor/mcp.json` | (often missing until first use) | Expands `${env:NAME}`, `${userHome}`, `${workspaceFolder}`; remote entries are `url` + `headers`. Comments are tolerated. |
| Claude Code | `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), top-level `mcpServers` | ~40 other keys, `projects` (per-project servers, out of scope); 175 KB here | Expands `${VAR}` and `${VAR:-default}`; types `stdio`, `http`, `sse`, `ws`. |

All three were 2-space indented with no trailing newline.

## What was built

### `packages/hostconfig` (no Electron, fully tested)
- **Safe editing** (`config-file.ts`):
  - Uses Microsoft's `jsonc-parser` to change only entries inside `mcpServers`. Every other byte, comment, indent, line ending, byte-order mark and missing trailing newline stays as it was.
  - **Before writing, it re-parses the result and refuses** if anything outside `mcpServers` changed or the connections aren't exactly what was intended.
  - Writes atomically, with retries if the app holds the file.
  - If the app rewrote the file meanwhile, it starts over on the new content.
  - Broken or odd files are left alone, with a plain reason.
- **Encrypted ledger and backups** (`ledger.ts`):
  - Records each app's exact original text, what Ringkeeper last wrote, and every connection it moved out.
  - Keeps 20 timestamped backups per app.
  - Everything is encrypted with safeStorage, because these contain keys.
- **Import mapping** (`import.ts`):
  - Turns app entries into connections.
  - Expands each app's variable syntax.
  - Recognises keys by name and by value.
  - Merges an identical connection found in several apps into one; same name with different settings becomes "name (Cursor)".
  - Leaves behind, with a plain reason, anything it can't carry over: project-only tools, unsupported `ws` connections, unset variables.
  - Detects the service (n8n, Airtable, Notion, …) for the overlap warning.
- **Host manager** (`manager.ts`): connect apps, move connections in, watch, and Restore (see the spec for the rules).
- **Desktop Extensions** (`extensions.ts`): listed, skipping Claude's own backup copies, so overlaps can be warned about.

### Gateway and store
- Older "SSE" web connections are supported, because imported entries use them.

### Desktop app
- **Setup wizard** on first run, and later from "Bring in connections from apps…":
  - Lists the apps and their connections, with checkboxes and reasons for anything greyed out.
  - Lets you choose the client, or create "Default".
  - **To finish:** restart steps for each app.
  - **One more thing:** overlap warnings, e.g. the "Airtable" extension in Claude Desktop, and built-in connectors.
- **AI apps** section in the sidebar: Connected / Not connected (with "Connect") / Can't read, plus "Restore original settings…" with a confirmation.
- **New-connection prompt:** "New connection *notion* found in Claude Desktop. Add it to [client] / Leave it in Claude Desktop", plus a system notification. "Leave it" is remembered.
- **`--restore`** command for the Windows uninstaller (M5). It works whether the app is running or not.
- The bridge is used for all three apps (decision in the spec).
- **Brand:** the Ringkeeper keyring icon and logo from the `ringkeeper` repo replace the placeholder (window, tray, and `.ico`/`.icns` ready for packaging).

## Verified

- **86 automated tests** (`pnpm test`), 28 of them for config editing, using fixtures shaped like the real files: Claude Desktop with `preferences`, a CRLF + byte-order-mark copy, Cursor with comments and `${env:}`, and a `~/.claude.json` with `projects`. They cover:
  - every byte outside `mcpServers` is kept
  - broken files are left untouched
  - the app rewriting the file mid-edit
  - creating Cursor's file when it doesn't exist
  - byte-for-byte Restore, and the "app changed things" Restore
  - Restore of connections moved in later
  - Restore of a broken file
  - the watcher: found, ignored, our own writes, put back, giving up
- **In the running app, against a fake user folder** (never your real apps' settings):
  - Setup moved n8n (merged from Claude Desktop and Claude Code) and airtable (from Cursor) into "Default", and both ran.
  - Unticked playwright stayed in Claude Desktop; Cursor's comment survived.
  - The finish screen showed the restart steps and the Airtable-extension warning.
  - Adding a connection to the fake Claude Desktop file triggered the prompt within about 2 s, and "Add" moved it (its key isn't in plain text anywhere).
  - Restore brought Claude Code back byte for byte, and Claude Desktop back as the original plus the connection added later.
  - `--restore` against the running app brought Claude Desktop back byte for byte.
  - **Bug found and fixed:** Cursor's file came back reordered, because the check of the original choked on its comments. There is now a test for it.
- **Two more bugs found and fixed while running the app:**
  - The bundler picked a `jsonc-parser` build that crashed at startup.
  - The setup's finish screen was skipped.

## Not verified yet

- The setup on **your real** Claude Desktop, Cursor and Claude Code. This session runs inside Claude Desktop and Claude Code, so I didn't touch them. A real run also needs a Claude Desktop restart, which I can't do from here.
- macOS paths in practice. The Windows Store copy was only tested with a fake folder, since this machine's Claude Desktop uses `%APPDATA%`.
- Whether Cursor picks up `mcp.json` changes without a restart. The wizard tells people to restart it, to be safe.

## For later milestones

- M4: the bridge entry currently runs the computer's own Node in development. Packaged builds will use the bundled Node at `resources/node`. Imported `npx`/`uvx` commands get rewritten to the bundled runtimes.
- M5: the Windows uninstaller runs `"Ringkeeper Connect.exe" --restore`. Packaging must keep `userData` fixed.
