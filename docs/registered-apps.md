# Ringkeeper Connect's own registered apps (Google, Microsoft)

Google and Microsoft only let apps registered with them in advance sign in (Ringkeeper works the same way). Ringkeeper Connect
registers once, under your accounts; your users then just sign in, per client, with whichever
account each client uses (the same one for several clients, or a different one each).

You do the registrations (they need your sign-in and stay yours). Then put the IDs into GitHub as
shown at the end; the release builds pick them up. Never paste a client secret into a chat, an
issue or the code.

## Google (Gmail, Drive, Calendar, Sheets, Docs, Search Console, Analytics, YouTube)

Ringkeeper Connect calls Google's regular APIs, as Ringkeeper does, so no preview program is needed.
These are the same steps Ringkeeper shows its users.

1. **Create a project** at <https://console.cloud.google.com/projectcreate>, named
   "Ringkeeper Connect".
2. **Turn on the APIs** (APIs & Services > Library, search each, Enable), or in Cloud Shell:

   ```
   gcloud services enable gmail.googleapis.com drive.googleapis.com calendar-json.googleapis.com sheets.googleapis.com docs.googleapis.com searchconsole.googleapis.com analyticsdata.googleapis.com analyticsadmin.googleapis.com youtube.googleapis.com youtubeanalytics.googleapis.com --project=YOUR_PROJECT_ID
   ```

3. **Branding** (Google Auth Platform > Branding > Get started):
   - App name: Ringkeeper Connect. Support email: yours.
   - App home page: `https://yushkin.us/ringkeeper-connect`. Privacy policy:
     `https://yushkin.us/ringkeeper-connect/privacy`. Authorized domain: `yushkin.us`. (Google won't
     publish without these. Both pages need to exist; Ringkeeper's are at `/ringkeeper` and
     `/ringkeeper/privacy`.)
   - Audience: **External**. Contact email: yours. Accept the policy, Create.
4. **Data access** > Add or remove scopes > "Manually add scopes", paste, Add to table, Update, Save:

   ```
   openid
   https://www.googleapis.com/auth/userinfo.email
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/gmail.send
   https://www.googleapis.com/auth/gmail.compose
   https://www.googleapis.com/auth/gmail.modify
   https://www.googleapis.com/auth/drive.file
   https://www.googleapis.com/auth/drive.readonly
   https://www.googleapis.com/auth/calendar.events.readonly
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/spreadsheets.readonly
   https://www.googleapis.com/auth/spreadsheets
   https://www.googleapis.com/auth/documents.readonly
   https://www.googleapis.com/auth/documents
   https://www.googleapis.com/auth/webmasters.readonly
   https://www.googleapis.com/auth/analytics.readonly
   https://www.googleapis.com/auth/youtube.readonly
   https://www.googleapis.com/auth/youtube.upload
   https://www.googleapis.com/auth/youtube.force-ssl
   https://www.googleapis.com/auth/yt-analytics.readonly
   ```

   Each sign-in asks only for what's ticked for that account, so most clients see a short list.
5. **Create the client** (Google Auth Platform > Clients > Create client): Application type
   **Desktop app**, name Ringkeeper Connect, Create. Copy the **Client ID** (ends in
   `.apps.googleusercontent.com`) and **Client secret**. No redirect address is needed: a desktop
   client returns to the computer itself, on any port.
6. **Publish** (Audience > **Publish app**). Left in "Testing", Google signs every account out after
   7 days and only listed test users can sign in.

**Unverified, published:** people see Google's warning and click "Advanced > Go to Ringkeeper
Connect (unsafe)", and the app can sign in **100 accounts in its lifetime**, across everyone using
it. That's fine for you and the first clients. For more: agencies use their own Google app (the
same steps, in their own project, pasted into Ringkeeper Connect under "Your own Google apps"), or Ringkeeper Connect's app goes
through Google's verification (Gmail and Drive access are "restricted": a yearly paid security
assessment). A client's Workspace admin may also have to trust the app's client ID.

## Microsoft 365 (Outlook mail and calendar, OneDrive, SharePoint)

Free, a few minutes, no assessment. Same as Ringkeeper's, except Ringkeeper Connect's app has no
client secret (it's a "public client": the app runs on people's computers, where a secret couldn't
be kept) and comes back to the computer on any port.

1. Go to <https://entra.microsoft.com> > Identity > Applications > **App registrations** > New
   registration.
   - Name: Ringkeeper Connect.
   - Supported account types: **"Accounts in any organizational directory and personal Microsoft
     accounts"**.
   - Redirect URI: platform **"Public client/native (mobile & desktop)"**, address
     `http://localhost/callback`. Register.
2. **Authentication**: under "Mobile and desktop applications" also add
   `http://127.0.0.1/callback` (that's the address the app actually comes back to; Microsoft
   ignores the port for these, but the `/callback` path has to match). If the box refuses it,
   open **Manifest** and add `{ "url": "http://127.0.0.1/callback", "type": "InstalledClient" }`
   to `replyUrlsWithType`, then Save. Set **"Allow public client flows"** to Yes. Save. (No client
   secret: this app runs on people's computers, where a secret couldn't be kept.)
3. **API permissions** > Add a permission > Microsoft Graph > **Delegated**: `openid`, `profile`,
   `email`, `offline_access`, `User.Read`, `Mail.Read`, `Mail.Send`, `Mail.ReadWrite`,
   `Calendars.Read`, `Calendars.ReadWrite`, `Files.Read.All`, `Files.ReadWrite.All`,
   `Sites.Read.All` (finding SharePoint sites). Each sign-in asks only for what's ticked for that
   account. Don't click "Grant admin consent" (that's only for your own organisation).
4. Copy the **Application (client) ID** from Overview.

**Later (optional, recommended before a public release):** Branding > publisher verification with a
Microsoft Partner Network ID, so the sign-in screen shows Ringkeeper Connect as verified. Some
companies only allow verified apps, and some require their IT admin to approve any new app once.

## Put the IDs into GitHub

In the repository: Settings > Secrets and variables > Actions.

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `RINGKEEPER_GOOGLE_CLIENT_ID` | Google Client ID |
| Secret | `RINGKEEPER_GOOGLE_CLIENT_SECRET` | Google Client secret |
| Variable | `RINGKEEPER_MICROSOFT_CLIENT_ID` | Microsoft Application (client) ID |

To try a development build on your computer, set the same three names as environment variables
before starting it.
