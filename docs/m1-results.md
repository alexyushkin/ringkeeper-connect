# M1 spike results

Date: 2026-11-16. Harness and repro steps are in [spike/README.md](../spike/README.md). The raw evidence is the gateway log (`spike/.data/gateway.log`, not committed), which records every request each host sent.

## What was built

- **Gateway** (`packages/gateway`): Streamable HTTP on 127.0.0.1, with a bearer token picked once per install. The port is picked once per install and kept; if it's taken, the gateway falls back to a free port. A runtime file holds the port and token in use.
  - Proxies stdio upstreams per client.
  - Tool names are prefixed `conn__tool`, and every result is labelled `[Client: X · Service]`.
  - Refuses tools that aren't in the active client.
  - Optional required client argument.
  - Two tool modes, chosen per host (below).
- **Bridge** (`packages/bridge`): stdio ↔ HTTP shim, bundled into one `.mjs` that runs on plain Node.
  - Finds the gateway through the runtime file and starts it if it isn't running.
  - If it can't reach the gateway, it serves a plain-language "Ringkeeper Connect isn't running" notice.
- **Tests**: 26 (`pnpm test`). They use the real bundles, real fixture servers and a real bridge process.

## Results by host

| | Claude Code 2.1.325 | Cursor (`cursor-vscode` 1.0.0) | Claude Desktop |
| --- | --- | --- | --- |
| Connects via direct HTTP | ✅ | ✅ | n/a (stdio only) |
| Connects via bridge | ✅ | ✅ | ✅ |
| Re-fetches tools after `ringkeeper_use_client` in the same chat | ✅ | ✅ | ❌ |
| Re-fetches tools after a tray switch | ✅ | ✅ | ❌ |
| New chat sees the new client's tools | ✅ | ✅ | ❌ (list loaded only at app start) |
| **Mode used** | dynamic | dynamic | **fixed** |

### Claude Desktop: doesn't honour `list_changed`, so it gets fixed mode

From the manual test and the log:

- Claude Desktop opens **two** connections to each local server:
  - `claude-ai`, which did re-fetch the tool list when told it changed;
  - `local-agent-mode-<server name>`, which never re-fetched it.
- Chat tool calls went through the second one. So after switching to Globex, neither the open chat nor a new chat ever got `airtable_main__list_bases`. The tool list is effectively fixed at app start.
- **Worse:** in the new chat, with the Ringkeeper tool missing, Claude used **the user's own built-in Airtable connector** and searched the user's own account for "Globex". When a Ringkeeper tool is missing, the model reaches for any connector for the same service.

What changed in response:

1. **Fixed mode is now the default for Claude Desktop and any host not verified.**
   - Hosts identify themselves when they connect. Only `claude-code` and `cursor-vscode` get dynamic mode, and that list is a setting.
   - In fixed mode the tool list never changes: `ringkeeper_list_clients`, `ringkeeper_use_client`, `ringkeeper_search_tools`, `ringkeeper_call_tool`.
   - `ringkeeper_call_tool` takes client + tool + arguments, and the client must be the active one.
2. **Every model-facing text keeps client work inside Ringkeeper.** That covers server instructions, meta tool descriptions, proxied tool descriptions and "no such tool" errors. Each one says all work on the user's clients (named) goes through Ringkeeper Connect, and never through another connector for a client's data, even one for the same service.
3. **The M3 wizard warns about overlapping connectors** (added to the spec): e.g. "You also have Airtable connected directly in Claude…".

**Fixed mode checked with real models** (Claude Code forced into fixed mode, Opus 5.5 and Haiku 5.5, 6 runs): 6/6 correct.
- Both models used search → call, or call directly with the name from `ringkeeper_use_client`'s reply. Neither used another tool.
- After a tray switch, both models first called `ringkeeper_call_tool` with a stale `client: "Acme"`. The gateway refused it and nothing ran.
  - Opus stopped and told the user the client had changed.
  - Haiku re-ran it for Globex and said the results were Globex's.

This still needs one retest in Claude Desktop itself (switch, then new chat, then check that it searches through Ringkeeper and doesn't touch the built-in Airtable connector). That retest belongs to M2, once the routing wording is final.

### Cursor: honours `list_changed`, over HTTP and over the bridge

From the log:
- Over HTTP and over the bridge alike, Cursor held a listening stream open and re-fetched `tools/list` within milliseconds of both an in-chat switch and a tray switch.
- It called `airtable_main__list_bases` only while Globex was active.
- It also advertises MCP Apps UI support (`io.modelcontextprotocol/ui`), like Claude Desktop.

### Claude Code (Opus 5.5 and Haiku 5.5, 21 dynamic-mode runs + 6 fixed-mode)

- **Tool swapping works**, over both direct HTTP and the bridge. Claude Code defers MCP tools behind its ToolSearch, so after a switch the model searches for the new tool, finds it and calls it.
- **Labels work.** After a tray switch between turns, Opus told the user unprompted that the results were Globex's, not Acme's.
- **Client argument (`ringkeeper_client`):**
  - Plain request: filled correctly in 6/6 runs.
  - User names a client that isn't active: 6/6 runs switched first. No wrong-client calls.
  - Tray switched between turns: **Haiku** called `get_workflow` with `ringkeeper_client: "Acme"` while Globex was active. The gateway refused it ("Nothing was run"). Without the argument, that call would have run against **Globex's** n8n. **Opus** noticed the switch and asked first.
  - Recommendation: **on by default** (the fixed-mode `client` field is always required already). To confirm in M2.

## Bugs and design findings

1. **Notices were dropped (fixed).** If a host hadn't opened its listening stream yet, the SDK silently dropped the "tools changed" notice. The gateway now:
   - holds the notice and delivers it when the stream opens or with the next tool reply,
   - and always sends it inline with the reply to `ringkeeper_use_client`.
2. **Calls during startup were refused (fixed).** A tool call that arrived before its connection finished starting was refused. Calls and tool-name lookups now wait up to 10 s.
3. **Sessions leak (M2).** Claude Code over HTTP never ends its session. Cursor opened two sessions on enabling the server and never closed them. The gateway needs to expire idle sessions.
4. **Model-initiated switches override the tray (M2 decision).** Haiku switched the app-wide client by itself to recover from a refusal, which silently changes every chat. Options:
   - show a tray notification when an AI app switches the client, or
   - ask for confirmation the first time.
5. **SDK version (M2 decision).** The spike uses `@modelcontextprotocol/sdk` 1.32.2. The v2 line (`@modelcontextprotocol/server`/`client` 2.4.0, 2026-07-28 spec) is now the stable release, but its Node HTTP adapter lags at 2.1.2. Decide in M2 whether to move now, while the gateway is small.
6. **Bridge doesn't reconnect (M2).** If the gateway restarts (for example on an app update), the bridge's session ends and the host has to restart it. The bridge should re-initialise transparently.
