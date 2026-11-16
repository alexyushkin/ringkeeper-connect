# Ringkeeper Connect

The full product spec is in [docs/SPEC.md](docs/SPEC.md). Read it before starting any milestone.

## Stack

- Electron + TypeScript, electron-builder, electron-updater (GitHub Releases)
- Official MCP TypeScript SDK
- pnpm monorepo: `apps/desktop`, `packages/gateway`, `packages/bridge`, `packages/catalog`
- Secrets go through Electron `safeStorage`. Never write a secret to plain JSON, logs or error messages.

## UX rules (apply to every string a user can see)

- Users are non-technical agency owners. Nothing may require a terminal, Docker, Node or Python.
- No jargon. Say "connection", not "MCP server"; never show "gateway", "stdio", "transport", "JSON" or "port".
- Errors are plain language and suggest a fix ("Couldn't reach n8n for Acme. Check the key in Acme > n8n.").

## Editing other apps' config files

This code can break Claude Desktop, Cursor or Claude Code, so:

- Only touch the `mcpServers` section. Preserve every other key, and key order where possible.
- Write atomically (temp file + rename) and keep a timestamped backup before every change.
- If the file is missing, unreadable or not valid JSON, do nothing and tell the user; never overwrite it.
- Every change to import, move, watch or restore logic needs tests (fixtures for each host app's real file shapes).

## Working rules

- Work milestone by milestone (see the spec) and report results before moving on.
- Verify host config paths and behaviour against current docs before relying on them.
