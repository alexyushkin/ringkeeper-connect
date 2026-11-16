# M1 spike

Throwaway harness for the M1 questions: does the gateway + bridge work in each
host, and does each host honour `tools/list_changed`? Results go in
[docs/m1-results.md](../docs/m1-results.md).

The spike uses two fake clients, served by `fixture-server.ts`:

| Client | Connections | Tools the host should see |
| --- | --- | --- |
| Acme | n8n | `n8n_main__list_workflows`, `n8n_main__get_workflow` |
| Globex | n8n, Airtable | the two above **plus** `airtable_main__list_bases` |

`airtable_main__list_bases` only exists for Globex. That's how we tell
whether a host refreshed its tool list after a switch. Every result starts with
`[Client: … · …]`, and the fake data contains the client's name.

## Setup (once)

```bash
pnpm install
```

```bash
pnpm build
```

```bash
pnpm spike start
```

```bash
pnpm spike configs
```

`pnpm spike state` shows the active client and connected hosts.
`pnpm spike switch acme` (or `globex`) switches the active client the way the
tray will. The log of what each host did is at `spike/.data/gateway.log`.

## Claude Code (automated)

```bash
node spike/run-claude-code.mjs
```

Add `--fixed` to force fixed mode (what Claude Desktop gets), `--model haiku` to
change model. It runs headless with `--strict-mcp-config`, so your own Claude Code MCP
setup is neither read nor changed.

## Cursor (manual, about 5 minutes)

1. Run `pnpm spike switch acme`.
2. In Cursor, choose **File > Open Folder** and open `spike/out/cursor-http`.
   When Cursor offers to enable the `ringkeeper-spike` server, enable it. You
   can also do this in Settings > MCP.
3. In a new Agent chat, send these three messages, one at a time:
   1. `Using the ringkeeper tools, list the n8n workflows.`
   2. `Switch to the client Globex, then list Globex's Airtable bases.`
   3. Run `pnpm spike switch acme` in a terminal, then send
      `List the n8n workflows again, and the Airtable bases if you still have a tool for that.`
4. Repeat steps 1–3 with the folder `spike/out/cursor-bridge`. Close the first
   folder first, so the tools don't appear twice.

Then tell Claude "Cursor done". The answers are read from the gateway log.

## Claude Desktop (manual, about 5 minutes)

Adding the spike entry edits `claude_desktop_config.json`. A backup goes to
`spike/.data/backups/`, and only the `ringkeeper-connect-spike` entry is added
or removed.

1. Run `pnpm spike switch acme`, then `pnpm spike desktop-add`.
2. Quit Claude Desktop fully (tray icon > Quit), then reopen it. The bridge
   starts the gateway by itself if it isn't running.
3. In a new chat, send the same three messages as in the Cursor steps. For
   the third, switch with `pnpm spike switch acme` first.
4. Open a **second** chat and ask `Which client is active?`. Switching is
   app-wide, so it should say Acme.
5. Run `pnpm spike desktop-remove`, then quit and reopen Claude Desktop.

Then tell Claude "Desktop done".
