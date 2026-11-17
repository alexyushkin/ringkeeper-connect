# v0.1.1: fixes from the first real Windows test

The first install of v0.1.0 on a second Windows computer showed three problems.

## 1. Claude Desktop's settings were written to the wrong file

On that computer, Claude Desktop (Settings > Desktop app > Extensions > Edit config) opens
`%LOCALAPPDATA%\Claude-Data\claude_<id>\claude_desktop_config.json`. v0.1.0 wrote to the classic
`%APPDATA%\Claude\claude_desktop_config.json`, which that build doesn't read.

The folder name looks like the Store package id, so Ringkeeper looks at every folder under
`Claude-Data`. Anthropic doesn't document this layout; it matches user reports
(anthropics/claude-code issue 26073). Anthropic's data-storage docs list `Claude-3p` for the
3P edition on both Windows (`%LOCALAPPDATA%`, earlier `%APPDATA%`) and macOS. No `Claude-Data`
layout is known on macOS, so macOS keeps `~/Library/Application Support/Claude`, or `Claude-3p`
when only that exists.

Order on Windows:

1. `Claude-Data\*\claude_desktop_config.json`, the most recently changed one. When there are several, the app says which it used.
2. The Store copy `Packages\(Anthropic.)Claude_*\LocalCache\Roaming\Claude\`.
3. The classic `%APPDATA%\Claude\`.
4. A `Claude-Data` folder without the file yet, when there's no classic file either.
5. `Claude-3p`, only when the standard app isn't there.

**Moving the entry.** On start, if the ledger says Ringkeeper set up a different file from the one
chosen now, it first checks the new file can be read (if not, it changes nothing and says so),
then runs Restore on the old file (backup first; byte-exact if untouched since) and adds its
entry to the new one (backup first, only `mcpServers` touched). The user gets a notice:
"Claude Desktop now uses the right settings … Restart Claude Desktop to finish."

## 2. "Connected" only when the app really uses Ringkeeper

Writing the entry proves nothing. Each entry now carries `RINGKEEPER_APP=<app>` in its `env`; the
bridge sends it as an `X-Ringkeeper-App` header, and the gateway reports every app that
finishes connecting (falling back to the name the app reports: `claude-ai`/`local-agent-mode-*`
→ Claude Desktop, `cursor*` → Cursor, `claude-code`). Last contact per app is kept in
`app-contacts.json` in the data folder.

| Status | When |
| --- | --- |
| Connected | The app contacted Ringkeeper since the entry was written |
| Added, restart … to finish | Entry written, no contact yet, app not restarted since (or we can't tell) |
| Not seeing us yet | Entry written, the app was started after that more than a minute ago, still no contact. "Show me how to check" gives plain steps |
| Entry missing (Fix) | Ringkeeper set the app up but the entry is gone. Fix re-adds it, with a backup |
| Can't read its settings | The file isn't valid |

Start times come from the running programs (Windows: `Win32_Process`, macOS: `ps`), checked every
20 seconds in the background. Claude Desktop's `claude.exe` is told apart from Claude Code's by its
path. Claude Code isn't tracked this way (it starts per session).

The entry's write time only changes when the command or arguments change, so adding
`RINGKEEPER_APP` to a v0.1.0 entry doesn't reset it. Entries with no known write time never show
"Not seeing us yet".

The same statuses show in the sidebar, the tray menu and the wizard's last step (live).

## 3. Wording

The client section is now "Tools for <client>", with "+ Add a tool". The empty state reads
"<client> has no tools yet. Bring in the ones you already use, or add one." with both buttons.
The first time the app opens with a single client that has no tools, it opens the "Bring in"
wizard by itself (once; remembered as `bringInOffered`).

## Checked

- Automated tests: every Windows layout (classic, Store, Claude-Data, several Claude-Data,
  Claude-Data folder without a file, 3P) and macOS (standard, 3P); moving the entry (old file
  restored byte for byte, BOM and CRLF kept in the new file, backups, no second move); a broken
  new file leaves both files alone; statuses; app names; process paths; bridge and direct
  connections reporting contact.
- The development build against a fake user folder: the wizard's last step showed "Added,
  restart …" and turned to Connected when a simulated Claude Code session connected; the
  entry moved from the classic file to a new Claude-Data file on restart; removing the entry
  showed "Entry missing" and Fix put it back; the empty state and the one-time wizard.

## Not checked

- A real Claude Desktop reading a Claude-Data file and contacting Ringkeeper (needs the retest).
- The tray menu was not opened during the test.
- macOS start-time detection (`ps`) on a real Mac.
