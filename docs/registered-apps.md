# Ringkeeper Connect's own registered apps (Google, Microsoft)

Google and Microsoft only let apps registered with them in advance sign in. Ringkeeper Connect
registers once, under your accounts; your users then just sign in, per client, with whichever
account each client uses (the same one for several clients, or a different one each).

You do the registrations (they need your sign-in and stay yours). Then put the IDs into GitHub as
shown at the end; the release builds pick them up. Never paste a client secret into a chat, an
issue or the code.

## Google (Gmail, Drive, Docs, Sheets, Calendar)

Google's own servers for these are in "Developer Preview": you need to be in that program, and the
app runs in "testing" mode until Google verifies it.

1. **Join the Workspace Developer Preview Program** with the Google account you'll use for the
   project: <https://developers.google.com/workspace/preview>. Wait for the acceptance email.
2. **Create a project** at <https://console.cloud.google.com/projectcreate>, named
   "Ringkeeper Connect".
3. **Turn on the services** (APIs & Services > Library, search each, Enable), or in Cloud Shell:

   ```
   gcloud services enable gmail.googleapis.com drive.googleapis.com docs.googleapis.com sheets.googleapis.com calendar-json.googleapis.com gmailmcp.googleapis.com drivemcp.googleapis.com docsmcp.googleapis.com sheetsmcp.googleapis.com calendarmcp.googleapis.com --project=YOUR_PROJECT_ID
   ```

4. **Sign-in screen** (Google Auth Platform > Branding > Get started):
   - App name: Ringkeeper Connect. Support email: yours.
   - Audience: **External** (your clients' accounts are outside your organisation).
   - Contact email: yours. Accept the policy, Create.
   - Audience > **Test users**: add your own account and each account you'll test with (up to 100
     while in testing).
   - Data Access > Add or remove scopes > "Manually add scopes", paste all of these, Add to table,
     Update, Save:

     ```
     https://www.googleapis.com/auth/gmail.readonly
     https://www.googleapis.com/auth/gmail.compose
     https://www.googleapis.com/auth/gmail.modify
     https://www.googleapis.com/auth/drive.readonly
     https://www.googleapis.com/auth/drive.file
     https://www.googleapis.com/auth/documents.readonly
     https://www.googleapis.com/auth/documents
     https://www.googleapis.com/auth/spreadsheets.readonly
     https://www.googleapis.com/auth/spreadsheets
     https://www.googleapis.com/auth/calendar.calendarlist.readonly
     https://www.googleapis.com/auth/calendar.events.freebusy
     https://www.googleapis.com/auth/calendar.events.readonly
     https://www.googleapis.com/auth/calendar.events
     ```

5. **Create the client** (Google Auth Platform > Clients > Create client):
   - Application type: **Desktop app**. Name: Ringkeeper Connect.
   - Tick **"Use this client for an AI-powered agent"** (required for these servers).
   - Create. Copy the **Client ID** and **Client secret**. (No redirect address is needed: a
     desktop client returns to the computer itself.)

**While in testing:** only the test users can sign in, Google shows an "unverified app" warning,
and sign-ins expire after 7 days (Ringkeeper Connect will ask to sign in again). Gmail and Drive
access are "restricted" scopes: to go public, the app needs Google's verification, including a
yearly paid security assessment. Gmail's server can draft but not send.

## Microsoft 365 (Outlook, OneDrive, SharePoint, Excel, Teams)

Free, a few minutes, no assessment.

1. Go to <https://entra.microsoft.com> > Identity > Applications > **App registrations** > New
   registration.
   - Name: Ringkeeper Connect.
   - Supported account types: **"Accounts in any organizational directory and personal Microsoft
     accounts"**.
   - Redirect URI: platform **"Public client/native (mobile & desktop)"**, address
     `http://localhost`. Register.
2. **Authentication**: under "Mobile and desktop applications" also add `http://127.0.0.1`.
   Set **"Allow public client flows"** to Yes. Save. (No client secret: this app runs on people's
   computers, where a secret couldn't be kept.)
3. **API permissions** > Add a permission > Microsoft Graph > **Delegated**: `offline_access`,
   `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Contacts.ReadWrite`,
   `Files.ReadWrite.All`, `Sites.ReadWrite.All`, `Tasks.ReadWrite`. Don't click "Grant admin
   consent" (that's only for your own organisation).
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
