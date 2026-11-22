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
  /** The tools every client gets. */
  everyClient?: ClientView;
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
- The active client's name shows in the tray (menu bar on a Mac): hover over the icon. A keyboard shortcut (Ctrl+Alt+Shift+K, or Cmd+Option+Shift+K on a Mac) opens the list of clients from anywhere to switch; it can be turned off in the sidebar. When an AI app switches the client itself, a notification says so.
- "What the AI may do" on each client's page: "Ask me before it deletes anything" (the default) asks the user in a Ringkeeper Connect window before any tool deletes or removes something for that client; "Work freely" leaves everything to the AI app's own permission setting; "Look only" lets the AI read but not change, send or delete anything for that client. Ordinary changes are never asked about here: AI apps have their own permission settings for that. Whether a tool deletes is worked out from its name, so an unusually named one may not be caught.
- "For every client" (top of the sidebar) holds tools that aren't a client's, like a browser helper or web search: they're set up once, and every client gets them next to its own. A client's account never goes there. "More… > Use for every client" on a client's tool moves it there, keys included.
- With many clients: "More…" on a client's page pins it to the top of the list ("Pin to the top"), starts a new client with the same tools ("New client like this…": settings and what the AI may do are copied, keys and sign-ins aren't, and each copied tool isn't offered to AI apps until the user has checked its settings and saved it), or archives it ("Archive": kept with its tools and keys, but out of the list and not offered to AI apps; "Show archived" at the bottom of the list, then "Bring back"). The active client can't be archived: switch first. Once the list is long, "Recent" shows the clients used last.
- "Needs attention" (top of the sidebar, only when something needs it) lists every tool in every client that needs a key, a sign-in or a check, or isn't working, with the button that fixes it.
- "What AI apps did" on each client's page lists the last 200 actions: which tool, whether it looked, changed or deleted, which AI app asked, and how it ended (including ones that weren't run). It never shows what was sent or what came back.

## Adding a client's tools
1. Open the client in the window and click "+ Add a tool".
2. Pick the service (there's a search box and groups). Read the notes on its card: they say what plan or permission the service needs.
3. Choose how to connect. "Sign in with …" is offered wherever the service allows it: sign in with the client's account (not your own) in the browser that opens, then come back. Otherwise paste a key; the "where to find it" link under the field opens the right page of the service. Some tools have "Test connection" to check the key first.
4. For Google, Microsoft 365 and Meta Ads, tick what the AI may do (for example read mail but not send it). Change it later with Edit on the tool.
- A tool marked Beta works but hasn't been tried with a real account yet.
- After the first sign-in to a tool, the window asks "Did it work?". "Worked" or "Had a problem" opens an email with the tool's name, its status and the version (never the client's name or keys) that the user reads and chooses to send; nothing is sent by itself. "No thanks" stops asking about that tool.
- "More… > Choose actions" on a tool picks which of its actions the AI gets: all of them, only the ones that read, or a chosen few. Tools with hundreds of actions (Twilio has over 200) work better with fewer. An action left out isn't shown to the AI and isn't run.
- "More… > Turn off" keeps a tool with its keys but stops offering it to the AI apps; "Turn on" brings it back.
- A sign-in the service set to end (some do, after weeks or months) shows "This sign-in ends on …" on the tool a week before, and the tool appears under "Needs attention": click Sign in before then.
- Missing a service? Use "Request a tool" at the bottom of Add a tool, or "Something else" to add any connection by its web address or program.

## Bringing in tools you already use
- "Bring in connections from apps…" (sidebar) moves connections already set up in the AI apps into a client, keys included. A helper that isn't a client's account (a browser helper like Playwright) can go straight to "For every client" instead: tick "For every client" under it (it's suggested for browser helpers). A connection found in an AI app later can go there too, from the "New connection found" bar. From Windsurf, Gemini CLI and other apps they're copied, and those apps aren't changed.
- Connectors added in a Claude or ChatGPT account online, and Claude Desktop extensions, keep their sign-ins to themselves: add those again in Ringkeeper Connect. It's once: after that every AI app uses the same connection.
- An AI app's own helpers (such as node_repl, which Codex adds for its browser and screen control) aren't offered: they aren't a client's tool and only work inside that app. One brought in by an earlier version can be removed from the client; the app keeps its own copy.

## Connecting the AI apps
- The first-run setup finds the AI apps and connects the ones you tick (Connect apps). Later, "Connect" next to an app in the sidebar does it. After connecting, restart that app (Claude Code: start a new session).
- Ringkeeper Connect adds one entry, "ringkeeper-connect", to each app's own settings and keeps a backup first. Nothing else in those settings is touched.
- "Show me how to check" next to an app walks through checking that it uses Ringkeeper Connect.
- Codex: ChatGPT uses Ringkeeper Connect only in Codex, not in regular ChatGPT chats. Apps that only run in the cloud (ChatGPT or Claude on the web, Replit) can't reach Ringkeeper Connect on this computer.

## When something isn't working
- "Details for support…" (under a tool that isn't working, or in its More menu) shows the version, how the tool connects, its status and its last log lines, with keys, sign-ins and the client's name taken out, to copy or to email to the developer. The user reads it first and chooses to send it.
- A tool that isn't working says why and how to fix it, right under its name in the window. "Needs a key": open Edit on the tool and paste the key. "Needs sign-in": click Sign in on the tool. "Not working": follow the message; it usually names the key or setting to check.
- An AI app that doesn't see the client's tools: check it's connected in the sidebar, then restart it completely. If its entry went missing, click Fix next to it.
- An AI app that was open during setup may save its old settings later and drop the entry; it's put back straight away. If that keeps happening, quit the app completely and open it again.
- Sign-ins for Google and Microsoft can go through your own registered app ("Your own apps", sidebar) when a client's admin requires that.
- HubSpot and Asana always sign in through an app of the user's own: their servers only let in apps made in their developer consoles. "Your own apps" (sidebar) has the steps for each (a HubSpot "MCP connector", an Asana "MCP app"); the redirect URL to give them is https://yushkin.us/ringkeeper-connect/oauth/callback. One app works for every client. A HubSpot account's admin has to connect first; an Asana Enterprise admin may have to allow the app.
- Vercel signs in with Ringkeeper Connect's app ID, which Vercel reads from yushkin.us (its consent page names yushkin.us): nothing to set up.

## Moving to another computer
- "Move to another computer" (sidebar) > "Save a copy of my clients" saves every client, with its tools, keys and sign-ins, the tools for every client and the user's own apps, into one file locked with a password the user chooses (at least 8 characters). Without that password the file can't be opened, and nobody can recover a forgotten one.
- "Send to Ringkeeper" (sidebar) hands Ringkeeper, the full app on this computer, every client with its tools and keys, and the tools for every client. No file and no password: it's locked so only that Ringkeeper can open it, and Ringkeeper shows what came on its Home and asks before bringing it in. Nothing in Ringkeeper Connect changes. Sign-ins don't move: the user signs in to those again in Ringkeeper. Ringkeeper must have been opened once first.
- On the new computer, install Ringkeeper Connect, then "Move to another computer" > "Bring in clients from a copy" (or "Bring in clients from another computer" on the first screen): pick the file, type the password, and tick the clients to bring in. Nothing already there is changed; a client whose name is taken comes in as "Acme 2".
- The AI apps are connected on each computer separately ("Connect" next to each app). A tool that says it needs a sign-in afterwards needs one more sign-in. Delete the copy file afterwards: it holds the clients' keys.

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
  if (conn.off) return { word: "turned off" };
  if (conn.copiedFrom) return { word: `copied from ${conn.copiedFrom}, not checked yet (not offered until the user checks its settings and saves it)` };
  if (conn.missingKeys.length) return { word: "needs a key", problem: s?.problem };
  if (conn.auth === "oauth" && conn.signedIn === false) return { word: "needs sign-in", problem: s?.problem };
  if (!s) return { word: "starts when needed" };
  return { word: STATUS_WORDS[s.status] ?? s.status, problem: s.problem };
}

/** Which catalog service a connection is, from its name, program and address. */
export function serviceOf(conn: ConnectionView, services: CatalogService[]): CatalogService | undefined {
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
  const describe = (c: ClientView) =>
    c.connections.map((conn) => {
      const st = connectionStatus(input.statuses, c.id, conn);
      const svc = serviceOf(conn, services);
      const chosen = conn.actions === "read" ? " (only actions that read)" : Array.isArray(conn.actions) ? ` (${conn.actions.length} chosen actions)` : "";
      return `${conn.name}${svc && svc.name.toLowerCase() !== conn.name.toLowerCase() ? ` (${svc.name})` : ""}: ${st.word}${chosen}${st.problem ? ` — ${st.problem}` : ""}`;
    });
  const archived = input.clients.filter((c) => c.archived);
  for (const c of input.clients.filter((x) => !x.archived)) {
    const tools = describe(c);
    state.push(`- Client ${c.name}${c.active ? " (active)" : ""}: ${tools.length ? tools.join("; ") : "no tools yet"}.`);
  }
  if (archived.length) state.push(`- Archived (not offered to AI apps; "Bring back" on its page): ${archived.map((c) => c.name).join(", ")}.`);
  if (input.everyClient?.connections.length) state.push(`- For every client: ${describe(input.everyClient).join("; ")}.`);
  out.push(state.join("\n"));

  // Advice for the services the question names, then for tools that need attention.
  const named = servicesNamed(input.question, services);
  const troubled = [...input.clients.filter((c) => !c.archived), ...(input.everyClient ? [input.everyClient] : [])].flatMap((c) =>
    c.connections
      .filter((conn) => !["working", "starts when needed", "turned off"].includes(connectionStatus(input.statuses, c.id, conn).word))
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
