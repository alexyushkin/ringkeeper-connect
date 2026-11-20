// Settings files shaped like each app's documented layout (checked against
// their docs on 2026-11-17; see docs/proposal-tools-and-apps.md). Values are
// fake. Replace with copies of real files (keys removed) after the real-install
// checks.

/** Codex / ChatGPT desktop: ~/.codex/config.toml. Comments, profiles, quoted names, sub-tables. */
export const codexToml = `# Codex settings
model = "gpt-5.5"
approval_policy = "on-request"   # ask before running commands

[profiles.fast]
model = "gpt-5.5-mini"

# Pat's tools
[mcp_servers.n8n]
command = "npx"
args = ["-y", "n8n-mcp"]
startup_timeout_sec = 20

[mcp_servers.n8n.env]
N8N_API_URL = "https://acme.app.n8n.cloud"
N8N_API_KEY = "n8n_api_fake1234567890abcdef"

[mcp_servers."docs search"]
url = "https://docs.example.com/mcp"
bearer_token_env_var = "DOCS_TOKEN"
enabled = false

# Keep this note: it explains the sandbox.
[sandbox_workspace_write]
network_access = true

[tui]
notes = """
A multi-line note that mentions
[mcp_servers.not-a-table]
and must stay as it is.
"""
`;
/**
 * The helper the Codex app writes into its own settings (copied from a real
 * Windows install on 2026-11-20, values shortened). Its program lives in the
 * app's install folder, whose name holds the version, so it moves with every
 * Codex update. Ringkeeper Connect leaves it alone.
 */
export const codexNodeRepl = String.raw`
[mcp_servers.node_repl]
args = []
command = 'C:\Program Files\WindowsApps\OpenAI.Codex_26.1111.9664.0_x64__2p2nqsd0c76g0\app\resources\cua_node\bin\node_repl.exe'
env_vars = ["BROWSER_USE_ACCESS_EXECUTOR_ID", "BROWSER_USE_ACCESS_PIPE_PATH", "CODEX_WINDOWS_REGISTERED_CORE"]
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "5000"
NODE_REPL_NODE_PATH = 'C:\Program Files\WindowsApps\OpenAI.Codex_26.1111.9664.0_x64__2p2nqsd0c76g0\app\resources\cua_node\bin\node.exe'
CODEX_HOME = 'C:\Users\pat\.codex'
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"
SKY_CUA_NATIVE_PIPE = '\\.\pipe\codex-cua-fake'
`;

/** VS Code / Copilot CLI: ~/.copilot/mcp-config.json. */
export const copilotJson = `{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
      "tools": ["*"]
    }
  }
}
`;

/** VS Code's own settings (default profile): discovery of other apps' files. */
export const vscodeSettingsDiscovery = `{
  // Pat's editor settings
  "editor.fontSize": 14,
  "chat.mcp.discovery.enabled": {
    "claude-desktop": true,
    "cursor-global": false
  },
}
`;

/** VS Code's older per-profile mcp.json: "servers" and "inputs". Read only. */
export const vscodeLegacyJson = `{
  // Older VS Code settings
  "inputs": [{ "type": "promptString", "id": "gh-token", "description": "GitHub token", "password": true }],
  "servers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer \${input:gh-token}" }
    },
    "files": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "\${userHome}/Documents"] }
  }
}
`;

/** Kiro: ~/.kiro/settings/mcp.json. */
export const kiroJson = `{
  "mcpServers": {
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"],
      "env": {},
      "disabled": false,
      "autoApprove": []
    }
  }
}
`;

/** Antigravity: ~/.gemini/config/mcp_config.json. */
export const antigravityJson = `{
  "mcpServers": {
    "airtable": {
      "serverUrl": "https://mcp.airtable.com/mcp",
      "headers": { "Authorization": "Bearer patABCdefGHI123456789.0123456789abcdef" },
      "disabledTools": []
    }
  }
}
`;

// ---------- apps we only read from ----------

export const windsurfJson = `{
  "mcpServers": {
    "n8n": {
      "serverUrl": "https://acme.app.n8n.cloud/mcp-server/http",
      "headers": { "Authorization": "Bearer n8n_mcp_fake_token_1234567890" }
    }
  }
}
`;

/** Cursor's own file with the same n8n written its way (url): one candidate, two sources. */
export const cursorWithN8n = `{
  "mcpServers": {
    "n8n": {
      "url": "https://acme.app.n8n.cloud/mcp-server/http",
      "headers": { "Authorization": "Bearer n8n_mcp_fake_token_1234567890" }
    }
  }
}
`;

export const geminiSettings = `{
  "theme": "GitHub",
  "mcpServers": {
    "notion": { "httpUrl": "https://mcp.notion.com/mcp" },
    "legacy-sse": { "url": "https://sse.example.com/sse" }
  }
}
`;

/** Cline as its command-line tool writes it (nested transport), with sign-in data that must never be copied. */
export const clineNested = `{
  "mcpServers": {
    "linear": {
      "transport": { "type": "streamableHttp", "url": "https://mcp.linear.app/mcp" },
      "disabled": false,
      "autoApprove": [],
      "oauth": { "tokens": { "access_token": "cline-oauth-secret-123" } }
    }
  }
}
`;

/** Older Cline in VS Code's storage: flat, url without type means SSE. */
export const clineLegacy = `{
  "mcpServers": {
    "weather": { "url": "https://weather.example.com/sse", "disabled": true }
  }
}
`;

export const rooJson = `{
  "mcpServers": {
    "supabase": { "type": "streamable-http", "url": "https://mcp.supabase.com/mcp", "alwaysAllow": [] }
  }
}
`;

export const zedSettings = `// Zed settings
{
  "theme": "One Dark",
  "context_servers": {
    "postgres": {
      "command": { "path": "npx", "args": ["-y", "@zeddev/postgres-context-server"], "env": { "DATABASE_URL": "postgres://user:pw@db.example.com/app" } }
    },
    "remote-one": { "url": "https://remote.example.com/mcp", "headers": { "Authorization": "Bearer zed_fake_token_1234567890abc" } }
  }
}
`;

export const continueYaml = `name: Pat's config
version: 1.0.0
schema: v1
mcpServers:
  - name: browser
    type: stdio
    command: npx
    args: ["@playwright/mcp@latest"]
  - name: github-remote
    type: streamable-http
    url: https://api.githubcopilot.com/mcp/
    requestOptions:
      headers:
        Authorization: "Bearer \${{ secrets.GITHUB_TOKEN }}"
`;

export const warpJson = `{ "mcpServers": { "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] } } }`;
export const lmStudioJson = `{ "mcpServers": { "hf": { "url": "https://huggingface.co/mcp" } } }`;
export const junieJson = `{ "mcpServers": { "time": { "command": "uvx", "args": ["mcp-server-time"], "timeout": 60000 } } }`;
export const amazonQJson = `{ "mcpServers": { "aws-docs": { "command": "uvx", "args": ["awslabs.aws-documentation-mcp-server@latest"] } } }`;
export const visualStudioJson = `{ "servers": { "learn": { "url": "https://learn.microsoft.com/api/mcp" } } }`;
export const devinJson = `{ "mcpServers": { "cal": { "url": "https://mcp.cal.com/mcp", "transport": "http" } } }`;
