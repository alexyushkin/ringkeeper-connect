// ringkeeper_help: what an AI app reads to answer questions about Ringkeeper
// Connect itself. A guide in plain words, the catalog's advice for the services
// a question names, and what's set up on this computer right now.
//
// It must never contain a key: only names, statuses, the plain problem text the
// window shows, and the catalog's public notes and links.
import { catalog, type CatalogService } from "@ringkeeper/catalog";
import { detectService } from "@ringkeeper/hostconfig";
import type { ClientView, ConnectionStatus, ConnectionView, HostView, UpdateState } from "../shared/api.js";
import { updateStatusText } from "../shared/api.js";
import { RESTORE_POINTS } from "../renderer/restore-text.js";

export interface HelpInput {
  question: string;
  /** The AI app asking, by the name people know. */
  host: string;
  clients: ClientView[];
  statuses: ConnectionStatus[];
  hosts: HostView[];
  version: string;
  update?: UpdateState;
  packaged: boolean;
  settings: { requireClientArg: boolean; startAtLogin: boolean };
  services?: CatalogService[];
}

/** The most services described in one answer, so a vague question doesn't return the whole catalog. */
export const MOST_SERVICES = 6;

const STATUS_WORDS: Record<string, string> = {
  ready: "working",
  idle: "starts when needed",
  starting: "starting",
  stopped: "stopped (starts again when needed)",
  needs_key: "needs a key",
  needs_signin: "needs sign-in",
  error: "not working",
};

const APP_WORDS: Record<string, string> = {
  connected: "connected and working",
  added: "set up; restart it (or start a new Claude Code session) to finish",
  not_seeing: "set up, but it hasn't contacted Ringkeeper Connect since; quit it completely and open it again",
  missing: "its Ringkeeper Connect entry is missing; click Fix next to it in the window",
  unreadable: "its settings file can't be read; Ringkeeper Connect leaves it alone",
  not_connected: "installed, not connected",
};

export const GUIDE = `## How Ringkeeper Connect works

Ringkeeper Connect is a desktop app for agencies. It keeps each client's tools (their n8n, Airtable, Notion, Google account and so on) with that client's own keys and sign-ins. The AI apps on this computer (Claude Desktop, Cursor, Claude Code, VS Code, Codex and others) connect to it once, and it gives them the tools of one client at a time: the active client. Switching client switches every AI app, in every chat, so one client's data never ends up in another's. Nothing needs a terminal.

## Clients and the active client
- Each client has its own tools and its own keys or sign-ins. Add one with "+ New" (or "Add your first client") in the window's sidebar. Rename or Delete it on its page.
- The active client is the one every AI app is working with right now. Switch by clicking the client in the window, or ask the AI to switch to it.
- "Ask AI apps to name the client on every action" (recommended, in the sidebar) makes the AI say which client each action is for; if it names a different client than the active one, nothing is run.
- "Copy to…" on a tool puts it into another client too. Keys aren't copied: each client uses its own.

## Adding a client's tools
1. Open the client in the window and click "+ Add a tool".
2. Pick the service (there's a search box and groups). Read the notes on its card: they say what plan or permission the service needs.
3. Choose how to connect. "Sign in with …" is offered wherever the service allows it: sign in with the client's account (not your own) in the browser that opens, then come back. Otherwise paste a key; the "where to find it" link under the field opens the right page of the service. Some tools have "Test connection" to check the key first.
4. For Google, Microsoft 365 and Meta Ads, tick what the AI may do (for example read mail but not send it). Change it later with Edit on the tool.
- A tool marked Beta works but hasn't been tried with a real account yet.
- Missing a service? Use "Request a tool" at the bottom of Add a tool, or "Something else" to add any connection by its web address or program.

## Bringing in tools you already use
- "Bring in connections from apps…" (sidebar) moves connections already set up in the AI apps into a client, keys included. From Windsurf, Gemini CLI and other apps they're copied, and those apps aren't changed.
- Connectors added in a Claude or ChatGPT account online, and Claude Desktop extensions, keep their sign-ins to themselves: add those again in Ringkeeper Connect. It's once: after that every AI app uses the same connection.

## Connecting the AI apps
- The first-run setup finds the AI apps and connects the ones you tick (Connect apps). Later, "Connect" next to an app in the sidebar does it. After connecting, restart that app (Claude Code: start a new session).
- Ringkeeper Connect adds one entry, "ringkeeper-connect", to each app's own settings and keeps a backup first. Nothing else in those settings is touched.
- "Show me how to check" next to an app walks through checking that it uses Ringkeeper Connect.
- Codex: ChatGPT uses Ringkeeper Connect only in Codex, not in regular ChatGPT chats. Apps that only run in the cloud (ChatGPT or Claude on the web, Replit) can't reach Ringkeeper Connect on this computer.

## When something isn't working
- A tool that isn't working says why and how to fix it, right under its name in the window. "Needs a key": open Edit on the tool and paste the key. "Needs sign-in": click Sign in on the tool. "Not working": follow the message; it usually names the key or setting to check.
- An AI app that doesn't see the client's tools: check it's connected in the sidebar, then restart it completely. If its entry went missing, click Fix next to it.
- An AI app that was open during setup may save its old settings later and drop the entry; it's put back straight away. If that keeps happening, quit the app completely and open it again.
- Sign-ins for Google and Microsoft can go through your own registered app ("Your own apps", sidebar) when a client's admin requires that.

## Keys and privacy
- Keys and sign-ins are stored encrypted with the computer account's own protection, never as plain text, and never shown to the AI. Never paste a key into a chat: put it in the Ringkeeper Connect window.
- Everything stays on this computer; Ringkeeper Connect has no online account.

## Restore original settings
${RESTORE_POINTS.map((p) => `- ${p}`).join("\n")}
- It's in the sidebar ("Restore original settings…"). Restart the AI apps afterwards; "Connect" next to each app connects it again later.

## Updates and uninstalling
- Updates download by themselves and install when Ringkeeper Connect restarts ("Restart now" on the banner, or quitting it). "Check for updates" next to the version in the sidebar checks now. AI apps keep working through updates.
- Uninstalling runs Restore first, so the AI apps go back to how they were. Clients and keys stay on this computer, so reinstalling brings them back.
- "Start when I log in" (sidebar) keeps it running in the background so AI apps can always reach the clients.

## Getting more help
- "How it works" in the window has this guide. For help setting it up for your clients: https://yushkin.us`;

function connectionStatus(statuses: ConnectionStatus[], clientId: string, conn: ConnectionView): { word: string; problem?: string } {
  const s = statuses.find((x) => x.clientId === clientId && x.connectionId === conn.id);
  if (conn.missingKeys.length) return { word: "needs a key", problem: s?.problem };
  if (conn.auth === "oauth" && conn.signedIn === false) return { word: "needs sign-in", problem: s?.problem };
  if (!s) return { word: "starts when needed" };
  return { word: STATUS_WORDS[s.status] ?? s.status, problem: s.problem };
}

/** Which catalog service a connection is, from its name, program and address. */
function serviceOf(conn: ConnectionView, services: CatalogService[]): CatalogService | undefined {
  const value = conn.kind === "remote" ? { url: conn.url } : { command: conn.command, args: conn.args };
  const hit = detectService(conn.name, value);
  const id = hit?.id === "meta-ads" ? "meta_ads" : hit?.id;
  return (id && services.find((s) => s.id === id)) || services.find((s) => s.name.toLowerCase() === conn.name.toLowerCase());
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length > 1);
}

/** Services the question names, by name or id ("airtable", "Google Ads", "meta ads"). */
export function servicesNamed(question: string, services: CatalogService[]): CatalogService[] {
  const q = ` ${words(question).join(" ")} `;
  return services.filter((s) => {
    const names = [s.name, s.id.replace(/[-_]/g, " ")].map((n) => words(n).join(" ")).filter(Boolean);
    return names.some((n) => q.includes(` ${n} `));
  });
}

function describeService(s: CatalogService): string {
  const lines = [`### ${s.name}${s.beta ? " (Beta: not yet tried with a real account)" : ""}`, s.description];
  for (const n of s.notes ?? []) lines.push(`- ${n}`);
  for (const o of s.options) {
    const how = [`- Option "${o.label}"${o.recommended ? " (recommended)" : ""}`];
    for (const f of o.fields) {
      const bits = [f.label];
      if (f.help) bits.push(f.help);
      if (f.where) bits.push(`${f.where.label}: ${f.where.url}`);
      how.push(`  - ${bits.map((b) => b.trim().replace(/\.$/, "")).join(". ")}`);
    }
    const access = (o as { access?: Array<{ label: string }> }).access;
    if (access?.length) how.push(`  - What the AI may do (ticked in the window): ${access.map((a) => a.label).join("; ")}`);
    lines.push(...how);
  }
  return lines.join("\n");
}

export function helpAnswer(input: HelpInput): string {
  const services = input.services ?? catalog.services;
  const out: string[] = [];
  out.push(
    `[Ringkeeper Connect help, for ${input.host}] Answer the user from this, in plain words, as steps in the Ringkeeper Connect window. ` +
      "Don't mention tool names, files or settings internals. Changes (adding a client, a tool, a key, a sign-in) are made by the user in the window: never ask them to paste a key into the chat.",
  );

  // What's set up right now.
  const state: string[] = ["## On this computer now"];
  state.push(`- Ringkeeper Connect ${input.version}${input.packaged ? "" : " (a development copy)"}.${updateLine(input.update)}`);
  const apps = input.hosts.filter((h) => h.status !== "not_installed");
  state.push(
    apps.length
      ? `- AI apps: ${apps.map((h) => `${h.label}: ${h.viaLabel && h.status === "connected" ? `connected through ${h.viaLabel}'s settings` : (APP_WORDS[h.status] ?? h.status)}`).join("; ")}.`
      : "- No AI apps found on this computer.",
  );
  state.push(`- Ask AI apps to name the client on every action: ${input.settings.requireClientArg ? "on" : "off"}. Start when I log in: ${input.settings.startAtLogin ? "on" : "off"}.`);
  if (!input.clients.length) state.push("- No clients yet. Add one in the window's sidebar.");
  for (const c of input.clients) {
    const tools = c.connections.map((conn) => {
      const st = connectionStatus(input.statuses, c.id, conn);
      const svc = serviceOf(conn, services);
      return `${conn.name}${svc && svc.name.toLowerCase() !== conn.name.toLowerCase() ? ` (${svc.name})` : ""}: ${st.word}${st.problem ? ` — ${st.problem}` : ""}`;
    });
    state.push(`- Client ${c.name}${c.active ? " (active)" : ""}: ${tools.length ? tools.join("; ") : "no tools yet"}.`);
  }
  out.push(state.join("\n"));

  // Advice for the services the question names, then for tools that need attention.
  const named = servicesNamed(input.question, services);
  const troubled = input.clients.flatMap((c) =>
    c.connections
      .filter((conn) => connectionStatus(input.statuses, c.id, conn).word !== "working" && connectionStatus(input.statuses, c.id, conn).word !== "starts when needed")
      .map((conn) => serviceOf(conn, services))
      .filter((s): s is CatalogService => !!s),
  );
  const shown = [...new Map([...named, ...troubled].map((s) => [s.id, s])).values()].slice(0, MOST_SERVICES);
  if (shown.length) out.push(["## About these services", ...shown.map(describeService)].join("\n\n"));
  else if (input.question.trim()) {
    out.push(
      `## Services in Add a tool\n${groupedServices(services)}\n\nCall ringkeeper_help again with the service's name in the question for its notes and where to find its key.`,
    );
  }

  out.push(GUIDE);
  return out.join("\n\n");
}

function updateLine(u: UpdateState | undefined): string {
  const t = updateStatusText(u);
  return t ? ` Updates: ${t}` : "";
}

function groupedServices(services: CatalogService[]): string {
  const groups = new Map<string, string[]>();
  for (const s of services) groups.set(s.group, [...(groups.get(s.group) ?? []), `${s.name}${s.beta ? " (Beta)" : ""}`]);
  return [...groups].map(([g, names]) => `- ${g}: ${names.join(", ")}`).join("\n");
}
