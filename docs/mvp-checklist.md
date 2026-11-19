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
6. **Edit** on the Google account: rename it, and untick something: it keeps working with no new
   sign-in, and the AI no longer offers those actions. Tick something new: Save says you'll sign in
   again, and the row shows Sign in. (The same goes for a Microsoft 365 account.)

## 5. Microsoft 365 (after the registration in docs/registered-apps.md)

Needs a build made after `RINGKEEPER_MICROSOFT_CLIENT_ID` is in the repository's Actions settings
(before that, the Microsoft 365 tile says its sign-in isn't in this version yet).

1. Add a tool > Microsoft 365, tick what it may do, Continue, and sign in with Microsoft. Try a
   work account and a personal one (outlook.com).
2. The tool shows Ready. In an AI app, run a reading tool: list messages, read one, list this
   week's events, list OneDrive files, read a Word file.
3. Only the ticked things are offered: by default there's no tool that sends, deletes mail,
   adds events or shares a file.
4. With "Write drafts" ticked, ask for a draft: it's in Outlook's Drafts, and the AI gives its link.
5. A second client with a different Microsoft account: its tools see only that account.
6. Over an hour later it still works (the app renews Microsoft's access by itself), and days later
   too, without signing in again.

## 6. Your own Google app

Works in any build, including one without Ringkeeper Connect's Google app.

1. Sidebar > **Your own apps** > Add a Google app. Follow "How to create one" (the links open
   the right Google Cloud pages), paste the client ID and secret, Save. A wrong secret is refused
   before saving ("Google didn't accept this client ID and secret").
2. Add a tool > Google account: "Sign in through" lists Ringkeeper Connect's app (when the build
   has it) and yours. Choose yours, Continue: Google's sign-in page shows your app's name.
3. The tool works as in section 4, and still works over an hour later (renewed through your app).
4. Your app can't be removed while a tool signs in through it (the list says which); a new secret
   for the same client can be pasted under Edit.
5. A build without our Google app: the Google account tile offers "Set up your own Google app"
   instead of only saying it isn't available.

## 7. Your own Microsoft app

Works in any build, including one without Ringkeeper Connect's Microsoft app. You need a work
Microsoft account to register the app in Microsoft Entra (free).

1. Sidebar > **Your own apps** > Add a Microsoft app. Follow "How to create
   one" (App registrations opens in the Entra admin center), paste the Application (client) ID,
   leave the directory empty, Save. Ringkeeper Connect checks with Microsoft first, without
   signing anyone in.
2. Try the refusals once: a made-up ID, or the app without the `http://127.0.0.1/callback`
   address, is refused before saving ("Microsoft didn't accept this app...").
3. Add a tool > Microsoft 365: "Sign in through" lists Ringkeeper Connect's app (when the build
   has it) and yours. Choose yours, Continue: Microsoft's sign-in page shows your app's name.
4. The tool works as in section 5, and still works over an hour later (renewed through your app).
5. A client's work account may hit "Need admin approval": their IT admin approves the app once.
6. Your app can't be removed, or have its ID or directory changed, while a tool signs in through
   it.

## 8. Meta Ads (your own Meta app)

Needs the return page live first: `https://yushkin.us/ringkeeper-connect/oauth/callback` (in the
yushkin.us repo, `public/ringkeeper-connect/oauth/callback/index.html`).

1. Sidebar > **Your own apps** > Add a Meta app. Follow "How to create one": a Meta app with the
   use case "Create & manage ads with ads MCP server", its permissions added, the return page
   under Facebook Login for Business > Settings > Valid OAuth Redirect URIs, and you under App
   roles. Paste the App ID and App secret, Save. A wrong secret is refused before saving.
2. Add a tool > **Meta Ads** > Continue. Facebook opens; sign in and allow. The browser goes to
   the yushkin.us page and straight back to Ringkeeper Connect ("You're signed in").
3. Ask the AI for your own ad accounts' campaigns: it works. A client's ad accounts need Meta's
   app review for your app first.
4. A Meta Ads tool brought in from Claude Desktop (Meta's own server, `mcp.facebook.com/ads`):
   **Sign in** without a Meta app says to set one up; with one, it signs in through it.
5. About 60 days later the sign-in ends: the tool shows **Sign in** again.

## 9. Meta Ads with an access token

Checked live on 2026-11-19 with a System User token for a real ad account: Test connection said
"Works: 1 ad account." (and can pause, never runs out), and the tools listed the account, its
campaigns and ads, and a report with spend, clicks and a platform breakdown. Meta's own ads server
(`mcp.facebook.com/ads`) turned the same token away (401), so these tools call Meta's ads API
themselves.

1. Meta Business Settings > Users > **System users** > Add (choose **Employee** if Admin is taken:
   one admin system user per business). Assign assets: the client's ad account (Manage campaigns)
   and an app with the ads use case. **Generate token**: that app, expiry **Never**, ads_read,
   ads_management, business_management.
2. Add a tool > **Meta Ads** > **Use an access token** (recommended). Paste it; **Test connection**
   says "Works: N ad accounts". A made-up token says "Meta didn't accept this token. Check it has
   ads_read and hasn't expired." and isn't added.
3. Tick **Pause campaigns, ad sets and ads**, Add tool. Ask the AI for last month's spend by
   campaign: it answers. Ask it to pause one ad: Ringkeeper Connect shows "Acme: Pause this in Meta
   Ads?" with the ad's name. **Don't allow**: nothing changes. Allow: the ad is paused in Ads Manager.
4. A personal token (Graph API Explorer, about 60 days): Test connection gives the end date. A week
   before, the tool's card says "This access token stops working on …". **Edit** > paste a new
   one > Save: the warning goes.
