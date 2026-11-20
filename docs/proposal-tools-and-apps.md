# Proposal: more tools and more AI apps

Written 2026-11-17 from the Ringkeeper repo (read only) and two checks of current vendor docs.
Nothing here is built yet. "Unverified" means the docs didn't confirm it; check it when building.

Today the catalog has 5 tools (n8n, Supabase, Airtable, Notion, Stripe) plus "Something else", and
the app works with 3 AI apps (Claude Desktop, Cursor, Claude Code).

## The MVP (final plan, 2026-11-17)

1. **Release the Claude Desktop settings-file and status fix.** Done: v0.1.1.

2. **AI apps Ringkeeper writes to (7):**
   - Claude Desktop, Cursor and Claude Code, as today.
   - **VS Code**, through `~/.copilot/mcp-config.json` (shared with Copilot CLI). Connections in the
     old per-profile `mcp.json` are brought in but that file is never changed.
   - **Kiro**, `~/.kiro/settings/mcp.json`.
   - **Antigravity**, `~/.gemini/config/mcp_config.json`. Its docs list programs run on the computer,
     so it uses the bridge like the others; if the real install ignores it, switch to the web address.
   - **Codex / ChatGPT desktop**, `~/.codex/config.toml`, with a comment-keeping TOML editor and full
     tests. The app says plainly that ChatGPT uses Ringkeeper Connect only in Codex, not in regular
     chats.

   Rules: the new apps are opt-in (found, but unticked in the wizard). Each is checked on a real
   install before release: the right file, the entry visible in the app, tools working, and Restore
   putting the file back exactly. Duplicates are tested: when an app already finds us through another
   app's file (VS Code reading Claude Desktop's or Cursor's), Ringkeeper doesn't write a second entry.

3. **AI apps Ringkeeper only reads from** (brings connections in, never writes): Windsurf / Devin
   Desktop (and Windsurf Next), Gemini CLI, Cline, Roo Code, Warp, LM Studio, JetBrains Junie, Zed,
   Continue, Amazon Q, Visual Studio and VS Code's old `mcp.json`.
   - What's found is merged and de-duplicated across all apps.
   - Anything that can't be read is listed with a plain reason, never skipped silently.
   - **Claude Desktop extensions:** their keys are in the system keychain, so they can't be copied.
     Ringkeeper recognises the service and offers the matching catalog tool, ticked, to sign in again or
     re-enter the key.
   - **A wizard step:** "Do you also use any of these in Claude or ChatGPT on the web?", with catalog
     tools to tick, since online connectors can't be read.

4. **Catalog (about 35 tools):** the current 5 plus Neon, Netlify, GitHub, Apollo, Leadfeeder,
   Upwork, Retell AI, Make, Zapier, GoHighLevel, Pipedrive, monday.com, Close, Klaviyo, Meta Ads,
   Resend, WordPress.com, WordPress (own site), Webflow, Wix, PayPal, Trello, Jira and Confluence,
   Linear, Canva, Calendly, Cal.com, Tavily, Apify and ElevenLabs.
   - Groups and a search box on "Add a tool".
   - A note per tool before sign-in ("Paid plan", "Uses credits" and so on).
   - Tools checked with a real sign-in show normally; the rest show "Beta". A checklist says which
     can be tested with which accounts.
   - "Request a tool" at the bottom opens an email.

5. **After the MVP (not now):** one more writable AI app per release, the rest of the catalog, then
   your-own-app sign-in and CIMD for Google, HubSpot, QuickBooks, Xero and Slack. No registry search.

Everything below is the wider plan for after the MVP.

## Where the list comes from

Ringkeeper has two kinds of connections:

- **About 45 official sign-in servers** (`src/ringkeeper/remote.py`), checked by its own self-test on
  2026-11-15. These map straight onto this app's catalog.
- **About 30 built-in services** (its own Python code for HubSpot, QuickBooks, Shopify, Google and so on).
  This app can't reuse that code: every tool here has to be an MCP server. So each one was
  checked for the best current server.

How each can connect here decides the tier:

- **Ready now:** a vendor server that signs in by itself (OAuth with dynamic registration), or takes a
  pasted key or address. The app already supports both.
- **Needs "your own app":** the vendor only lets in apps registered with it (client ID and secret),
  or only approved apps. The app can't do this yet; it's a new feature.
- **Community only:** no vendor server. Possible as a program on the computer, but less trustworthy.

## 1. Tools ready to add now (about 50)

All official. "Sign in" = OAuth that works today; "Key" = pasted key or token; "Address" = the
client's own address. Grouped the way the "Add a tool" screen should group them.

| Group | Tool | How | Address / package | Notes |
| --- | --- | --- | --- | --- |
| Databases | Neon | Sign in or key | `https://mcp.neon.tech/mcp` | Can be held to one project |
| | Supabase, Airtable | (have) | | |
| Automations | n8n | (have) | | |
| | Make | Sign in | `https://mcp.make.com` | |
| | Zapier | Sign in | `https://mcp.zapier.com/api/v1/connect` | Uses Zapier tasks |
| CRM and sales | Pipedrive | Sign in | `https://mcp.pipedrive.ai/mcp` | Launched June 2026 |
| | GoHighLevel | Sign in | `https://services.leadconnectorhq.com/mcp/anthropic/v2` | Pick the sub-account at sign-in |
| | Attio | Sign in | `https://mcp.attio.com/mcp` | |
| | Close | Sign in | `https://mcp.close.com/mcp` | |
| | monday.com | Sign in | `https://mcp.monday.com/mcp` | Beta |
| | Zoho CRM | Address | `https://<name>-<org>.zohomcp.com/mcp/<key>/message` | The address holds a key: store it as a secret |
| | Apollo | Sign in | `https://mcp.apollo.io/mcp` | Some tools spend credits |
| | Leadfeeder | Sign in | `https://mcp.leadfeeder.com/mcp` | Paid plan |
| | Intercom | Sign in or key | `https://mcp.intercom.com/mcp` | US workspaces only |
| Email marketing | Klaviyo | Sign in | `https://mcp.klaviyo.com/mcp` | Owner, Admin or Manager role |
| | ActiveCampaign | Address | Per account (Settings > Developer) | Unverified whether it's a key in the address or a sign-in |
| | Mailchimp Transactional | Key | `https://mandrillapp.com/mcp` | Transactional only; no campaigns server |
| | Resend | Sign in or key | `https://mcp.resend.com/mcp` | Sends email |
| Accounting | FreshBooks | Sign in | `https://mcp.freshbooks.com/v1` | Read only for now |
| | Zoho Books | Sign in | `https://claude-zohobooks.zohomcp.com/mcp/message` | US address |
| | Odoo | Address + sign in | `https://<db>.odoo.com/mcp` | Odoo 20 / saas-19.4 |
| Payments | Stripe | (have) | | |
| | PayPal | Sign in | `https://mcp.paypal.com/mcp` | |
| | Square | Key (program) | `npx square-mcp-server start` with `ACCESS_TOKEN` | The hosted server only admits approved apps |
| | Mollie | Sign in | `https://mcp.mollie.com/mcp` | |
| | Paddle | Sign in | `https://mcp.paddle.com/mcp` | Starts read only |
| | GoCardless | Sign in | `https://mcp.gocardless.com` | |
| Websites and CMS | WordPress.com | Sign in | `https://public-api.wordpress.com/wpcom/v2/mcp/v1` | |
| | WordPress (own site) | Address + app password | Plugin's address | Needs the MCP Adapter plugin; Basic auth |
| | Webflow | Sign in | `https://mcp.webflow.com/mcp` | |
| | Wix | Sign in | `https://mcp.wix.com/mcp` | |
| | Sanity | Sign in | `https://mcp.sanity.io` | |
| | Contentful | Sign in | `https://mcp.contentful.com/mcp` (EU: `mcp.eu.contentful.com`) | Install its app in the space first |
| | Strapi, Payload | Address + key | The client's own | Server must be turned on |
| Ads and SEO | Meta Ads | Needs our own approved app | `https://mcp.facebook.com/ads` | Its sign-in lets only apps Meta approved register (checked 2026-11-18); taken out of the MVP catalog |
| | DataForSEO | Key | `https://mcp.dataforseo.com/mcp` | Basic auth (login:password) |
| | Ahrefs | Sign in or key | `https://api.ahrefs.com/mcp/mcp` | Lite plan or higher |
| | Semrush | Sign in or key | `https://mcp.semrush.com/v1/mcp` | API-enabled plan |
| Projects and work | Linear | Sign in or key | `https://mcp.linear.app/mcp` | |
| | Jira and Confluence | Sign in | `https://mcp.atlassian.com/v2/mcp` | Uses Rovo credits |
| | Trello | Sign in | `https://mcp.trello.com/v1` | |
| | Canva | Sign in | `https://mcp.canva.com/mcp` | Canva is moving sign-in to a newer method (see section 3) |
| Scheduling | Cal.com | Sign in | `https://mcp.cal.com/mcp` | |
| | Calendly | Sign in | `https://mcp.calendly.com` | No personal tokens |
| Dev and hosting | GitHub | Key | `https://api.githubcopilot.com/mcp/` | Fine-grained token |
| | Cloudflare | Sign in or key | `https://mcp.cloudflare.com/mcp` | |
| | Netlify | Sign in | `https://mcp.netlify.com/mcp` | |
| | Sentry | Sign in or key | `https://mcp.sentry.dev/mcp` | Key uses its own header scheme |
| | PostHog | Sign in | `https://mcp.posthog.com/mcp` | |
| | Clerk | Sign in | `https://mcp.clerk.com/mcp` | |
| Voice and phone | ElevenLabs | Sign in | `https://api.elevenlabs.io/v1/mcp` | Calls and speech cost credits |
| | Retell AI | Key | `https://mcp.retellai.com` | |
| | Twilio | Key (program) | `npx -y @twilio-alpha/mcp <SID>/<KEY>:<SECRET>` | Alpha; the key goes in the program's arguments |
| Research | Apify, Tavily | Sign in | `https://mcp.apify.com`, `https://mcp.tavily.com/mcp/` | Use credits |
| Other | Upwork | Sign in | `https://mcp.upwork.com/mcp` | |

Ringkeeper also ran AWS, Azure, Google Cloud and Oracle Cloud servers with the computer's own
command-line login. Those suit developers, not agency owners: leave them out of the catalog.

**What the catalog needs for this many tools:** groups and a search box on "Add a tool" (Ringkeeper
groups by CRM, Accounting, Payments, CMS and so on), and the per-tool note shown before sign-in
("Paid plan", "Uses credits", "US workspaces only").

## 2. Tools that need "your own app" support

These are some of the most asked-for tools, but the vendor only lets in apps registered with it.
The fix is one feature: **Settings > Developer apps**, where the user pastes a client ID and secret
once per vendor, as Ringkeeper does. Then each tool's sign-in goes through that app. Ringkeeper's
`docs/services/developer-apps.md` has the steps per vendor, including the https return page that
Intuit, Xero, HubSpot and Salesforce require.

| Tool | Server | What the user must register |
| --- | --- | --- |
| HubSpot | `https://mcp.hubspot.com` | An "MCP Auth App" in HubSpot |
| Salesforce | Hosted MCP (`api.salesforce.com/platform/mcp/...`) | External Client App; Enterprise edition and an admin |
| Slack | `https://mcp.slack.com/mcp` | A Slack app |
| Asana | `https://mcp.asana.com/v2/mcp` | An "MCP app" in Asana |
| Xero | `https://api.xero.com/mcp/v1` | A Xero app; Core plan or higher |
| QuickBooks Online | Intuit's program, or a hosted server not yet public | An Intuit developer app (unverified for the hosted one) |
| Business Central | `https://mcp.businesscentral.dynamics.com` | An Entra app; read only until an admin allows writes |
| Jobber | `https://mcp.getjobber.com/mcp` | A Jobber-approved app |
| Gmail, Calendar, Drive, Sheets | Google's own servers (developer preview) | A Google Cloud project, plus the Workspace preview program. Gmail can only draft, not send |
| Google Ads, Analytics (GA4) | Google's own programs (`google-ads-mcp`, `analytics-mcp`) | A Google Cloud sign-in; Ads also needs a developer token |

Three more need the vendor to approve this app once, not the user: **Vercel**, **ClickUp** and
**Square's** hosted server. Vercel, and soon Canva, also accept a newer sign-in method, client ID
metadata documents ("CIMD"), where the app's ID is a page we host. Supporting CIMD covers Vercel
and keeps Canva, Pipedrive, Clerk, Cal.com and Trello working as they drop self-registration.

**Microsoft 365** (Outlook, OneDrive, SharePoint) has no official server for apps like this one
(Microsoft's needs Agent 365 or Copilot licences). The best option is the community program
`@softeria/ms-365-mcp-server`, which signs in with a code and needs no app of your own. Admins of
work accounts may have to approve it (unverified).

## 3. Community only, or skip

No vendor server. Each could be added as a program, marked "made by the community", but I'd wait
until a client asks:

- **Possible later:** Shopify store admin, Ghost, Keap, Housecall Pro, Wave, Lemon Squeezy, Clover,
  Helcim, Zendesk (official one announced, not available), Search Console, PageSpeed Insights,
  Bluesky (simple: handle and app password), Threads, any Postgres database (`uvx postgres-mcp` with
  its connection string).
- **Skip:** ServiceTitan (needs a developer app even for community servers), BILL (its server only
  answers questions about its docs), Braintree, Plaid (dashboard only, no bank data), LinkedIn (no
  server that keeps to LinkedIn's terms), Facebook Pages and Instagram (no official server; Meta Ads covers ads).

**For anything not listed**, "Something else" already takes an address or a program. Ringkeeper
also searched the official MCP Registry from "Add a tool" (vendor servers first, community folded
away). That would cover the long tail without us adding tiles one by one.

## 4. More AI apps

"Bring in connections" already takes every connection it finds in Claude Desktop, Cursor and
Claude Code, whether or not the tool is in the catalog. It skips Claude Desktop extensions (their
keys are locked in the system keychain), project-only connections and WebSocket connections.

| AI app | User-level settings file | Format, key | Notes |
| --- | --- | --- | --- |
| **Windsurf / Devin Desktop** | `%APPDATA%\devin\mcp_config.json`, `~/.config/devin/mcp_config.json`; old `~/.codeium/windsurf/mcp_config.json` | JSON, `mcpServers` | Renamed June 2026. Remote uses `serverUrl` in the old file. Which file the editor loads needs checking on a real install |
| **Windsurf Next** | `~/.codeium/windsurf-next/mcp_config.json` | Same | |
| **VS Code + Copilot CLI** | `~/.copilot/mcp-config.json` | JSON, `mcpServers` | Now VS Code's default and shared with Copilot CLI. The old per-profile `mcp.json` (`servers`) goes away Feb 2027: import from it only |
| **Visual Studio** (Windows) | `%USERPROFILE%\.mcp.json` | JSON, `servers` | Reloads live; tools start switched off until the user turns them on |
| **Kiro** (editor and CLI) | `~/.kiro/settings/mcp.json` | JSON, `mcpServers` | Reloads live. Also replaces Amazon Q's CLI |
| **Gemini CLI** | `~/.gemini/settings.json` | JSON, `mcpServers` | Whole CLI settings: touch only that key. Paid users only now |
| **Antigravity** (CLI and editor) | `~/.gemini/config/mcp_config.json` | JSON, `mcpServers` | Remote uses `serverUrl`; HTTP only. Sharing between CLI and editor unverified |
| **Cline** | `~/.cline/data/settings/cline_mcp_settings.json`; older copies under VS Code's / Cursor's `globalStorage/saoudrizwan.claude-dev/...` | JSON, `mcpServers` | Reloads live. Stores sign-in tokens in plain text in the file: never log it |
| **Roo Code** | `globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` (unverified) | JSON, `mcpServers` | Remote entries need `type` |
| **Zed** | `%APPDATA%\Zed\settings.json`, `~/.config/zed/settings.json` (unverified) | JSONC, `context_servers` | The editor's whole settings. Honours tool-list changes mid-chat |
| **Codex + ChatGPT desktop** | `~/.codex/config.toml` | TOML, `[mcp_servers.<name>]` | One file for ChatGPT desktop, Codex CLI and its IDE extension. Needs a comment-keeping TOML editor. Restart after changes |
| **Continue** | `~/.continue/config.yaml` | YAML, `mcpServers` is a list | Needs a comment-keeping YAML editor |
| **JetBrains Junie** | `~/.junie/mcp/mcp.json` | JSON, `mcpServers` | |
| **Warp** | `~/.warp/.mcp.json` | JSON, `mcpServers` | Servers added in Warp's own screens may live in its cloud, not the file |
| **LM Studio** | `~/.lmstudio/mcp.json` (also seen at `~/.cache/lm-studio/mcp.json`) | JSON, `mcpServers` | |
| **Amazon Q Developer** | `~/.aws/amazonq/mcp.json` (old CLI); IDE plugins unverified | JSON | Retiring (support ends 2027-04-30): import only, never write |
| **JetBrains AI Assistant** | No documented file | | Not writable; it can import from Claude Desktop itself |
| Trae | To check | | Follow-up check |

**Watch out for doubles.** Several apps also read other apps' files: Warp reads Claude Code's and
Codex's, VS Code can read Claude Desktop's, Cursor's and Windsurf's, Visual Studio reads a
folder's `.vscode` and `.cursor` files, Continue picks up dropped-in JSON. So our one entry may show
twice in those apps. Test each pair; using the same entry name everywhere may let them merge it.

**Per-app status still works:** every one of these supports `env` on a local entry, so
`RINGKEEPER_APP` tells us which app contacted us, and "Connected" stays honest.

**Each new app needs, per CLAUDE.md:** its real file shapes as test fixtures, only its MCP key
touched, backups, atomic writes, Restore, and checking the paths on a real install first.

## 5. General tools in the app, the rest on request for a fee

Keep the built-in catalog to the tools most agencies use, and add less common ones for a client
on request, as a paid service.

**General (built in, about 30).** What agencies' clients run on:

- Work and files: Google Workspace (Gmail, Calendar, Drive, Sheets), Microsoft 365, Slack, Notion,
  Asana, monday.com, ClickUp, Trello, Jira and Confluence, Canva
- Data and automations: Airtable, Supabase, n8n, Make, Zapier
- CRM and marketing: HubSpot, GoHighLevel, Pipedrive, Klaviyo, Mailchimp, Meta Ads, Google Ads,
  Google Analytics
- Money: Stripe, PayPal, Square, QuickBooks, Xero
- Websites: WordPress, Webflow, Wix, Shopify
- Scheduling: Calendly, Cal.com

Over a third of these (Google, Microsoft, HubSpot, Slack, Asana, QuickBooks, Xero, Google Ads and
Analytics) need the developer-apps feature from section 2, and Shopify has only community servers. So the general
list isn't complete until that feature exists. Everything else in section 1 can stay in the
catalog too: each one is just a few lines of data, and a longer list sells the app.

**On request (paid).** Where the work is real and per client:

- Community-only tools (section 3): pick and pin a trustworthy server, test it against the
  client's account, add it to the catalog for that customer.
- Tools that need the client's own registered app, in the client's own tenant (Salesforce,
  Business Central, a client's Microsoft or Google admin approving the app).
- Niche or in-house systems: a client's own API wrapped as a connection.

**What this means for the app:**

- "Something else" stays for people who can set things up themselves; non-technical users are the
  ones who'll pay to have it done.
- No registry search (decided): rare tools come through "Request a tool".
- A "Request a tool" button in "Add a tool" (name of the tool, what they want it for, contact) is
  the simplest way in. It can open an email or a form on yushkin.us.
- A tool added for one customer could ship as a small catalog file they import, so it doesn't
  need a new release. That's a later step.

## 6. Suggested order

1. **Catalog, ready-now tools** (section 1): mostly data, plus groups and search on "Add a tool".
   Biggest gain for the least risk.
2. **AI apps that use plain JSON with `mcpServers`:** VS Code and Copilot CLI, Windsurf / Devin,
   Kiro, Cline, Gemini CLI, Antigravity, Junie, LM Studio, Warp, Roo Code. Same editing code as
   today, new paths and entry shapes.
3. **AI apps with other formats:** Visual Studio (`servers`), Zed (`context_servers`, the editor's
   whole settings), then Codex and ChatGPT desktop (TOML) and Continue (YAML), which need new
   comment-keeping editors and their own tests.
4. **Developer apps and CIMD sign-in** (section 2): unlocks Google, HubSpot, Salesforce, Slack,
   Xero, QuickBooks, Asana and the rest.
5. **Registry search** in "Add a tool" for everything else, and community tools on request.

## 7. Helpers that belong to one AI app (checked 2026-11-20)

Rule (agreed): don't offer a connection that is the same for every client **and** only works
inside one AI app. Code: `packages/gateway/src/app-only.ts`; tests in `test/more-apps.test.ts`.

Only the Codex / ChatGPT desktop app writes such helpers into its settings (`~/.codex/config.toml`).
Claude Desktop, Claude Code, Cursor, VS Code, Copilot CLI, Kiro, Antigravity, Gemini CLI, Zed,
Cline, Windsurf, Visual Studio, Amazon Q, LM Studio and Warp keep theirs out of the file (Roo Code,
Continue and Junie weren't checked).

| Skipped (approved one by one) | What it is | Where it lives |
| --- | --- | --- |
| `node_repl` | Codex's browser and screen-control runner; rewritten by the app at every start | `…\WindowsApps\OpenAI.Codex_<version>_…\app\resources\cua_node\bin\`, `%LOCALAPPDATA%\OpenAI\Codex\bin\<id>\` or `runtimes\cua_node\<id>\bin\`, `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/` |
| `cua_repl` | The same helper under its newer name | Codex's bundled Node running `@oai/cua-repl/bin/cua-repl.mjs` |
| `computer-use` | Codex's screen-control program | `Codex Computer Use.app/…/SkyComputerUseClient mcp` |
| Anything run from Codex's own folders | Helpers it adds later under other names | The folders above, `/Applications/Codex.app`, `~/.codex/plugins/cache/`, `~/.codex/computer-use/` |

Sources: a real Windows install, and openai/codex issues 26011, 26530, 42454, 44736, 53664.

**Kept on purpose** (the same for everyone, but they work from any AI app, so Ringkeeper Connect is
useful for them): the JetBrains IDE server, Figma desktop (`127.0.0.1:3845`), Xcode, Unity, Blender,
Playwright, Chrome DevTools, Browser MCP, Docker's `MCP_DOCKER`, Kiro's default `fetch`. Some sit
inside another app's folder (JetBrains' `java` and jar), so they can break when that app moves; the
"its program isn't on this computer any more" message covers that.

## 8. Tools to add next (checked 2026-11-20)

Checked by reading each vendor server's public sign-in information (no sign-in, no app
registered). "Open" means registration is offered; that it accepts us is untested until a real
sign-in, so each goes in as Beta. Addresses marked * were found on the vendor's domain and answered,
but their docs weren't read.

**Step 1: catalog entries only (sign-in or key works with today's code).**

| Batch | Tool | Address | How |
| --- | --- | --- | --- |
| 1 | Ahrefs | `https://api.ahrefs.com/mcp/mcp` | Sign in or key; uses API units; no renewal listed |
| 1 | Semrush | `https://mcp.semrush.com/v1/mcp` | Sign in, or `Authorization: Apikey <key>`; uses API units |
| 1 | TikTok Ads | `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer` (about 40 tools; `-flat` has about 400) | Sign in; reads and writes |
| 1 | Brevo | `https://mcp.brevo.com/v1/brevo/mcp` | Sign in, or an "MCP" key as `Authorization: Bearer` |
| 1 | Kit | `https://app.kit.com/mcp` | Sign in |
| 1 | MailerLite | `https://mcp.mailerlite.com/mcp` * | Sign in |
| 1 | Intercom | `https://mcp.intercom.com/mcp` * | Sign in |
| 1 | Typeform | `https://api.typeform.com/mcp` * | Sign in |
| 1 | Jotform | `https://mcp.jotform.com/` * | Sign in |
| 1 | Tally | `https://api.tally.so/mcp` * | Sign in |
| 1 | Fireflies | `https://api.fireflies.ai/mcp` * | Sign in |
| 1 | Buffer | `https://mcp.buffer.com/mcp` * | Sign in |
| 2 | Granola, Otter | `https://mcp.granola.ai/mcp`, `https://mcp.otter.ai/mcp` * | Sign in (Otter reads only) |
| 2 | Hootsuite, Metricool | `https://mcp.hootsuite.com/mcp`, `https://ai.metricool.com/mcp` * | Sign in |
| 2 | Instantly, Lemlist, Smartlead, Hunter | `https://mcp.instantly.ai/mcp`, `https://app.lemlist.com/mcp`, `https://mcp.smartlead.ai/mcp`, `https://mcp.hunter.io/mcp` * | Sign in |
| 2 | Vapi | `https://mcp.vapi.ai/mcp` * | Sign in |
| 2 | Customer.io | `https://mcp.customer.io/mcp` (EU: `mcp-eu.customer.io`) * | Sign in |
| 2 | Dropbox, Todoist | `https://mcp.dropbox.com/mcp`, `https://ai.todoist.net/mcp` * | Sign in |
| 2 | Similarweb, DataForSEO | `https://mcp.similarweb.com/`, `https://mcp.dataforseo.com/http` * | Sign in (Similarweb also a key) |
| 2 | Clerk | `https://mcp.clerk.com/mcp` * | Sign in |

Registration there issues a secret (check it's stored and used before listing): Miro, Egnyte,
Dialpad, Sprout Social, Coda, Gusto.

**Step 2: sign-in with an app ID page ("CIMD").** No registration at all, only this: Shopify
(`https://setup.shopify.com/mcp`; its help names only a few AI apps, so test first), Squarespace
(`https://mcp.squarespace.com/mcp`), Zendesk (`https://mcp.zendesk.com/mcp`, early access), Vercel
(`https://mcp.vercel.com`), Aircall, Synthflow. Needs a page we host and support in the sign-in code.

**Step 3: the vendor requires a registered app** (extend "use your own app"): HubSpot
(`https://mcp.hubspot.com/`, client ID and secret), Slack, Asana (`/v2/mcp`; `/sse` is shut), Xero,
Zoom, Box, Wrike, Jobber, Salesforce (per org, by an admin).

**Not now:** Square and Quo/OpenPhone (served at `/sse`; our sign-in doesn't cover that kind yet),
ClickUp (docs say open, users report refusals: test), ActiveCampaign and Zoho CRM (a per-account
address that holds the key), Freshdesk (key, per subdomain), Figma (closed list), QuickBooks and
Mailchimp campaigns (closed), Google Ads (self-hosted only), LinkedIn Ads and Constant Contact
(none), Gusto, Ramp, Brex and Mercury (payroll and money movement), Replit (address unresolved).
