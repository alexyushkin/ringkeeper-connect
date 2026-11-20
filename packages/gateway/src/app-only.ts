// Helpers an AI app ships for itself. They are the same for every client,
// only work inside (or together with) that one app, and usually live in the
// app's own folders, whose names change with every update. Bringing one in
// gives a client a tool that isn't theirs and breaks at the app's next update
// (seen 2026-11-20: Codex's node_repl, after Codex updated itself).
//
// Checked 2026-11-20 across Claude Desktop, Claude Code, Cursor, VS Code,
// Copilot CLI, Kiro, Antigravity, Gemini CLI, Zed, Cline, Windsurf, Visual
// Studio, Amazon Q, LM Studio and Warp: only the Codex / ChatGPT desktop app
// writes its own helpers into its settings. Tools that are the same for
// everyone but work from any AI app (JetBrains, Figma desktop, Xcode, Unity,
// Blender, Playwright, Chrome DevTools, Docker, Kiro's "fetch") are NOT here
// on purpose: they stay offered.
//
// Every rule was approved one by one. Add a new one only with a test in
// test/more-apps.test.ts showing the entry as the app writes it.

export interface AppOnlyHelper {
  /** The app it belongs to, as users know it. */
  app: string;
}

interface Entry {
  /** The entry's name as written in the app's settings (or the tool's name in Ringkeeper Connect). */
  name: string;
  /** The command and its arguments in one line: lower case, forward slashes. */
  program: string;
  /** The command, and its first argument (the script, when the command is Node or Python): lower case, forward slashes. */
  start: string;
}

interface Rule {
  app: string;
  test: (e: Entry) => boolean;
}

/**
 * The Codex / ChatGPT desktop app's own folders:
 *   …\WindowsApps\OpenAI.<package>_<version>_…\            (Microsoft Store install)
 *   %LOCALAPPDATA%\OpenAI\Codex\                            (bin\<id>\, runtimes\<name>\<id>\)
 *   /Applications/ChatGPT.app, Codex.app, "Codex Computer Use.app"
 *   ~/.codex/plugins/cache/, ~/.codex/computer-use/         (what the app unpacks for itself)
 */
const CODEX_FOLDERS = /\/windowsapps\/openai\.|\/appdata\/local\/openai\/codex\/|\/(chatgpt|codex)\.app\/contents\/|codex computer use\.app\/|\/\.codex\/(plugins\/cache|computer-use)\//;

const RULES: Rule[] = [
  // node_repl: Codex's browser and computer-use runner. The app rewrites
  // [mcp_servers.node_repl] in its own settings at every start, and the
  // program talks to the running app over a private pipe. Seen at (a real
  // install, and openai/codex issues 26011, 26530, 53664):
  //   …\WindowsApps\OpenAI.Codex_<version>_…\app\resources\cua_node\bin\node_repl.exe
  //   %LOCALAPPDATA%\OpenAI\Codex\bin\<id>\node_repl.exe
  //   %LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\<id>\bin\node_repl.exe
  //   /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl
  {
    app: "Codex",
    test: (e) => /(^|\/)node_repl(\.exe)?(\s|$)/.test(e.program) && (/^node_repl\b/i.test(e.name) || /\/cua_node\//.test(e.program)),
  },
  // cua_repl: the same helper under its newer name. Codex's bundled Node
  // running @oai/cua-repl/bin/cua-repl.mjs (openai/codex issues 26011, 42454).
  {
    app: "Codex",
    test: (e) => /@oai\/cua-repl\/|(^|\/)cua-repl\.mjs(\s|$)/.test(e.program) || (/^cua_repl\b/i.test(e.name) && /\/cua_node\//.test(e.program)),
  },
  // computer-use: Codex's screen-control program,
  // "Codex Computer Use.app/…/SkyComputerUseClient mcp".
  { app: "Codex", test: (e) => /(^|\/)skycomputeruseclient(\.exe)?(\s|$)/.test(e.program) },
  // Anything else that runs from the Codex / ChatGPT app's own folders: a
  // helper it added under a name not known yet.
  { app: "Codex", test: (e) => CODEX_FOLDERS.test(e.start) },
];

const norm = (s: string): string => s.replace(/\\/g, "/").toLowerCase();

/** The app a program-based tool belongs to, when it's one of that app's own helpers. */
export function appOnlyHelper(name: string, command: string | undefined, args?: readonly string[]): AppOnlyHelper | undefined {
  if (!command || typeof command !== "string") return undefined;
  const list = (args ?? []).filter((x): x is string => typeof x === "string");
  // A leading "./" or a bare folder name still has to match the folder patterns, which start with "/".
  const entry: Entry = {
    name,
    program: norm([command, ...list].join(" ")),
    start: norm(`/${command} /${list[0] ?? ""}`),
  };
  const hit = RULES.find((r) => r.test(entry));
  return hit ? { app: hit.app } : undefined;
}
