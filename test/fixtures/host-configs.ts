// Config files shaped like the real ones (checked against a real Windows
// machine on 2026-11-16): 2-space indent, no trailing newline, other keys
// the apps own. Values are fake.

export const claudeDesktop = `{
  "mcpServers": {
    "playwright": {
      "command": "C:\\\\Users\\\\pat\\\\bin\\\\pw-mcp.cmd",
      "args": []
    },
    "n8n": {
      "command": "npx",
      "args": [
        "-y",
        "n8n-mcp"
      ],
      "env": {
        "N8N_API_URL": "https://acme.app.n8n.cloud",
        "N8N_API_KEY": "n8n_api_fake1234567890abcdef"
      }
    }
  },
  "coworkUserFilesPath": "C:\\\\Users\\\\pat\\\\Documents\\\\Claude",
  "preferences": {
    "sidebarMode": "chat",
    "quickEntryShortcut": "Ctrl+Alt+Space",
    "menuBarEnabled": false,
    "nested": {
      "list": [
        1,
        2,
        3
      ]
    }
  }
}`;

/** Same content, saved by an editor with Windows line endings and a byte-order mark. */
export const claudeDesktopCrlfBom = "\uFEFF" + claudeDesktop.replace(/\n/g, "\r\n");

export const cursorWithComments = `{
  // Pat's tools
  "mcpServers": {
    "notion": {
      "url": "https://mcp.notion.com/mcp",
      "headers": {
        "Authorization": "Bearer \${env:NOTION_TOKEN}"
      }
    },
    "airtable": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "airtable-mcp-server"],
      "env": {
        "AIRTABLE_API_KEY": "patABCdefGHI123456789.0123456789abcdef"
      }
    },
    "repo-tool": {
      "command": "node",
      "args": ["\${workspaceFolder}/tools/server.js"]
    }
  }
}
`;

export const claudeCode = `{
  "numStartups": 412,
  "installMethod": "global",
  "tipsHistory": {
    "new-user-warmup": 7
  },
  "projects": {
    "C:/Users/pat/Documents/GitHub/site": {
      "allowedTools": [],
      "mcpServers": {
        "project-only": {
          "type": "stdio",
          "command": "node",
          "args": [
            "server.js"
          ]
        }
      },
      "hasTrustDialogAccepted": true
    }
  },
  "userID": "0000000000000000000000000000000000000000000000000000000000000000",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer \${GITHUB_PAT}"
      }
    },
    "legacy": {
      "type": "sse",
      "url": "\${LEGACY_URL:-https://legacy.example.com/sse}"
    },
    "socket": {
      "type": "ws",
      "url": "wss://example.com/mcp"
    },
    "n8n": {
      "command": "npx",
      "args": [
        "-y",
        "n8n-mcp"
      ],
      "env": {
        "N8N_API_URL": "https://acme.app.n8n.cloud",
        "N8N_API_KEY": "n8n_api_fake1234567890abcdef"
      }
    }
  }
}`;
