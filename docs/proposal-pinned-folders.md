# Proposal: a client pinned to a folder

Written 2026-11-22, with a check of current vendor docs and source on the same day. Nothing here is
built yet. "Unconfirmed" means the docs and source didn't settle it; check it on a real install
before building on it. Client names are made up (Acme, Globex).

## The problem

The active client is app-wide (SPEC, v1 feature 5). Someone working on Acme in one terminal and on
Globex in another can't: one switch moves both. Asked for: different clients in different chats.

The same request is how the worst mistake happens. When which client a chat is on can't be seen,
two windows that look the same point at different clients, and a change lands in the wrong
client's account.

## Decision

**No per-chat switching.** Instead, the user can **pin a folder to a client** in Ringkeeper
Connect. An AI app working in that folder reaches only that client, whatever the active client is,
and can't switch away. Everything that isn't pinned works exactly as today.

Why this and not per chat:

- **Most AI apps can't tell chats apart.** Claude Desktop starts one connection when it opens and
  shares it with every chat, and sends no folder. Cursor and VS Code share one per window. Nothing in
  a request says which chat it came from.
- **A pin is set by the user, once, in the window,** and it's visible. Nothing is chosen by the AI,
  and nothing is remembered silently per chat.
- **A folder is how the per-session tools already work.** Claude Code, Codex and Gemini CLI start
  their own connection for each session, in a folder. A client's work usually lives in that client's
  folder anyway.

## Where it can work (checked 2026-11-22)

| AI app | Connection | How the folder is known | Verdict |
| --- | --- | --- | --- |
| Claude Code (terminal) | One per session; ends with the session ([docs](https://code.claude.com/docs/en/mcp)) | `CLAUDE_PROJECT_DIR` in the bridge's environment; also sends roots | **Works per session** |
| Codex (CLI) | One per session. Newer-protocol connections are shared only between chats with the same working folder ([source](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/connection_pool.rs)) | The bridge's working folder is the session's ([source](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/mcp.rs)); no roots | **Works per session** |
| Cursor | One per window (unconfirmed; a forum report) | Working folder not documented; roots listed as supported, with an old "Method not found" report | **Maybe, per window.** Check on a real install |
| VS Code | Started on the first chat message, likely one per window (unconfirmed) | Working folder "defaults to the workspace folder" ([docs](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)); sends roots | **Maybe, per window.** Our entry is in `~/.copilot/mcp-config.json`; check that the folder still arrives from there |
| Claude Code in the Claude app's Code tab | Unconfirmed. A report says servers start in the home folder with no roots ([issue](https://github.com/anthropics/claude-code/issues/75266)) | Maybe `CLAUDE_PROJECT_DIR` | **Check on a real install** before saying it works |
| Kiro, Antigravity, Codex in the ChatGPT app or extension | Not checked | Not checked | **Off until checked** |
| Claude Desktop (chat) | One for the whole app, shared by every chat ([MCP docs](https://modelcontextprotocol.io/docs/develop/connect-local-servers)) | None: working folder "may be undefined" | **Can't work.** Follows the active client, as today |

MCP "roots" is deprecated as of protocol 2026-07-28 ([spec](https://modelcontextprotocol.io/specification/draft/client/roots)),
so it's a fallback only, never the main way.

Rejected alternative: **writing a project-level entry that names the client** (`.mcp.json`,
`.cursor/mcp.json`, `.codex/config.toml` with a `--client` argument). It writes into the client's
own folder. That file is often committed and shared, it names the client, and the AI can edit it.
It also triggers each app's approval or trust prompt. The pin stays in Ringkeeper Connect.

## What the user sees

All strings follow the UX rules: "folder", "AI app", "client"; never "session", "stdio" or "roots".

**On a client's page,** a new part under its tools:

> **Acme's folders**
> An AI app working in one of these folders uses Acme's tools only, whichever client is active.
> Works in Claude Code and Codex. Claude Desktop chats always use the active client.
> `C:\Work\Acme`, used by Claude Code 2 minutes ago · Remove
> [Add a folder…]

- "Add a folder…" opens the system folder picker. Subfolders are included.
- **Each folder shows whether an AI app has actually used it** ("used by Claude Code 2 minutes ago"
  or "Not used yet"). It's how the user knows the pin works in their app. Without it, a pin that
  silently doesn't apply looks the same as one that does.
- A folder can be pinned to one client only. Pinning it again asks: "C:\Work\Acme is pinned to
  Acme. Pin it to Globex instead?"
- A folder inside another pinned folder takes priority (the closest one wins), and the page says so.

**In the tray and on Home,** the active client stays the headline. When an AI app is working in a
pinned folder, a second line shows it: "Globex in 1 folder (pinned)". Switching from the tray
notifies: "Every chat now uses Acme. Claude Code in C:\Work\Globex stays on Globex (pinned)."

**In the AI app:**

- Every result's label names the pin: `[Client: Globex (pinned to this folder) · n8n]`.
- `ringkeeper_list_clients` starts with "This folder is pinned to Globex in Ringkeeper Connect. Only
  Globex's tools can run here."
- `ringkeeper_use_client` in a pinned folder runs nothing and says: "This folder is pinned to Globex
  in Ringkeeper Connect, so this chat can't switch clients. To work on Acme, start the AI app in
  another folder, or change the pin in Ringkeeper Connect." The active client doesn't change either.
- The instructions sent when the AI app connects say the same, so it doesn't try.

**In the list of what AI apps did,** a call from a pinned folder is listed under the pinned client,
with the app as "Claude Code (pinned folder)".

## Rules

1. **Only the user pins,** in the Ringkeeper Connect window. Never the AI, never a tool, never a
   file in the folder.
2. **Not pinned means today's behaviour.** A folder that matches no pin follows the active client.
   So does an AI app that gives no folder, or gives the home folder, a drive root or its own install
   folder. Those are never matched, even if the user pinned them.
3. **The folder is read once, when the AI app connects.** A session doesn't move between clients
   mid-way because a roots notice arrived. Folders added later in Claude Code (`/add-dir`) don't
   change the pin.
4. **Changing or removing a pin applies straight away** to AI apps already working in that folder.
   Their tool list is refreshed, and the next result's label shows the new client. This is the same
   as switching the active client today.
5. **A pinned client that's archived or deleted** loses its pins. An AI app still working there is
   refused with: "Acme was archived in Ringkeeper Connect. Nothing was run." It doesn't fall back to
   the active client, because that could silently be another client.
6. **Everything a client sets applies the same way:** Look only, asking before deletions, chosen
   actions, turned-off tools, the client name each call must give, and the tools for every client.
7. **Folder paths can name a client.** They're kept out of "Details for support" and out of the
   "Did it work?" email, and the log records a short fingerprint, not the path.
8. **Path matching** is case-insensitive on Windows and Mac. It goes through real paths, so a
   shortcut or a junction can't be used to sneak a folder past a pin. It matches whole folder names
   only: `C:\Work\Acme` doesn't match `C:\Work\Acme-old`.

## How it works

- **Bridge.** At start it works out its folder: `CLAUDE_PROJECT_DIR` if set, otherwise its working
  folder (`process.cwd()`), skipping the folders rule 2 excludes. It sends the folder with the
  connect request as a header (`X-Ringkeeper-Folder`, beside `X-Ringkeeper-App`). If neither gives a
  folder and the AI app declares roots, the gateway may ask for them once, at connect time.
- **Store.** Each client gets `folders: string[]` (real, absolute paths) in `clients.json`. The
  gateway config carries them; an export copy and Send to Ringkeeper leave them out, because the
  folders belong to this computer.
- **Gateway.** `Session` gains `pinnedClientId`, resolved in `createSession` from the folder, and
  again whenever the config changes. One helper, `clientFor(session)`, returns the pinned client or
  the active one. It replaces `this.activeClientId` in `listExposedTools`, `activeUpstreams`,
  `callTool` (every check and the activity note), `labelResult` and the meta tools. This covers both
  ways AI apps see the tools (each tool listed, or `ringkeeper_call_tool` for apps in fixed mode).
  - `setActiveClient` refuses when the asking session is pinned. `notifyToolsChanged` for an active
    switch skips pinned sessions.
  - The idle sweep keeps a client's connections running while any session is pinned to it, and
    prewarms them when a pinned session connects.
- **Desktop app.** The Folders part of the client page, the tray and Home line, and the switch
  notification. It also records "used by" per folder from the gateway's contact events (the same
  way AI apps are marked Connected today).
- **Help.** A "Different clients in different folders" topic in Help.tsx and help.ts, including
  which apps it works in, and the limit for Claude Desktop.

## Tests

- **Gateway, with two sessions, one pinned to Globex and one following the active client (Acme):**
  - Tool lists differ, and calls are checked against each session's own client.
  - A switch from the tray or from the unpinned session doesn't change the pinned one, and only the
    unpinned one gets a tools-changed notice.
  - `ringkeeper_use_client` in the pinned session is refused and leaves the active client alone.
  - The client name a call must give is checked against the pin.
  - Look only and asking before deletions follow the pinned client.
  - Archiving the pinned client refuses calls; it never falls back.
  - Changing the pin moves the session and refreshes its tools.
- **Matching:** the closest folder wins; whole folder names only; Windows letter case; junctions and
  symbolic links resolved; home, drive roots and install folders never match.
- **Bridge:** sends `CLAUDE_PROJECT_DIR` first, then the working folder, and nothing for the excluded
  ones.
- **Privacy:** support details, the "Did it work?" email and logs contain no folder path.
- **On real installs, before the app says it works there:** Claude Code in a terminal, Claude Code
  in the Claude app's Code tab, and Codex CLI. Then Cursor and VS Code per window, before the
  first release, since they're in it. For each: does the
  folder arrive, do two windows or sessions really get two clients, and does a switch leave the
  pinned one alone. Until an app passes, the client page names only the apps that did.

## Not in this

- Per-chat clients in Claude Desktop, or in chats sharing a Cursor or VS Code window.
- Two clients in one session.
- Pins that move to another computer (folders differ per computer).
- Suggesting folders to pin from what the AI apps did (decided: not now).

## Decided (2026-11-27)

- **No suggested folders, for now.** The app doesn't offer "Claude Code was used in C:\Work\Acme
  while Acme was active. Pin it?". It would read the AI apps' activity more closely than today.
- **Cursor and VS Code are in the first release,** one window at a time, if they pass the check on
  a real install (see Tests). An app that doesn't pass isn't named on the client page.
- **The name is "Acme's folders"**: the heading of that part of a client's page, with the client's
  own name. Its button stays "Add a folder…", and the tray, Home and the AI app keep saying
  "pinned" ("Globex in 1 folder (pinned)", "pinned to this folder").
