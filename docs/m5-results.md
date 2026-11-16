# M5 results: tray, packaging, CI, signing, auto-update, README

Date: 2026-11-16.

## What was built

### Packaging (`apps/desktop/electron-builder.config.cjs`)
- **Windows:** a one-click, per-user NSIS installer (no admin prompt) with desktop and Start menu shortcuts, which starts the app when done.
- **macOS:** dmg + zip for Apple silicon and Intel. The hardened runtime is on, with entitlements for the JIT the app and the bundled Node need, and for native add-ons that `npx` downloads.
- **What ships:**
  - the bundled app (`dist/`, 15 files, **1.9 MB**)
  - the bridge, and that platform's Node and uv, under `resources/`
  - English only: Chromium's other language packs would add about 48 MB
  - The Windows installer is **153 MB**, most of it Electron itself.
- **Uninstall runs Restore.** The guard: electron-builder's uninstaller **also runs during every automatic update**. Without the guard, each update would restore the AI apps' settings and silently disconnect everything. `build/installer.nsh` skips Restore when it's an update.
- **Slimmer runtimes:** Node's headers, docs and corepack are dropped (about 50 MB on macOS; little on Windows).
- **Fixed during this milestone:** electron-builder was packing the whole workspace's dependencies (3,000 files) into the app. Everything is bundled already, so the workspace's packages are now build-time only and `node_modules` is excluded.

### Signing (only when secrets are present; forks build unsigned)
- **Windows:** Azure Artifact Signing, with the **same secret and variable names as the `ringkeeper` repo** (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and the variables `AZURE_SIGNING_ENDPOINT`/`ACCOUNT`/`PROFILE`, plus `WIN_PUBLISHER_NAME`), or a .pfx (`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`).
- **macOS:** a Developer ID certificate (`CSC_LINK`/`CSC_KEY_PASSWORD`) and notarization (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Unsigned macOS builds can't update themselves, which is a macOS rule.
- Each release job says in its log whether that build is signed.

### Auto-update and tray
- **Updates:**
  - The app checks GitHub Releases 30 s after starting and every 6 hours.
  - Updates download in the background and install on the next restart.
  - A notification says when one is ready, and the tray and window offer "Restart to update".
  - Failures (offline, no releases yet) are only logged.
- **Tray / menu bar:**
  - "Working on: X" and a client switcher
  - connection statuses
  - "Fix N connections…" when something needs attention
  - Manage clients…
  - Check for updates / Restart to update
  - **Start when I log in** (on by default; also in the window)
  - Version
  - Quit
- **macOS:** a black template menu-bar icon made from the Ringkeeper tray icon (`scripts/make-tray-template.mjs`). The Dock icon shows only while the window is open.
- **On every start**, each connected AI app's entry is refreshed if the app was moved or updated to a new place. It's only written when it differs.

### Look
- **Colours from the logo:** the ring's blue (`#019DFC` → `#0472FB`) for accents and primary buttons, the keys' purple for service tags, and in dark mode the tile's navy.
- The window follows the system's light or dark setting.
- `RINGKEEPER_THEME=light|dark` overrides it, for screenshots.

### CI (`.github/workflows/`)
- `ci.yml`, on pushes to main and on PRs:
  - Windows and macOS: install, fetch and verify runtimes, type check, 110 tests.
  - Then an unsigned packaging smoke test on both, which checks the packaged app contains the bridge and the runtimes.
- `release.yml`, on `v*` tags:
  - tests, plus a check that the tag matches the app's version
  - a Windows installer
  - one macOS job building both architectures, so the update feed lists both
  - published to GitHub Releases
- Actions are pinned to the same commits as the `ringkeeper` repo.

### README
- Leads with the core idea, then install steps, screenshots and the contact links (yushkin.us, LinkedIn). Then how it works, and building from source.
- The screenshots are in the new colours: clients, the catalog, setup, and dark mode, all showing made-up data.

## Verified (Windows)
- 110 tests pass.
- **Packaged app, unpacked build, against a fake user folder:**
  - It finds the bundled Node and uv, and setup writes entries pointing at `resources\runtimes\node\node.exe` + `resources\bridge.mjs`.
  - A client connecting through that exact entry, as Claude Desktop would, ran an n8n tool on the bundled Node.
  - `--restore` against the packaged app put all three fake apps back.
  - The update check reached GitHub and logged "No published versions" quietly.
- The full installer builds unsigned, with `latest.yml` for updates.

## Not verified yet
- **CI and release workflows:** they haven't run yet; they will on the next push to the PR.
- **Installing and uninstalling the real installer** (including Restore on uninstall and an update with its guard). Test runs never register at login, but a real install would. It should be tried in a clean Windows VM or user account, not on a development machine.
- **Signing and notarization:** none of the secrets are set in this repo yet.
- **macOS:** packaging, menu bar icon, Dock behaviour, Keychain, and anything else, since there's no Mac here. The CI macOS jobs will be the first check.
