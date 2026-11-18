// "Connected" only when the AI app actually uses Ringkeeper: its bridge has
// contacted us since our entry was written.
import fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Gateway } from "../packages/gateway/src/gateway.js";
import { spikeDefaultConfig } from "../packages/gateway/src/spike-config.js";
import { dataFiles, newToken, writeJsonAtomic } from "../packages/gateway/src/runtime.js";
import { CONTACT_GRACE_MS, appForClientName, appStatus } from "../packages/hostconfig/src/index.js";
import { isClaudeDesktopPath, isCursorPath } from "../apps/desktop/src/main/app-processes.js";

const written = 1_000_000;
const present = { status: "entry_present" as const, entryWrittenAt: written };

describe("app status", () => {
  it("says Added (restart to finish) right after the entry is written", () => {
    expect(appStatus(present, undefined, undefined, written + 5)).toBe("added");
    // Started before we wrote the entry: still needs a restart.
    expect(appStatus(present, undefined, written - 10, written + 10 * CONTACT_GRACE_MS)).toBe("added");
  });

  it("says Connected only once the app's bridge has contacted us since the entry was written", () => {
    expect(appStatus(present, written + 1, undefined, written + 2)).toBe("connected");
    // A contact from before this entry doesn't count.
    expect(appStatus(present, written - 1, undefined, written + 2)).toBe("added");
  });

  it("says Not seeing us yet when the app restarted since and still hasn't contacted us", () => {
    const started = written + 1000;
    expect(appStatus(present, undefined, started, started + CONTACT_GRACE_MS / 2)).toBe("added"); // still starting
    expect(appStatus(present, undefined, started, started + CONTACT_GRACE_MS + 1)).toBe("not_seeing");
    expect(appStatus(present, started + 5000, started, started + CONTACT_GRACE_MS + 1)).toBe("connected");
  });

  it("passes through missing, unreadable, not set up and not installed", () => {
    expect(appStatus({ status: "entry_missing" }, written, undefined, written)).toBe("missing");
    expect(appStatus({ status: "unreadable" }, written, undefined, written)).toBe("unreadable");
    expect(appStatus({ status: "not_connected" }, written, undefined, written)).toBe("not_connected");
    expect(appStatus({ status: "not_installed" }, undefined, undefined, written)).toBe("not_installed");
  });

  it("an entry from before entryWrittenAt existed counts any contact", () => {
    expect(appStatus({ status: "entry_present" }, 5, undefined, 10)).toBe("connected");
    expect(appStatus({ status: "entry_present" }, undefined, undefined, 10)).toBe("added");
    // Unknown write time: never "not seeing us", however long the app has run.
    expect(appStatus({ status: "entry_present" }, undefined, 1, 10 * CONTACT_GRACE_MS)).toBe("added");
  });

  it("knows which app a client is from the name it reports", () => {
    expect(appForClientName("claude-code")).toBe("claude-code");
    expect(appForClientName("cursor-vscode")).toBe("cursor");
    expect(appForClientName("claude-ai")).toBe("claude-desktop");
    expect(appForClientName("local-agent-mode-ringkeeper-connect")).toBe("claude-desktop");
    expect(appForClientName("some-other-app")).toBeUndefined();
    expect(appForClientName(undefined)).toBeUndefined();
  });
});

describe("spotting Claude Desktop and Cursor among running programs", () => {
  it("tells Claude Desktop from the Claude Code command-line tool (both claude.exe on Windows)", () => {
    expect(isClaudeDesktopPath("C:\\Program Files\\WindowsApps\\Claude_5.11492.5.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe")).toBe(true);
    expect(isClaudeDesktopPath("C:\\Program Files\\WindowsApps\\AnthropicPBC.Claude_1.0.0.0_x64__abc\\app\\claude.exe")).toBe(true);
    expect(isClaudeDesktopPath("C:\\Users\\pat\\AppData\\Local\\AnthropicClaude\\app-0.9.0\\claude.exe")).toBe(true);
    expect(isClaudeDesktopPath("/Applications/Claude.app/Contents/MacOS/Claude")).toBe(true);
    expect(isClaudeDesktopPath("C:\\Users\\pat\\AppData\\Roaming\\Claude\\claude-code\\2.1.325\\claude.exe")).toBe(false);
    expect(isClaudeDesktopPath("C:\\Users\\pat\\.local\\bin\\claude.exe")).toBe(false);
    expect(isClaudeDesktopPath("C:\\Users\\pat\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\claude.exe")).toBe(false);
  });

  it("spots Cursor", () => {
    expect(isCursorPath("C:\\Users\\pat\\AppData\\Local\\Programs\\cursor\\Cursor.exe")).toBe(true);
    expect(isCursorPath("/Applications/Cursor.app/Contents/MacOS/Cursor")).toBe(true);
    expect(isCursorPath("C:\\Users\\pat\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\code.exe")).toBe(false);
  });
});

// ---------- contact from a real bridge ----------

const dist = resolve("dist");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

/** The app's "initialized" notice reaches Ringkeeper a moment after connect() returns. */
async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

type Contact = { app?: string; hostName?: string; at: number };

async function gatewayRecordingContacts() {
  const dataDir = fs.mkdtempSync(join(tmpdir(), "rk-contact-"));
  cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const token = newToken();
  const contacts: Contact[] = [];
  const gateway = new Gateway({
    config: spikeDefaultConfig(join(dist, "fixture-server.mjs")),
    activeClientId: "acme",
    token,
    port: await freePort(),
    onAppContact: (c) => contacts.push(c),
  });
  await gateway.start();
  cleanups.push(() => gateway.stop());
  writeJsonAtomic(dataFiles(dataDir).runtime, { version: 1, port: gateway.port, token, pid: process.pid, startedAt: "" });
  return { dataDir, token, gateway, contacts };
}

async function bridgeFrom(dataDir: string, clientName: string, app?: string) {
  const client = new Client({ name: clientName, version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dist, "bridge.mjs")],
    env: { ...getDefaultEnvironment(), RINGKEEPER_DATA_DIR: dataDir, RINGKEEPER_NO_LAUNCH: "1", ...(app ? { RINGKEEPER_APP: app } : {}) },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

describe("an AI app contacting Ringkeeper", () => {
  it("the bridge says which app launched it, whatever name the app reports", async () => {
    const g = await gatewayRecordingContacts();
    const before = Date.now();
    await bridgeFrom(g.dataDir, "some-new-client-name", "cursor");
    await until(() => g.contacts.length > 0);
    expect(g.contacts).toHaveLength(1);
    expect(g.contacts[0]).toMatchObject({ app: "cursor", hostName: "some-new-client-name" });
    expect(g.contacts[0]!.at).toBeGreaterThanOrEqual(before);
  });

  it("without the bridge's word, the app's reported name is passed on", async () => {
    const g = await gatewayRecordingContacts();
    await bridgeFrom(g.dataDir, "claude-ai");
    await until(() => g.contacts.length > 0);
    expect(g.contacts).toEqual([expect.objectContaining({ app: undefined, hostName: "claude-ai" })]);
    expect(appForClientName(g.contacts[0]!.hostName)).toBe("claude-desktop");
  });

  it("ignores a malformed app name from the settings entry", async () => {
    const g = await gatewayRecordingContacts();
    await bridgeFrom(g.dataDir, "claude-code", "Not An App!");
    await until(() => g.contacts.length > 0);
    expect(g.contacts[0]).toMatchObject({ app: undefined, hostName: "claude-code" });
  });

  it("a direct connection (no bridge) counts too", async () => {
    const g = await gatewayRecordingContacts();
    const client = new Client({ name: "claude-code", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${g.gateway.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${g.token}` } },
      }),
    );
    cleanups.push(() => client.close());
    await until(() => g.contacts.length > 0);
    expect(g.contacts).toEqual([expect.objectContaining({ hostName: "claude-code" })]);
  });
});

describe("connections brought in without a key", () => {
  it("are marked for sign-in when their address is a catalog tool that signs in, and left alone otherwise", async () => {
    const { withSignIn } = await import("../apps/desktop/src/main/apps.js");
    expect(withSignIn({ kind: "remote", name: "linear", url: "https://mcp.linear.app/mcp", fields: [] })).toMatchObject({ auth: "oauth" });
    expect(withSignIn({ kind: "remote", name: "x", url: "https://public.example.com/mcp", fields: [] })).not.toHaveProperty("auth");
    expect(withSignIn({ kind: "remote", name: "n", url: "https://mcp.notion.com/mcp", fields: [{ name: "Authorization", value: "Bearer x", secret: true }] })).not.toHaveProperty("auth");
    expect(withSignIn({ kind: "local", name: "l", command: "npx", args: [], fields: [] })).not.toHaveProperty("auth");
  });

  it("puts an app's entry back silently; tells the user only what needs them", async () => {
    const { hostEventMessage } = await import("../apps/desktop/src/main/apps.js");
    // Claude Desktop saving its settings from an old copy: already fixed, nothing to do.
    expect(hostEventMessage({ kind: "reconnected", host: "claude-desktop" })).toBeNull();
    // Gave up: the fix is a full restart, and Ringkeeper puts itself back once the app is closed.
    expect(hostEventMessage({ kind: "lost", host: "claude-desktop" })).toEqual({
      title: "Restart Claude Desktop to finish",
      body: "Claude Desktop keeps saving its old settings, which leaves out Ringkeeper Connect. Quit Claude Desktop completely and open it again: Ringkeeper Connect puts itself back as soon as Claude Desktop is closed.",
    });
    // An app whose closing can't be seen: quit it, then Connect again.
    expect(hostEventMessage({ kind: "lost", host: "kiro" })?.body).toContain("choose Connect next to it");
    expect(hostEventMessage({ kind: "moved", host: "claude-desktop", from: "a", to: "b" })?.body).toContain("Restart Claude Desktop");
    expect(hostEventMessage({ kind: "found", host: "cursor", name: "linear" })?.title).toBe("New connection found in Cursor");
  });

  it("setup: knows which clients already have a found tool, and which catalog tools each client has", async () => {
    const { whereAlready, addressWarnings, catalogToolsIn } = await import("../apps/desktop/src/main/apps.js");
    const remote = (id: string, name: string, url: string) => ({ kind: "remote" as const, id, name, url, fields: [], missingKeys: [] });
    const gi = {
      id: "gi",
      name: "General Informatics",
      active: true,
      connections: [
        remote("1", "mass_home_comfort", "https://new-address.trycloudflare.com/api/mcp"),
        remote("2", "Twilio", "https://example.com/x"),
        { kind: "local" as const, id: "3", name: "playwright", command: "npx", args: ["-y", "@executeautomation/playwright-mcp-server"], fields: [], missingKeys: [] },
      ],
    };
    const seaside = { id: "sea", name: "Seaside", active: false, connections: [remote("4", "linear", "https://mcp.linear.app/mcp/")] };

    // Same name, different address: in General Informatics, but not set up the same way.
    const old = { kind: "remote" as const, name: "mass_home_comfort", url: "https://chronicles-dance.trycloudflare.com/api/mcp", fields: [] };
    expect(whereAlready(old, "mass_home_comfort", [gi, seaside])).toEqual([{ clientId: "gi", clientName: "General Informatics", same: false }]);
    // Same program under another name; same address ignoring a trailing slash.
    expect(whereAlready({ kind: "local", name: "pw", command: "npx", args: ["-y", "@executeautomation/playwright-mcp-server"], fields: [] }, "pw", [gi])).toEqual([
      { clientId: "gi", clientName: "General Informatics", same: true },
    ]);
    expect(whereAlready({ kind: "remote", name: "Linear", url: "https://mcp.linear.app/mcp", fields: [] }, "Linear", [gi, seaside])).toEqual([
      { clientId: "sea", clientName: "Seaside", same: true },
    ]);

    expect(addressWarnings(old)[0]).toContain("chronicles-dance.trycloudflare.com) is temporary");
    expect(addressWarnings({ kind: "remote", name: "x", url: "https://mcp.notion.com/mcp", fields: [] })).toEqual([]);

    // By name (Twilio) or by the tool's own address (Linear).
    expect(catalogToolsIn(gi)).toContain("twilio");
    expect(catalogToolsIn(seaside)).toEqual(["linear"]);
  });

  it("'Request a tool' opens an email with the search in the subject and a short form", async () => {
    const { requestToolMailto, REQUEST_TOOL_EMAIL } = await import("../apps/desktop/src/main/catalog.js");
    expect(REQUEST_TOOL_EMAIL).toBe("requests@yushkin.us");
    const url = new URL(requestToolMailto("  Fresh\nBooks "));
    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe("requests@yushkin.us");
    expect(url.searchParams.get("subject")).toBe("Tool request: Fresh Books");
    const body = url.searchParams.get("body")!;
    expect(body).toContain("Tool name: Fresh Books");
    expect(body).toContain("What I'd like the AI to do with it:");
    expect(body).toContain("How to reach me:");
    expect(new URL(requestToolMailto("")).searchParams.get("subject")).toBe("Tool request: ");
  });
});
