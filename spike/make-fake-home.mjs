// Builds a fake Windows user folder with Claude Desktop, Cursor and Claude Code
// settings shaped like real ones, for trying the setup wizard safely.
//   node spike/make-fake-home.mjs <folder>
import fs from "node:fs";
import { join } from "node:path";

const home = process.argv[2];
if (!home) throw new Error("Pass a folder");
fs.rmSync(home, { recursive: true, force: true });
const desktopDir = join(home, "AppData", "Roaming", "Claude");
fs.mkdirSync(join(home, "AppData", "Local"), { recursive: true });
fs.mkdirSync(join(desktopDir, "Claude Extensions", "ant.dir.gh.airtable.airtable-mcp"), { recursive: true });
fs.writeFileSync(join(desktopDir, "Claude Extensions", "ant.dir.gh.airtable.airtable-mcp", "manifest.json"), JSON.stringify({ name: "airtable-mcp", display_name: "Airtable" }));

const fixture = (service, account) => ({ command: "node", args: [join(process.cwd(), "dist", "fixture-server.mjs"), "--service", service, "--account", account] });

fs.writeFileSync(join(desktopDir, "claude_desktop_config.json"), JSON.stringify({
  mcpServers: {
    n8n: { ...fixture("n8n", "Acme"), env: { N8N_API_URL: "https://acme.app.n8n.cloud", N8N_API_KEY: "n8n_api_fake1234567890abcdef" } },
    playwright: { command: "npx", args: ["-y", "@playwright/mcp"] },
  },
  coworkUserFilesPath: "C:\Users\pat\Documents\Claude",
  preferences: { sidebarMode: "chat", menuBarEnabled: false },
}, null, 2));

fs.mkdirSync(join(home, ".cursor"), { recursive: true });
fs.writeFileSync(join(home, ".cursor", "mcp.json"), `{
  // Pat's tools
  "mcpServers": {
    "airtable": { "type": "stdio", "command": "node", "args": ${JSON.stringify(fixture("airtable", "Acme").args)}, "env": { "AIRTABLE_API_KEY": "patABCdefGHI123456789.0123456789abcdef" } },
    "repo-tool": { "command": "node", "args": ["\${workspaceFolder}/tools/server.js"] }
  }
}
`);

fs.writeFileSync(join(home, ".claude.json"), JSON.stringify({
  numStartups: 412,
  projects: { "C:/Users/pat/site": { allowedTools: [], mcpServers: {} } },
  mcpServers: {
    n8n: { ...fixture("n8n", "Acme"), env: { N8N_API_URL: "https://acme.app.n8n.cloud", N8N_API_KEY: "n8n_api_fake1234567890abcdef" } },
    socket: { type: "ws", url: "wss://example.com/mcp" },
  },
}, null, 2));
console.log(`fake home ready: ${home}`);
