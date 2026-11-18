# MVP checklists (before the release)

Two lists: the new AI apps, checked on a real install, and the catalog tools, checked with a real
sign-in. Once a tool's sign-in works, remove its `"beta": true` in `packages/catalog/catalog.json`.

## 1. New AI apps, on your real install

Use the pre-release **v0.2.0-beta.1** from GitHub Releases (installing it replaces v0.1.1; copies
on v0.1.1 elsewhere don't update to it). Only these apps' files are changed, with a backup first. "Restore original
settings" puts them back. For each app:

1. In the wizard it's listed as found, **unticked**. Tick it and choose Connect apps.
2. **Right file:** the entry is in the file below, and nothing else in it changed.
3. **Entry visible in the app:** after the restart or reload in the "To finish" step, the app lists
   `ringkeeper-connect`. Ringkeeper's sidebar turns to Connected.
4. **Tools work:** ask the app to list the active client's tools, then use one.
5. **Restore:** "Restore original settings" puts the file back exactly. Compare with a copy you made
   before step 1. A file Ringkeeper created is removed.

| App | File | What to check specially |
| --- | --- | --- |
| VS Code (+ Copilot CLI) | `%USERPROFILE%\.copilot\mcp-config.json` (new: it isn't there yet on your PC) | That VS Code reads this file (Copilot Chat in Agent mode > tools icon). The entry uses `"type": "stdio"` and `"tools": ["*"]`: check VS Code accepts them. Copilot CLI shows it too (`/mcp`). |
| VS Code duplicates | VS Code settings `chat.mcp.discovery.enabled` | Turn on discovery of Claude Desktop (Settings > search "discovery") while Claude Desktop has Ringkeeper. Then Connect VS Code: Ringkeeper must **not** write VS Code's file, and must show "Through Claude Desktop's settings". In VS Code, `ringkeeper-connect` appears **once**. If VS Code's newer setup (the Copilot file) ignores discovery, tell me: then the check isn't needed there. |
| Kiro | `%USERPROFILE%\.kiro\settings\mcp.json` (new on your PC) | Kiro's MCP panel lists it and reloads by itself. |
| Antigravity | `%USERPROFILE%\.gemini\config\mcp_config.json` (exists on your PC, empty) | Whether it starts the bridge (a program on the computer). If it ignores it, tell me and I'll switch Antigravity to the web address. |
| Codex / ChatGPT desktop | `%USERPROFILE%\.codex\config.toml` (exists, with 2 connections, one the ChatGPT app manages) | The ChatGPT app's own `node_repl` connection and every other setting stay as they were. Codex shows `ringkeeper-connect` in `/mcp`. Regular ChatGPT chats don't have it (expected). |

Already checked here: the TOML editor on an in-memory copy of your real `config.toml` (adding and
removing gives the same bytes; every other setting unchanged; the file itself untouched), and every
app's documented file shape in the tests.

## 2. Catalog tools: real sign-in

**You likely can test now.** This Claude session has connectors for these, so you have accounts:
Neon, Netlify, Apollo, Leadfeeder (its free plan only allows sign-in, see the note), Upwork. Also
GitHub (a fine-grained token).

**Free account or trial is enough:** Make, Zapier, Pipedrive (trial), monday.com, Close (trial),
Klaviyo, Resend, WordPress.com, Webflow, Wix, PayPal (sandbox), Trello, Jira and Confluence, Linear,
Canva, Calendly, Cal.com, Tavily, Apify, ElevenLabs (API key; runs ElevenLabs' own program).

**Needs something more:** GoHighLevel (paid or trial agency account), WordPress (own site: WordPress 6.9+ with the MCP Adapter
plugin), Leadfeeder (paid plan for anything past sign-in), Retell AI (an account with credits for
calls).

**Taken out:** Meta Ads. Its sign-in server lets only apps Meta approved register ("Dynamic registration
is not available for this client"), so it needs Ringkeeper's own Meta-approved app first (with Google,
HubSpot and the rest in "later").

For each one:

1. Sign in to the tool in your browser first, then **Add a tool > the tool > Continue** (or paste the
   key). Cal.com shows "Authorization unavailable" if you sign in to it halfway through; signed in
   first, it goes through by itself (checked).
2. The sign-in page opens and finishes, and the tool shows **Ready**.
3. In an AI app, list that client's tools and run one reading tool.
4. Note anything odd (wrong permissions screen, extra steps), then remove its `beta` flag.

Checked here without an account: every sign-in server advertises the self-registration this app
needs. The exception is ElevenLabs, which only allows the newer method, so its tile uses its program
with a key. Upwork's registration address looks like its sign-up page, so check that one first.

## 3. Still open

- **"Request a tool"** opens an email to requests@yushkin.us (subject "Tool request: " plus what was
  searched; the body asks for the tool name, what it's for and how to reach you). Set up the alias
  before the release, and send one from the beta to check it arrives.
- **Fixtures:** replace the documented shapes in `test/fixtures/more-hosts.ts` with copies of real
  files (keys removed) as you check each app.

## 4. Google (after the registration in docs/registered-apps.md)

Needs a build made after the Google IDs are in the repository's Actions settings (before that, the
Google account tile says its sign-in isn't in this version yet). With the published app:

1. Add a tool > Google account, tick what it may do, Continue, and sign in with Google. Expect
   Google's "unverified app" warning: Advanced > Go to Ringkeeper Connect.
2. The tool shows Ready. In an AI app, list the client's tools and run a reading one (search
   mail, list files, read a sheet).
3. Only the ticked things are offered: with "Read mail" but not "Send mail", there's no tool that
   sends mail.
4. A second client with a different Google account (Google lets you pick one at sign-in): its tools
   see only that account.
5. Over an hour later, it still works (the app renews Google's one-hour access by itself), and a
   week later too, without signing in again (the app is published, not in testing).
