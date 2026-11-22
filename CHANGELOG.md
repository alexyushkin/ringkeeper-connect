# Changelog

What's new in each version of Ringkeeper Connect, in plain words. A release's page on GitHub
shows its section under "What's new". Versions before 0.2.0-beta.16 are described on their
[release pages](https://github.com/alexyushkin/ringkeeper-connect/releases).

## 0.2.11

- **Bring helpers in straight to "For every client".** When bringing in tools your AI apps
  already use, each one can go to "For every client" instead of the client: it's suggested for
  browser helpers like Playwright, and you choose. A connection found in an AI app later can go
  there too.

## 0.2.10

- **Tried tools first.** In "Add a tool", each group lists the tools already tried with a real
  account first, and the ones marked Beta after them, so the surest choice is the first you see.

## 0.2.9

- **HubSpot and Asana.** Both sign in through an app of your own, made in their developer
  consoles in a few minutes ("Your own apps" has the steps). One app works for all your clients.
- **Vercel**, with the newer sign-in method: Ringkeeper Connect's app ID is a page on yushkin.us,
  so there's nothing to set up. Tools that move to this method later work the same way.
- 81 tools in Add a tool.

## 0.2.8

- **Details for support.** A tool that isn't working has "Details for support…" under its
  problem (and every tool has it in its More menu). It shows the version, how the tool connects,
  its status and its last log lines, with keys, sign-ins and your client's name taken out. Copy
  it, or open an email to the developer that you read and choose to send.
- **A warning before a sign-in runs out.** Where a service sets an end to a sign-in (some do,
  after weeks or months), the tool says so a week ahead and shows under "Needs attention", so you
  can sign in again before it stops working.
- **"Try it" after setup.** The last setup screen gives a sentence to paste into your AI app
  ("Which tools do I have for Acme in Ringkeeper Connect?"), so you can see it working.

## 0.2.7

- **"Did it work?" after the first sign-in to a tool.** Once you've tried it, one click on
  "Worked" or "Had a problem" opens an email with the tool's name, its status and the version,
  for you to read and send if you want to. Nothing is sent by itself, and your client's name and
  keys aren't in it. "No thanks" stops asking about that tool. Your answers help confirm the tools
  still marked Beta.

## 0.2.6

- **Move to another computer.** "Move to another computer" in the sidebar saves every client,
  with its tools, keys and sign-ins, into one file locked with a password you choose. On the new
  computer, bring it in from the same place (or from the first screen) and tick the clients you
  want. Nothing already there is changed. Without the password the file can't be opened, and
  nobody can recover a forgotten one.
- **Pin, recent and archive.** "More…" on a client pins it to the top of the list, or archives a
  client you've finished with: it's kept with its tools and keys, but out of the list and out of
  your AI apps' reach until you bring it back. Once the list is long, "Recent" shows the clients
  you used last. The list is now in A to Z order.
- **New client like this one.** "More… > New client like this…", or "Start with" when adding a
  client, copies another client's tools and what the AI may do. Keys and sign-ins aren't copied,
  and each tool waits until you've checked its settings and saved it, so nothing of the other
  client's is used by mistake.
- **Needs attention.** One list, at the top of the sidebar, of every tool in any client that
  needs a key, a sign-in or a check, or isn't working, so it's fixed before a client call.

## 0.2.5

- **Choose which actions the AI gets from each tool.** "More… > Choose actions" on a tool: all of
  them, only the ones that read, or a few you tick. Some tools bring hundreds of actions (Twilio
  has over 200); fewer make the AI quicker and better at picking. An action left out isn't shown
  to the AI and isn't run.
- **Turn a tool off without removing it.** "More… > Turn off" keeps it with its keys and sign-in,
  but AI apps don't get it until you click Turn on.
- **Tools for every client.** "For every client", at the top of the client list, holds tools that
  aren't a client's, like a browser helper or web search. Set them up once and every client gets
  them, whichever one is active. "More… > Use for every client" moves a tool there from a client,
  keys included, and offers to remove the same tool from your other clients. What each client
  allows ("What the AI may do") applies to these tools too.

## 0.2.4

- **Choose what the AI may do for each client.** On a client's page:
  - **Ask me before it deletes anything** (the default): before a tool deletes or removes
    something for that client, Ringkeeper Connect shows what the AI wants to run and waits for your
    OK, whichever AI app asked.
  - **Work freely:** everything is left to your AI app's own permission setting.
  - **Look only:** the AI can read but can't change, send or delete anything for that client.

  Ordinary changes aren't asked about: your AI app already has its own setting for that.
- **See what AI apps did for each client.** "What AI apps did" on a client's page lists the last 200
  actions: which tool, whether it looked, changed or deleted, which AI app asked and how it ended,
  including actions that weren't run. It never shows what was sent or what came back.
- **Switch client from anywhere** with Ctrl+Alt+Shift+K (Cmd+Option+Shift+K on a Mac), which opens
  the list of clients. It can be turned off in the sidebar.

## 0.2.3

- **12 more tools in Add a tool (78 in all):**
  - Social: **Hootsuite** and **Metricool**. Both can schedule and publish posts.
  - Outreach: **Instantly**, **lemlist** and **Hunter**. They can start campaigns that send real
    email, and finding or checking addresses uses the account's credits.
  - Marketing data: **Similarweb** (paid plan, uses data credits) and **DataForSEO** (every lookup
    is paid for from the account's balance).
  - Customer messaging: **Customer.io**. An admin of the account turns it on first, and it starts
    with drafts only.
  - Meetings and tasks: **Granola**, **Otter** (read only) and **Todoist**.
  - Voice: **Vapi**. It can place real, billed phone calls.

  Each tile says before you sign in what the AI can send, publish, call or spend. Instantly,
  lemlist, Hunter, Metricool and DataForSEO also take a pasted key. All 12 are marked Beta until
  tried with a real account.

## 0.2.2

- **12 more tools in Add a tool (66 in all),** each signing in with the service's own server:
  - SEO: **Ahrefs** (Lite plan or higher) and **Semrush**. Lookups use the account's API units.
  - Ads: **TikTok Ads**. It's TikTok's own server and can create campaigns and change budgets, not
    only report, so ask the AI to show you a change before it makes it.
  - Email marketing: **Brevo**, **Kit (ConvertKit)** and **MailerLite**.
  - Social: **Buffer**.
  - Support: **Intercom**, for workspaces hosted in the US or Europe.
  - Forms: **Typeform**, **Jotform** and **Tally**.
  - Meetings: **Fireflies**.

  Semrush, Brevo and Fireflies also take a pasted key. All 12 are marked Beta until tried with a
  real account.

## 0.2.1

- **Codex's own helpers are left in Codex.** Codex adds helpers to its settings for its browser and
  screen control (node_repl, cua_repl, computer-use). They aren't a client's tool, they only work
  inside Codex, and they move every time Codex updates, so one brought into a client stopped working
  at the next update. Ringkeeper Connect no longer offers them, never moves them out of Codex and
  doesn't ask about them. If you brought one in earlier, remove it from the client: Codex keeps its
  own copy.
- **A clearer message when a program has moved.** A tool whose program is no longer where it was now
  says so, and that an update of the app it came with may have moved it, where it used to say it
  "stopped right after starting".

## 0.2.0

The first normal release since 0.1.1. Everything the 0.2.0 test versions added:

- **Ask your AI app about Ringkeeper Connect.** Claude, Cursor and the others can now answer "How do I
  add Globex's Airtable?" or "Why isn't Acme's n8n working?" from a built-in guide and from what's
  set up on this computer: your clients, their tools and whether each works. They never see your
  keys, and changes are still made by you in the Ringkeeper Connect window.
- **More AI apps:** VS Code (and Copilot CLI), Kiro, Antigravity and Codex join Claude Desktop,
  Cursor and Claude Code. Setup also brings in connections from Windsurf, Gemini CLI and other apps
  without changing them.
- **54 tools in Add a tool,** in groups with a search box: n8n, Airtable and Notion, Stripe and
  PayPal, GoHighLevel, Pipedrive and Close, accounting, website builders, Basecamp and more. Sign-in is offered wherever the
  service allows it, so there's no key to make. Tools not yet tried with a real account are marked
  Beta.
- **A client's Google account and Microsoft 365, built in:** Gmail, Calendar, Drive, Docs, Sheets,
  Search Console, Analytics, YouTube and Google Ads; Outlook mail and calendar, OneDrive and
  SharePoint. You tick what the AI may do (read mail but not send it, for example) and can change it
  later with Edit. Sign in through Ringkeeper Connect, or through your own Google or Microsoft app
  when a client's admin requires it.
- **Meta Ads:** reports on campaigns, ad sets and ads, with an access token or Sign in with Meta.
  Pausing is asked for in a window first and only runs if you click Allow.
- **Easier setup:** a client comes first, with search and select all, Connected shown per client,
  a searchable client list, and a "How it works" page. Restore names the apps it changes and what it
  keeps.
- **Steadier:** updates don't interrupt your AI apps, an AI app that drops Ringkeeper Connect gets it
  back, and saving works when Windows briefly locks a file.
- **Check for updates** next to the version, with what it's doing; a failed check tries again in 15
  minutes.

## 0.2.0-beta.19

- **Basecamp** in Add a tool, under Work and projects. Sign in as someone in the client's Basecamp
  and choose read-only or full access; it then works with their projects, to-dos, messages, card
  tables, docs and schedules, and only what that person can see and do. One sign-in covers one
  Basecamp account.
- **Basecamp connections already in an AI app** are recognised during setup, like the other tools.

## 0.2.0-beta.18

- **Check for updates in the window,** next to the version at the bottom of the sidebar, with what
  it's doing: checking, up to date, downloading, or ready. Checking from the tray says how it went
  too.
- **A failed check tries again in 15 minutes** instead of waiting 6 hours (it still checks every
  6 hours otherwise). The usual cause was a new version still being published.

## 0.2.0-beta.17

- **Sign in with Meta works with an ordinary Meta app.** It now runs the same built-in Meta Ads
  tools as an access token, and asks only for what a Marketing API app has: no more "Invalid
  Scopes". Pausing still asks you first, every time.
- **Clearer steps for your own Meta app,** including the App Domains setting Meta needs (without
  it, Meta says "Can't load URL").
- A Meta Ads tool brought in from an AI app becomes the built-in one when you sign in.

## 0.2.0-beta.16

- **Meta Ads with an access token.** Add a tool > Meta Ads > **Use an access token**
  (recommended): paste a token you already have, with no Meta app and no sign-in. A System User
  token from Meta Business Settings is best, because it doesn't run out. The AI can read ad
  accounts, campaigns, ad sets, ads and reports (date ranges, breakdowns by age, platform and
  more, per day, week or month). If you tick it, it can also pause campaigns, ad sets and ads,
  and Ringkeeper Connect asks you first, every time, in an Allow / Don't allow window. It can't
  create ads or change budgets.
- **Test connection** for the token: "Works: 3 ad accounts", or what to fix. A token Meta turns
  away isn't added.
- **A week's warning** before a personal Meta token runs out, on the tool's card. Edit takes a
  new token.
- **Google Ads in the Google account.** Two new tick boxes: **Google Ads: reports** (any report,
  with every page of it, and ad accounts under a manager account) and **Google Ads: pause
  campaigns** (asks you first, every time). If Google hasn't approved the Google app for live ad
  accounts yet, it says so and how to apply.
- **Ticking something new on a Google account** (Edit) signs in once more for just that, and
  Google keeps what you'd already allowed.
