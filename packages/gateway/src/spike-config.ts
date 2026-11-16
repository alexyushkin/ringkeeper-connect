import type { GatewayConfig } from "./config.js";

/** Two fake clients so we can watch tools swap. Both have an "n8n_main" connection on purpose. */
export function spikeDefaultConfig(fixturePath: string, nodePath = process.execPath): GatewayConfig {
  const fixture = (service: string, account: string) => ({ command: nodePath, args: [fixturePath, "--service", service, "--account", account] });
  return {
    options: { requireClientArg: false },
    clients: [
      { id: "acme", name: "Acme", connections: [{ id: "n8n_main", name: "n8n", ...fixture("n8n", "Acme") }] },
      {
        id: "globex",
        name: "Globex",
        connections: [
          { id: "n8n_main", name: "n8n", ...fixture("n8n", "Globex") },
          { id: "airtable_main", name: "Airtable", ...fixture("airtable", "Globex") },
        ],
      },
    ],
  };
}
