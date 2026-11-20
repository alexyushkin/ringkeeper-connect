# Changelog

What's new in each version of Ringkeeper Connect, in plain words. A release's page on GitHub
shows its section under "What's new". Versions before 0.2.0-beta.16 are described on their
[release pages](https://github.com/alexyushkin/ringkeeper-connect/releases).

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
