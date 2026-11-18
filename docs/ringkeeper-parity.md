# Bringing Ringkeeper's integrations to Ringkeeper Connect

Written 2026-11-18 from a read-only review of the Ringkeeper repository (nothing there was
changed). It answers: how does Ringkeeper add Google and the other "your own app" services, and
which of its integrations should Ringkeeper Connect get, how and in what order.

## 1. How Ringkeeper does it

**Google: its own code, the user's own Google app.**

- One connection type, "Google account". Each account has access ticked per product:
  - Gmail (read, send, drafts, trash), Drive, Calendar, Sheets, Docs;
  - Search Console, Analytics (GA4) and YouTube.
- It does not use Google's MCP servers. Its own code calls Google's APIs directly (`gmail.googleapis.com`,
  `www.googleapis.com/drive/v3` and so on; `adapters/google.py`).
- **Sign-in:**
  - a "Desktop app" OAuth client that the user creates in their own Google Cloud project and pastes in (client ID and
    secret); several such apps are allowed;
  - PKCE, a loopback return to any port, `access_type=offline`, `prompt=consent select_account`;
  - `openid email` plus the ticked products' scopes.
- **Tokens:** encrypted in its vault, refreshed 2 minutes before they run out. `invalid_grant` means "sign in again".
- **Publish the app.** Ringkeeper tells the user to publish ("Audience > Publish app") rather than leave the app
  in testing, because in testing Google signs every account out after 7 days.
  - Published but unverified: users click through Google's warning, and the app can sign in **100 accounts in its lifetime**.
  - Ringkeeper's way past that: add another app.
  - Publishing needs a home page, a privacy page and an authorized domain (`yushkin.us/ringkeeper`, `/privacy`).
- **Google Ads:** goes through the same Google app (`adwords` scope).

**Microsoft 365: its own code, the user's own Entra app.**

- Covers Outlook mail, calendar, OneDrive and SharePoint through Microsoft Graph; not Teams or Excel workbooks.
- Sign-in: a confidential "Web" app with a client secret, returning to `http://localhost:17845/oauth/callback`, plus
  `offline_access` and the ticked Graph scopes.
- Business Central goes through the same app. A client company's admin may have to approve the app once.

**Other services that need "your own app"** (Settings > Developer apps): HubSpot, Salesforce, Xero,
QuickBooks, Jobber, and Meta (Facebook Pages, Instagram, Threads).

- **Setup:** the user pastes a client ID and secret; "Check it" tests them without creating anything; each account is
  then a connection of a client.
- **Return address:** vendors that insist on https come back through a static page on
  `https://yushkin.us/ringkeeper/oauth/callback`, which forwards to the app on port 17845.
- **Servers that don't allow registration** (ElevenLabs) get a client ID metadata document hosted at
  `https://yushkin.us/ringkeeper/oauth/client.json`.

**Everything else:**

- 46 official remote servers, most of them self-registering ("DCR").
- About 30 vendors in its own code: Pipedrive, Keap, Jobber, Housecall Pro, ServiceTitan, QuickBooks, Xero,
  Wave, BILL, Shopify, Ghost, Square, Helcim, Lemon Squeezy, Clover, Braintree, Plaid, Bluesky,
  Facebook, Instagram, Threads, Google Ads, PageSpeed, Clerk and others.
- Built-in connections: Postgres/Supabase/Neon databases, mailboxes over IMAP/SMTP, S3/R2 storage, "any
  HTTP API", and Oracle.
- Four cloud command-line programs: AWS, Azure, Google Cloud and OCI.
- Installing from the MCP registry.

## 2. What it means for Ringkeeper Connect

Ringkeeper Connect is a gateway: it doesn't have tool code of its own, it passes tools on from
servers and programs. Two building blocks close most of the gap.

**A. A built-in tools program.** This is a program shipped with the app, like the bridge, that holds Ringkeeper's
proven integrations, ported from Python to TypeScript. The gateway starts one copy per connection and hands it that
client's access token.

- The groundwork is done: direct sign-in with a registered app, renewal before expiry, and passing the token to a
  program (the Microsoft 365 work, not merged).
- It unlocks Google's 8 products and Microsoft's Outlook, OneDrive and SharePoint, and later any of Ringkeeper's
  own-code vendors.

**B. Sign-in plumbing, as in Ringkeeper:**

- registered apps: ours by default, plus "use your own app" for agencies that hit the 100-account cap or want their
  own branding;
- a hosted https return page for HubSpot, Salesforce, Xero and QuickBooks;
- a client ID metadata document for servers that don't allow registration (ElevenLabs on the web, Vercel; Canva and
  others are moving there).

### Google: official servers or Ringkeeper's code?

| | Google's MCP servers (PR #29) | Port Ringkeeper's Google code |
| --- | --- | --- |
| Status | Developer Preview; your project must be accepted into the program | Google's normal, stable APIs |
| Gmail | Read and drafts only | Read, send, drafts, trash |
| Also | Drive, Docs, Sheets, Calendar | Same, plus Search Console, Analytics, YouTube (and later Ads) |
| Work | Done (tiles and sign-in) | Port about 1,400 lines of proven code into the tools program |
| Sign-in | Our registered app | Same, reused |

**Recommendation:** port Ringkeeper's. It already works for real clients, and it covers sending email and the
marketing products agencies use. Keep PR #29's sign-in work, which both options need. Swap the five Google tiles to
the built-in program once it's ported. Until then, they stay behind the Developer Preview.

### One Google app for everyone hits the 100-account cap

An unverified Google app can sign in only 100 accounts in its lifetime, across all users. One "Ringkeeper Connect"
app shared by every agency would run out fast. Options:

1. Ours, published, for you and the first pilot clients. That's the same as Ringkeeper today.
2. "Use your own Google app" for agencies (Ringkeeper's model), with the same steps Ringkeeper shows.
3. Google verification of our app. The Gmail and Drive scopes are "restricted", so this means a yearly paid
   security assessment. It removes the cap and the warning.

**Recommendation:** 1 and 2 now, 3 when there are paying users. Change the registration doc from "testing" to
**publish**, which ends the 7-day sign-outs. Add home and privacy pages at
`yushkin.us/ringkeeper-connect`.

## 3. Integration by integration

**Already in Ringkeeper Connect:**
- Airtable, Apify, Apollo, Atlassian, Cal.com, Calendly, Canva, Close, ElevenLabs (program), GitHub, GoHighLevel;
- Klaviyo, Leadfeeder, Linear, Make, monday.com, n8n, Neon, Netlify, Notion, PayPal, Pipedrive, Resend, Retell AI;
- Stripe, Supabase, Tavily, Trello, Twilio, Upwork, Webflow, Wix, WordPress.com, WordPress (own site), Zapier;
- bringing in connections from Claude Desktop and 18 other AI apps.

**Quick to add: official servers, catalog tiles only.**

| Service | Server | Sign-in |
| --- | --- | --- |
| Sentry | `https://mcp.sentry.dev/mcp` | Sign in, or token (`Sentry-Bearer`) |
| Cloudflare | `https://mcp.cloudflare.com/mcp` | Sign in, or API token |
| PostHog | `https://mcp.posthog.com/mcp` | Sign in |
| Attio | `https://mcp.attio.com/mcp` | Sign in |
| FreshBooks | `https://mcp.freshbooks.com/v1` | Sign in (read-only for now) |
| Zoho Books | `https://claude-zohobooks.zohomcp.com/mcp/message` | Sign in (US) |
| Zoho CRM | per-user address from Zoho (holds the key) | The address |
| Odoo | `<database>/mcp` | Sign in (Odoo 20 / saas-19.4) |
| Sanity | `https://mcp.sanity.io` | Sign in |
| Contentful | `https://mcp.contentful.com/mcp` (EU: `mcp.eu.contentful.com`) | Sign in |
| Strapi | `<site>/mcp` | Admin API token (Strapi 5.47+) |
| Payload | `<site>/api/mcp` | API key |
| Mollie | `https://mcp.mollie.com/mcp` | Sign in |
| Paddle | `https://mcp.paddle.com/mcp` | Sign in |
| GoCardless | `https://mcp.gocardless.com` | Sign in |
| Meta Ads (Pipeboard) | `https://mcp.pipeboard.co/meta-ads-mcp` | Sign in (third party; free tier 30 calls a week) |

Also key or token options next to sign-in: Supabase token, Airtable token, Notion token (Business and
Enterprise), Linear API key.

**Needs the built-in tools program, with a registered app** (in this order):
- Google account (8 products);
- Microsoft 365, then Business Central;
- HubSpot, Salesforce, Xero and QuickBooks (with the hosted return page);
- Facebook Pages, Instagram, Threads and Meta Ads (Meta's app review);
- Google Ads.

**Needs the built-in tools program, with keys only** (port as clients ask):
- Keap, Jobber, Housecall Pro, ServiceTitan, Wave, BILL, Shopify, Ghost, Square, Helcim;
- Lemon Squeezy, Clover, Braintree, Plaid, Bluesky, Clerk, Vercel, PageSpeed Insights;
- mailboxes over IMAP/SMTP, databases (Postgres/Supabase/Neon, Oracle), S3/R2 storage, "any HTTP API".

**Skip for agency owners** (as decided earlier):
- AWS, Azure, Google Cloud and OCI command-line programs (developer tools);
- installing from the MCP registry ("no registry search").

## 4. Suggested order

1. **Catalog:** the 16 official servers above, plus the extra key options. Small, and a quick beta.
2. **Built-in tools program + Google**, ported from Ringkeeper:
   - the sign-in reuses PR #29's work;
   - publish our Google app;
   - add "use your own Google app".
3. **Microsoft 365** in the same program: Ringkeeper's Graph code, Outlook, OneDrive and SharePoint.
4. **Hosted return page**, then HubSpot, Salesforce, Xero and QuickBooks. Then Meta.
5. **The other own-code vendors**, one per request.
