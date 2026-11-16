# M2 results: clients, switching, keys

Date: 2026-11-16.

## Decisions (recorded in the spec)

- **AI apps may switch the client**, and Ringkeeper shows a notification naming the app ("Claude Desktop switched the active client…"). The tray updates.
- **SDK**: stay on `@modelcontextprotocol/sdk` v1 for v1.0. Revisit v2 before M5.
- **Client argument** (`ringkeeper_client`): on by default, with a checkbox to turn it off.

## What was built

### Clients and keys (`packages/gateway/src/store/`)
- `ClientStore` (`clients.json`): add, rename (ids stay the same, so tool names and saved keys stay stable), delete, switch, and add/edit/remove connections.
  - Copying a connection to another client takes the settings but never the keys. The copy shows "Needs a key" until it gets its own.
  - Connections are either a web address (preferred) or a program on this computer.
  - The store refuses to overwrite a clients file it can't read, and refuses `http://` addresses that would send keys unencrypted.
- `SecretStore` (`secrets.json`): every key is encrypted with Electron `safeStorage`. Key values are never sent back to the window. If secure storage is unavailable, saving a key fails with a plain message and nothing is written.

### Gateway (`packages/gateway`)
- **Starts connections on demand.** Only the active client's connections run. Another client's connections stop after 10 min unused and restart when needed.
- **Applies changes live.** Adding, editing or removing clients, connections or keys takes effect without a restart. Connections whose settings didn't change keep running.
- **Remote connections** over Streamable HTTP, with keys sent as headers.
- **Plain-language problems**, written for the person and the model alike:
  - "n8n for Globex needs N8N_API_KEY. Add it in Ringkeeper Connect under Globex > n8n."
  - "Notion for Initech didn't accept the key…"
  - "the program … isn't on this computer"

  The model is also told "Nothing was run. Don't use another connector for Globex's data instead."
- **Keys are blanked out in the log**, even when a connection prints them (tested).
- **Idle host sessions expire** after 30 min. Claude Code and Cursor never close theirs, which was M1 finding 3.
- Reports who switched clients (the app, or which AI app) so the desktop app can notify.
- Works with zero clients ("No clients are set up yet. Add one in Ringkeeper Connect.").

### Bridge (`packages/bridge`)
- **Reconnects by itself** when Ringkeeper Connect restarts, even on a new port. It replays the AI app's handshake and tells the app its tools may have changed. This was M1 finding 6.
- **Starts the real app** in the background, using the launch info the app writes on every start (`launcher.json`).

### Desktop app (`apps/desktop`, Electron 45 + React 19)
- The main process owns the store and the keys and hosts the gateway. It writes the runtime and launcher files and allows only one copy of the app to run.
- **Tray / menu bar:**
  - "Working on: Acme"
  - one radio item per client
  - the active client's connection statuses
  - Manage clients…
  - Quit
- Closing the window keeps the app running in the tray.
- **Clients window:**
  - add, rename and delete clients
  - switch to a client
  - add and edit connections ("With a web address the service gave you", or "With a program on this computer (advanced)")
  - keys and settings, each with a "Keep secret" box that is ticked automatically for names like `*_KEY`/`TOKEN`; saved keys show as "Saved. Type to replace"
  - "Copy to…" another client with its own key fields
  - live status for each connection: Ready / Starts when needed / Needs a key / Not working, with the reason
  - a settings checkbox for the client argument
- Security: context isolation, sandboxed preload, no Node in the window, a strict CSP, no navigation or new windows. The window only gets a small typed API, and every call returns a plain-language result.

## Verified

- **58 automated tests** (`pnpm test`): store and keys (17), M2 gateway (13), bridge reconnect (2), plus the M1 and fixed-mode suites.
- **In the running app (Windows):**
  - Added clients Acme and Globex.
  - Added an n8n connection with a key, which showed "Ready".
  - Copied it to Globex without a key, which showed "Needs a key".
  - The key isn't present in plain text in any file in the data folder.
  - After a restart, the key was read back from secure storage and n8n was Ready again.
  - An AI-app switch updated the window live.
- **Launch path:** with the app closed, a host connected through the bridge. The bridge started Ringkeeper Connect in the background (no window), the host switched to Globex, and the log shows the notification was shown ("Claude Desktop switched…").

## Not verified yet

- Seeing the tray menu and the notification myself: my screenshots can't capture Windows' own UI. The log confirms the notification was shown.
- macOS (menu bar icon, Keychain prompt for safeStorage).
- The Claude Desktop retest of fixed mode with the new routing wording (carried over from M1).

## Notes for later milestones

- M3: the wizard writes host config entries that point at the bridge (`apps/desktop/dist/bridge.mjs`, run by the bundled Node). It also creates the "Default" client on import.
- M4: the manual connection form stays as the advanced path once the catalog exists.
- M5:
  - Real icon (the current ring is a placeholder).
  - Hide the macOS dock icon while the window is closed.
  - Packaging, which must keep `userData` fixed: safeStorage's key lives there.
