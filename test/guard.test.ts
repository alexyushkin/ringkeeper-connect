// What the AI may do for a client: work freely, ask before deleting, or look only.
// Ordinary changes are never asked about here (AI apps have their own permission modes);
// deleting is, by default; and a "look only" client can't be changed at all.
import fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Gateway, deleteQuestion } from "../packages/gateway/src/gateway.js";
import type { ClientConfig, GatewayConfig } from "../packages/gateway/src/config.js";
import { DEFAULT_GUARD, actionKind, nameWords, type Activity, type ClientGuard } from "../packages/gateway/src/guard.js";
import { mcpUrl, newToken } from "../packages/gateway/src/runtime.js";
import { ClientStore } from "../packages/gateway/src/store/client-store.js";
import { SecretStore, type Cipher } from "../packages/gateway/src/store/secrets.js";
import type { ApprovalRequest } from "../packages/gateway/src/upstream.js";
import { ACTIVITY_PER_CLIENT, ActivityLog } from "../apps/desktop/src/main/activity.js";

const fixture = join(resolve("dist"), "fixture-server.mjs");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
  const d = fs.mkdtempSync(join(tmpdir(), "rk-guard-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

const crm = (account: string) => ({ id: "crm", name: "CRM", command: process.execPath, args: [fixture, "--service", "crm", "--account", account] });
const client = (id: string, name: string, guard?: ClientGuard): ClientConfig => ({ id, name, connections: [crm(name)], ...(guard ? { guard } : {}) });

async function start(clients: ClientConfig[], answer?: (q: ApprovalRequest) => boolean | Promise<boolean>) {
  const config: GatewayConfig = { clients: structuredClone(clients), options: { requireClientArg: false } };
  const token = newToken();
  const asked: ApprovalRequest[] = [];
  const activity: Activity[] = [];
  const gateway = new Gateway({
    config,
    activeClientId: clients[0]!.id,
    token,
    port: await freePort(),
    onActivity: (a) => activity.push(a),
    upstreamEnv: answer
      ? {
          approve: async (q) => {
            asked.push(q);
            return answer(q);
          },
        }
      : {},
  });
  await gateway.start();
  cleanups.push(() => gateway.stop());
  const c = new Client({ name: "cursor-vscode", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(gateway.port)), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  cleanups.push(() => c.close());
  const call = async (tool: string, args: Record<string, unknown> = {}) => (await c.callTool({ name: tool, arguments: args })) as CallToolResult;
  return { gateway, c, call, asked, activity };
}

const text = (r: CallToolResult) => (r.content ?? []).map((x) => (x.type === "text" ? x.text : "")).join("\n");

describe("telling looking, changing and deleting apart", () => {
  it("splits names the way vendors write them", () => {
    expect(nameWords("delete_records")).toEqual(["delete", "records"]);
    expect(nameWords("notion-delete-pages")).toEqual(["notion", "delete", "pages"]);
    expect(nameWords("TwilioApiV2010--DeleteCall")).toEqual(["twilio", "api", "v2010", "delete", "call"]);
    expect(nameWords("listIncomingPhoneNumber")).toEqual(["list", "incoming", "phone", "number"]);
  });

  it("trusts a server that says a tool only reads", () => {
    expect(actionKind({ name: "run_sql", annotations: { readOnlyHint: true } })).toBe("read");
    // Even with a deleting word in its name: the server knows best what it does.
    expect(actionKind({ name: "list_deleted_items", annotations: { readOnlyHint: true } })).toBe("read");
  });

  it("recognises deleting by name, however the vendor writes it", () => {
    for (const name of ["delete_contact", "notion-delete-pages", "TwilioApiV2010--DeleteCall", "remove_company_from_lists", "trash_mail", "drop_table", "revoke_credential", "notion-calendar-cancel-events", "reset_from_parent", "delete_storage_objects_by_prefix"]) {
      expect(actionKind({ name }), name).toBe("delete");
    }
    // A server that marks it as not read-only doesn't make it less of a deletion.
    expect(actionKind({ name: "delete_branch", annotations: { readOnlyHint: false } })).toBe("delete");
  });

  it("recognises looking by name, and treats anything unclear as a change", () => {
    for (const name of ["find_contacts", "list_bases", "get_workflow", "search_workflows", "TwilioApiV2010--FetchCall", "describe_table_schema", "netlify-deploy-services-reader", "stripe_analytics"]) {
      expect(actionKind({ name }), name).toBe("read");
    }
    for (const name of ["update_contact", "create_workflow_from_code", "send_mail", "run_sql", "execute_workflow", "stripe_api_write", "netlify-deploy-services-updater", "publish_workflow", "mystery_tool"]) {
      expect(actionKind({ name }), name).toBe("change");
    }
    // A looking word doesn't hide a changing one.
    expect(actionKind({ name: "get_or_create_drive" })).toBe("change");
    expect(actionKind({ name: "search_and_update" })).toBe("change");
    // A server saying "not read-only" wins over a looking name.
    expect(actionKind({ name: "get_report", annotations: { readOnlyHint: false } })).toBe("change");
  });
});

describe("what the person is asked before a deletion", () => {
  it("names the tool, says it can't be undone, and shows what was sent, shortened", () => {
    const q = deleteQuestion("delete_contact", { id: "c-1" });
    expect(q.split("\n")[0]).toBe('Let the AI run "delete_contact"?');
    expect(q).toContain("usually can't be undone");
    expect(q).toContain('What it sent: {"id":"c-1"}');
    expect(deleteQuestion("purge", {})).not.toContain("What it sent");
    const long = deleteQuestion("delete_many", { ids: "x".repeat(2000) });
    expect(long.length).toBeLessThan(700);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("the per-client guard", () => {
  it("asks before deleting by default, and never about looking or ordinary changes", async () => {
    expect(DEFAULT_GUARD).toBe("ask_delete");
    const t = await start([client("acme", "Acme")], () => true);
    expect(text(await t.call("crm__find_contacts"))).toContain("Acme contact");
    expect(text(await t.call("crm__update_contact", { id: "c-1" }))).toContain("updated c-1 for Acme");
    expect(t.asked).toEqual([]);

    const res = await t.call("crm__delete_contact", { id: "c-1" });
    expect(text(res)).toContain("deleted c-1 for Acme");
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]).toMatchObject({ clientName: "Acme", connectionName: "CRM" });
    expect(t.asked[0]!.message).toContain('Let the AI run "delete_contact"?');
  });

  it("doesn't delete when the person says no, and tells the AI not to try another way", async () => {
    const t = await start([client("acme", "Acme", "ask_delete")], () => false);
    const res = await t.call("crm__delete_contact", { id: "c-1" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/The user didn't allow crm__delete_contact for Acme .* Nothing was deleted\. Don't try another way: ask the user\./);
    expect(text(res)).not.toContain("deleted c-1");
  });

  it("refuses to delete when there is no way to ask", async () => {
    const t = await start([client("acme", "Acme", "ask_delete")]);
    const res = await t.call("crm__delete_contact", { id: "c-1" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("couldn't ask the user first. Nothing was deleted.");
  });

  it('"Work freely" never asks, deleting included', async () => {
    const t = await start([client("acme", "Acme", "free")], () => false);
    expect(text(await t.call("crm__delete_contact", { id: "c-9" }))).toContain("deleted c-9 for Acme");
    expect(t.asked).toEqual([]);
  });

  it('"Look only" lets the AI read and nothing else, without asking', async () => {
    const t = await start([client("acme", "Acme", "look_only")], () => true);
    expect(text(await t.call("crm__find_contacts"))).toContain("Acme contact");
    for (const tool of ["crm__update_contact", "crm__delete_contact"]) {
      const res = await t.call(tool, { id: "c-1" });
      expect(res.isError, tool).toBe(true);
      expect(text(res), tool).toContain(`Acme is set to "Look only" in Ringkeeper Connect, so ${tool} wasn't run and nothing was changed.`);
    }
    expect(t.asked).toEqual([]);
  });

  it("is per client: switching client switches the rule", async () => {
    const t = await start([client("acme", "Acme", "look_only"), client("globex", "Globex", "free")], () => true);
    expect((await t.call("crm__update_contact", { id: "c-1" })).isError).toBe(true);
    await t.call("ringkeeper_use_client", { client: "Globex" });
    expect(text(await t.call("crm__update_contact", { id: "c-1" }))).toContain("updated c-1 for Globex");
  });
});

describe("what AI apps did for a client", () => {
  it("records each action with its kind, the AI app and how it ended, and never what was sent", async () => {
    const t = await start([client("acme", "Acme", "ask_delete")], (q) => !q.message.includes("c-no"));
    await t.call("crm__find_contacts", { q: "secret search words" });
    await t.call("crm__update_contact", { id: "c-1" });
    await t.call("crm__delete_contact", { id: "c-yes" });
    await t.call("crm__delete_contact", { id: "c-no" });
    expect(t.activity.map((a) => [a.tool, a.kind, a.outcome])).toEqual([
      ["find_contacts", "read", "ran"],
      ["update_contact", "change", "ran"],
      ["delete_contact", "delete", "ran"],
      ["delete_contact", "delete", "not_allowed"],
    ]);
    for (const a of t.activity) expect(a).toMatchObject({ clientId: "acme", connectionId: "crm", connectionName: "CRM", app: "Cursor" });
    expect(JSON.stringify(t.activity)).not.toMatch(/secret search words|c-yes|c-no/);
  });

  it("records refusals too: look only, and a call that names a different client", async () => {
    const t = await start([client("acme", "Acme", "look_only"), client("globex", "Globex")], () => true);
    await t.call("crm__update_contact", { id: "c-1" });
    await t.call("ringkeeper_call_tool", { client: "Globex", tool: "crm__find_contacts", arguments: {} });
    expect(t.activity.map((a) => [a.tool, a.outcome])).toEqual([
      ["update_contact", "look_only"],
      ["find_contacts", "wrong_client"],
    ]);
  });

  it("keeps the newest entries per client in a file, and forgets removed clients", () => {
    const file = join(tempDir(), "activity.json");
    const log = new ActivityLog(file, 60_000);
    const entry = (clientId: string, at: number): Activity => ({ at, clientId, connectionId: "crm", connectionName: "CRM", tool: "find_contacts", kind: "read", app: "Cursor", outcome: "ran" });
    for (let i = 0; i < ACTIVITY_PER_CLIENT + 5; i++) log.record(entry("acme", i));
    log.record(entry("globex", 1));
    expect(log.list("acme")).toHaveLength(ACTIVITY_PER_CLIENT);
    expect(log.list("acme")[0]!.at).toBe(ACTIVITY_PER_CLIENT + 4);
    log.flush();

    const again = new ActivityLog(file);
    expect(again.list("acme")).toHaveLength(ACTIVITY_PER_CLIENT);
    expect(again.list("globex")).toHaveLength(1);
    again.keepOnly(["acme"]);
    expect(again.list("globex")).toEqual([]);
    again.flush();
    expect(new ActivityLog(file).list("globex")).toEqual([]);
  });

  it("starts empty from a file it can't read, and drops entries that aren't in the expected shape", () => {
    const dir = tempDir();
    const bad = join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json");
    expect(new ActivityLog(bad).list("acme")).toEqual([]);
    const odd = join(dir, "odd.json");
    fs.writeFileSync(odd, JSON.stringify({ version: 1, clients: { acme: [{ at: "yesterday" }, { at: 1, clientId: "acme", connectionId: "c", connectionName: "C", tool: "t", kind: "read", app: "Cursor", outcome: "ran" }] } }));
    expect(new ActivityLog(odd).list("acme")).toHaveLength(1);
  });
});

describe("the setting, saved with the client", () => {
  const cipher: Cipher = {
    isAvailable: () => true,
    encrypt: (s) => Buffer.from(s, "utf8"),
    decrypt: (b) => b.toString("utf8"),
  };

  it("defaults to asking before deleting, is saved, and reaches the gateway's settings", () => {
    const dir = tempDir();
    const open = () => new ClientStore(join(dir, "clients.json"), new SecretStore(join(dir, "secrets.json"), cipher));
    const store = open();
    const acme = store.addClient("Acme");
    expect(acme.guard).toBe("ask_delete");
    expect(store.toGatewayConfig().clients[0]!.guard).toBe("ask_delete");

    store.setClientGuard(acme.id, "look_only");
    expect(open().list()[0]!.guard).toBe("look_only");
    expect(open().toGatewayConfig().clients[0]!.guard).toBe("look_only");
    expect(() => store.setClientGuard(acme.id, "anything" as ClientGuard)).toThrow(/three options/);
  });
});
