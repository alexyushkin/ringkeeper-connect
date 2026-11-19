// The built-in Microsoft 365 tools against a stand-in for Microsoft Graph (a fake fetch):
// which tools an account's access offers, what each sends and answers, and Microsoft's
// refusals in plain words.
import { describe, expect, it } from "vitest";
import { findService } from "../packages/catalog/src/index.js";
import { microsoft, MICROSOFT_ACCESS, MICROSOFT_ACCESS_KEYS, MICROSOFT_ALWAYS } from "../packages/tools/src/microsoft.js";
import { allowedTools } from "../packages/tools/src/server.js";
import { ToolError, type ToolContext } from "../packages/tools/src/types.js";

const TOKEN = "EwB4A8l6BAAU.secret-token-value";
const GRAPH = "https://fake.test/graph";

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  redirect?: string;
}
type Reply = { status?: number; json?: unknown; text?: string; bytes?: Buffer; headers?: Record<string, string> };
type Route = (req: Seen) => Reply | undefined;

function fakeGraph(route: Route) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const req: Seen = { method: init.method ?? "GET", url: new URL(String(input)), headers, body: typeof init.body === "string" ? init.body : "", redirect: init.redirect };
    seen.push(req);
    const reply = route(req) ?? { status: 404, json: { error: { code: "itemNotFound", message: "The resource could not be found." } } };
    const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
    const status = reply.status ?? 200;
    const content = [202, 204, 302].includes(status) ? null : (reply.bytes ?? text);
    return new Response(content, { status, headers: reply.headers });
  }) as typeof globalThis.fetch;
  const ctx: ToolContext = { token: TOKEN, fetch, base: (name) => `https://fake.test/${name}` };
  return { ctx, seen };
}

function toolNamed(name: string) {
  const t = microsoft.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

async function run(name: string, args: Record<string, unknown>, route: Route) {
  const { ctx, seen } = fakeGraph(route);
  const result = (await toolNamed(name).run(args, ctx)) as any;
  return { result, seen };
}

async function failure(name: string, args: Record<string, unknown>, route: Route = () => ({ json: {} })) {
  const { ctx, seen } = fakeGraph(route);
  try {
    await toolNamed(name).run(args, ctx);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return { err: err as ToolError, seen };
  }
  throw new Error("expected a failure");
}

const path = (req: Seen) => req.url.pathname.replace(/^\/graph/, "");
const person = (address: string) => ({ emailAddress: { address } });

// Ringkeeper's operations (adapters/vendors/microsoft.py), less the four that need its
// project folders and pictures (view_attachment, view_file, save_attachment, save_file).
const RINGKEEPER_OPS = [
  "get_me",
  "list_messages", "get_message", "get_thread", "list_mail_folders", "list_attachments", "read_attachment",
  "send_mail", "reply", "forward", "create_draft", "update_draft", "mark_message", "move_message", "send_draft", "reply_all", "delete_message",
  "list_calendars", "list_events_between", "get_event", "create_event", "update_event", "accept_event", "decline_event", "cancel_event", "delete_event",
  "get_my_drive", "list_my_files", "list_folder", "get_file", "read_file", "list_file_access", "search_files", "search_sites", "list_site_drives",
  "create_folder", "rename_file", "move_file", "copy_file", "delete_file", "share_file", "create_share_link", "remove_file_access",
];

describe("the Microsoft tool list", () => {
  it("has each of Ringkeeper's operations as a tool, with argument names any AI app takes", () => {
    expect(microsoft.tools.map((t) => t.name).sort()).toEqual([...RINGKEEPER_OPS].sort());
    for (const t of microsoft.tools) {
      expect(t.needs.length, t.name).toBeGreaterThan(0);
      for (const n of t.needs) expect(MICROSOFT_ACCESS_KEYS, t.name).toContain(n);
      // Claude's tool format refuses names like $select or @microsoft.graph.conflictBehavior.
      for (const p of Object.keys(t.inputSchema.properties)) expect(p, `${t.name}.${p}`).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/);
      expect(t.description.length, t.name).toBeGreaterThan(10);
    }
  });

  it("matches the tile's tick boxes", () => {
    const access = findService("microsoft")!.options[0]!.access!;
    expect(access.map((a) => a.id)).toEqual(MICROSOFT_ACCESS_KEYS);
    for (const a of access) expect({ label: a.label, scope: a.scope }, a.id).toEqual(MICROSOFT_ACCESS[a.id as keyof typeof MICROSOFT_ACCESS]);
    expect(findService("microsoft")!.options[0]!.scope).toBe(MICROSOFT_ALWAYS);
    expect(access.filter((a) => a.default).map((a) => a.id)).toEqual(["mail_read", "mail_drafts", "calendar_read", "files_read"]);
  });

  it("offers only what the ticked access allows: by default, reading and drafts, no sending, deleting mail or sharing", () => {
    const names = (keys: string[]) => allowedTools(microsoft, new Set(keys)).map((t) => t.name);
    const byDefault = names(["mail_read", "mail_drafts", "calendar_read", "files_read"]);
    expect(byDefault).toEqual(expect.arrayContaining(["get_me", "list_messages", "get_message", "create_draft", "move_message", "list_events_between", "read_file", "search_files"]));
    for (const n of ["send_mail", "reply", "send_draft", "delete_message", "create_event", "delete_file", "share_file", "create_share_link"]) expect(byDefault, n).not.toContain(n);
    // Sending alone can't read mail (Mail.Send doesn't).
    expect(names(["mail_send"])).toEqual(["get_me", "send_mail", "reply", "reply_all", "forward", "send_draft"]);
    expect(names(["files_share"])).toEqual(expect.arrayContaining(["share_file", "create_share_link", "remove_file_access", "list_file_access"]));
    expect(names(["files_share"])).not.toContain("delete_file");
    expect(names(["mail_delete"])).toContain("delete_message");
    expect(names(["mail_delete"])).not.toContain("move_message");
  });
});

describe("Outlook mail", () => {
  it("list_messages asks for a short list, newest first, and says how to read on", async () => {
    const next = `${GRAPH}/me/messages?%24select=id&%24top=20&%24skip=20`;
    const { result, seen } = await run("list_messages", { filter: "isRead eq false" }, () => ({
      json: { "@odata.context": "x", value: [{ id: "m1", subject: "Invoice", bodyPreview: "Hi" }], "@odata.nextLink": next },
    }));
    expect(path(seen[0]!)).toBe("/me/messages");
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toMatchObject({ $filter: "isRead eq false", $top: "20", $orderby: "receivedDateTime desc" });
    expect(seen[0]!.url.searchParams.get("$select")).toContain("bodyPreview");
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(result).toEqual({ value: [{ id: "m1", subject: "Invoice", bodyPreview: "Hi" }], next_page: "%24select=id&%24top=20&%24skip=20", note: expect.stringContaining("next_page") });

    const again = await run("list_messages", { next_page: result.next_page, filter: "ignored" }, () => ({ json: { value: [] } }));
    expect(Object.fromEntries(again.seen[0]!.url.searchParams)).toEqual({ $select: "id", $top: "20", $skip: "20" });
  });

  it("list_messages puts search words in quotes, without a sort Graph refuses with them", async () => {
    const { seen } = await run("list_messages", { search: "from:anna invoice", top: 5 }, () => ({ json: { value: [] } }));
    const q = Object.fromEntries(seen[0]!.url.searchParams);
    expect(q.$search).toBe('"from:anna invoice"');
    expect(q.$top).toBe("5");
    expect(q.$orderby).toBeUndefined();
  });

  it("get_message reads HTML as text, sets the quoted chain apart, and lists attachments without their content", async () => {
    const html = "<div><p>Thanks, see the attached figures.</p></div><div id=\"appendonsend\"></div><hr><div><b>From:</b> Anna<br><b>Sent:</b> Monday<br>Earlier text</div>";
    const { result, seen } = await run("get_message", { message_id: "AAMkAG=" }, (req) =>
      path(req) === "/me/messages/AAMkAG="
        ? {
            json: {
              id: "AAMkAG=",
              "@odata.etag": "W/1",
              subject: "Figures",
              bodyPreview: "Thanks",
              body: { contentType: "html", content: html },
              attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", id: "att1", name: "q3.csv", contentType: "text/csv", size: 120 }],
            },
          }
        : undefined,
    );
    expect(seen[0]!.url.searchParams.get("$expand")).toBe("attachments($select=id,name,contentType,size)");
    expect(result.id).toBe("AAMkAG=");
    expect(result.body).toContain("Thanks, see the attached figures.");
    expect(result.body).not.toContain("<p>");
    expect(result.attachments).toEqual([{ id: "att1", name: "q3.csv", type: "text/csv", size: 120 }]);
    expect(result).not.toHaveProperty("bodyPreview");
    expect(result).not.toHaveProperty("@odata.etag");
  });

  it("get_thread filters by the conversation, oldest first", async () => {
    const { result, seen } = await run("get_thread", { conversation_id: "AAQk'x" }, () => ({
      json: {
        value: [
          { id: "b", receivedDateTime: "2026-11-02T00:00:00Z", body: { contentType: "text", content: "second" } },
          { id: "a", receivedDateTime: "2026-11-01T00:00:00Z", body: { contentType: "text", content: "first" } },
        ],
      },
    }));
    expect(seen[0]!.url.searchParams.get("$filter")).toBe("conversationId eq 'AAQk''x'");
    expect(result.messages.map((m: any) => m.id)).toEqual(["a", "b"]);
    expect(result.total_messages).toBe(2);
  });

  it("read_attachment reads an attached file's text, and says when it's an attached item", async () => {
    const csv = "name,total\nAcme,120\n";
    const { result } = await run("read_attachment", { message_id: "m1", attachment_id: "att1" }, () => ({
      json: { name: "q3.csv", contentType: "text/csv", contentBytes: Buffer.from(csv).toString("base64") },
    }));
    expect(result).toMatchObject({ name: "q3.csv", size: csv.length });
    expect(result.text).toContain("Acme");
    const { err } = await failure("read_attachment", { message_id: "m1", attachment_id: "att2" }, () => ({ json: { name: "Fwd: plan", "@odata.type": "#microsoft.graph.itemAttachment" } }));
    expect(err.message).toBe("'Fwd: plan' is an attached item or a link, not a file, so it can't be read here.");
  });

  it("send_mail sends the message as given, and refuses a mailing before calling Microsoft", async () => {
    const message = { subject: "Hello", body: { contentType: "Text", content: "Hi Anna" }, toRecipients: [person("anna@acme.example")] };
    const { result, seen } = await run("send_mail", { message }, () => ({ status: 202 }));
    expect(seen[0]!.method).toBe("POST");
    expect(path(seen[0]!)).toBe("/me/sendMail");
    expect(JSON.parse(seen[0]!.body)).toEqual({ message, saveToSentItems: true });
    expect(result).toEqual({ done: true });

    const many = (n: number, at: string) => Array.from({ length: n }, (_, i) => person(`p${i}@${at}.example`));
    const { err, seen: none } = await failure("send_mail", { message: { ...message, toRecipients: many(30, "a"), bccRecipients: many(30, "b") } });
    expect(err.message).toBe("That would send to 60 people at once. Ringkeeper Connect sends to at most 50 in one email.");
    expect(none).toEqual([]);
    const { err: bad } = await failure("send_mail", { message: { ...message, toRecipients: [person("not an address")] } });
    expect(bad.message).toMatch(/message\.toRecipients\[0\]\.emailAddress\.address isn't in the expected form/);
  });

  it("create_draft saves a draft with its link, and marks its attachments as files", async () => {
    const { result, seen } = await run("create_draft", { subject: "Plan", toRecipients: [person("anna@acme.example")], attachments: [{ name: "a.txt", contentBytes: "aGk=" }] }, () => ({
      status: 201,
      json: { id: "d1", subject: "Plan", webLink: "https://outlook.office365.com/owa/?ItemID=d1" },
    }));
    expect(JSON.parse(seen[0]!.body).attachments).toEqual([{ name: "a.txt", contentBytes: "aGk=", "@odata.type": "#microsoft.graph.fileAttachment" }]);
    expect(result).toEqual({ saved: "draft", id: "d1", subject: "Plan", link: "https://outlook.office365.com/owa/?ItemID=d1" });
  });

  it("move_message won't move to Deleted Items: that's deleting", async () => {
    const { err, seen } = await failure("move_message", { message_id: "m1", destinationId: "DeletedItems" });
    expect(err.message).toMatch(/use delete_message, which needs "Delete mail" ticked/);
    expect(seen).toEqual([]);
    const { result } = await run("move_message", { message_id: "m1", destinationId: "archive" }, () => ({ status: 201, json: { id: "m1b", parentFolderId: "f9" } }));
    expect(result).toEqual({ moved: true, id: "m1b", folder: "f9" });
  });

  it("an edit with nothing to change isn't sent", async () => {
    const { err, seen } = await failure("update_draft", { message_id: "d1" });
    expect(err.message).toBe("Say what to change.");
    expect(seen).toEqual([]);
  });
});

describe("Outlook calendar", () => {
  it("list_events_between asks for the span, earliest first, in the time zone asked for", async () => {
    const { seen } = await run("list_events_between", { startDateTime: "2026-11-20T00:00:00Z", endDateTime: "2026-11-27T00:00:00Z", time_zone: "Eastern Standard Time" }, () => ({ json: { value: [] } }));
    expect(path(seen[0]!)).toBe("/me/calendarView");
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toMatchObject({ startDateTime: "2026-11-20T00:00:00Z", endDateTime: "2026-11-27T00:00:00Z", $orderby: "start/dateTime" });
    expect(seen[0]!.headers.prefer).toBe('outlook.timezone="Eastern Standard Time"');
    const { err } = await failure("list_events_between", { startDateTime: "2026-11-20T00:00:00Z" });
    expect(err.message).toBe("endDateTime is needed.");
  });

  it("get_event gives its description as text", async () => {
    const { result } = await run("get_event", { event_id: "e1" }, () => ({ json: { id: "e1", body: { contentType: "html", content: "<p>Agenda: <b>pricing</b></p>" } } }));
    expect(result.body).toEqual({ contentType: "text", content: "Agenda: pricing" });
  });

  it("create_event sends the event and refuses to invite a crowd", async () => {
    const event = { subject: "Kickoff", start: { dateTime: "2026-11-20T10:00:00", timeZone: "UTC" }, end: { dateTime: "2026-11-20T11:00:00", timeZone: "UTC" } };
    const { result, seen } = await run("create_event", event, () => ({ status: 201, json: { id: "e1", subject: "Kickoff", webLink: "https://outlook/e1" } }));
    expect(JSON.parse(seen[0]!.body)).toEqual(event);
    expect(result).toMatchObject({ id: "e1", link: "https://outlook/e1", online: null });
    const crowd = Array.from({ length: 51 }, (_, i) => person(`p${i}@acme.example`));
    const { err } = await failure("create_event", { ...event, attendees: crowd });
    expect(err.message).toMatch(/at most 50/);
  });
});

describe("OneDrive and SharePoint", () => {
  const word = (paragraph: string) => {
    // The smallest .docx our reader takes: a zip with word/document.xml, stored (not compressed).
    const xml = Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p></w:body></w:document>`);
    return zip([["word/document.xml", xml]]);
  };

  it("read_file fetches the signed link without the token, and never shows it", async () => {
    const signed = "https://files.fake.test/download?tempauth=SIGNED";
    const { result, seen } = await run("read_file", { drive_id: "b!abc", item_id: "01XYZ" }, (req) => {
      if (path(req) === "/drives/b!abc/items/01XYZ") return { json: { id: "01XYZ", name: "plan.docx", size: 900, file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, "@microsoft.graph.downloadUrl": signed } };
      if (path(req) === "/drives/b!abc/items/01XYZ/content") return { status: 302, headers: { location: signed } };
      if (req.url.toString() === signed) return { bytes: word("Budget for Acme") };
      return undefined;
    });
    expect(seen.map((r) => r.url.hostname)).toEqual(["fake.test", "fake.test", "files.fake.test"]);
    expect(seen[1]!.redirect).toBe("manual");
    expect(seen[2]!.headers.authorization).toBeUndefined();
    expect(result.text).toContain("Budget for Acme");
    expect(JSON.stringify(result)).not.toContain("SIGNED");
  });

  it("read_file says a folder is a folder", async () => {
    const { err } = await failure("read_file", { drive_id: "d", item_id: "f" }, () => ({ json: { id: "f", name: "Clients", folder: { childCount: 3 } } }));
    expect(err.message).toBe("'Clients' is a folder: list_folder shows what's in it.");
  });

  it("list_folder leaves out signed links and Graph's bookkeeping", async () => {
    const { result } = await run("list_folder", { drive_id: "d", item_id: "root" }, () => ({
      json: { "@odata.context": "x", value: [{ id: "1", name: "a.xlsx", "@microsoft.graph.downloadUrl": "https://signed", "@odata.etag": "e" }] },
    }));
    expect(result).toEqual({ value: [{ id: "1", name: "a.xlsx" }] });
  });

  it("create_folder sends Graph's own names", async () => {
    const { seen } = await run("create_folder", { drive_id: "d", item_id: "root", name: "Acme", conflictBehavior: "rename" }, () => ({ status: 201, json: { id: "n", name: "Acme", folder: { childCount: 0 } } }));
    expect(path(seen[0]!)).toBe("/drives/d/items/root/children");
    expect(JSON.parse(seen[0]!.body)).toEqual({ name: "Acme", "@microsoft.graph.conflictBehavior": "rename", folder: {} });
  });

  it("search_files asks Microsoft Search for drive items and lists what it found", async () => {
    const { result, seen } = await run("search_files", { query: "budget" }, () => ({
      json: { value: [{ hitsContainers: [{ total: 30, moreResultsAvailable: true, hits: [{ summary: "the <c0>budget</c0>", resource: { id: "1", name: "Budget.xlsx", size: 10, parentReference: { driveId: "d" }, webUrl: "https://x/1" } }] }] }] },
    }));
    expect(path(seen[0]!)).toBe("/search/query");
    expect(JSON.parse(seen[0]!.body)).toEqual({ requests: [{ entityTypes: ["driveItem"], query: { queryString: "budget" }, from: 0, size: 25 }] });
    expect(result).toMatchObject({ total: 30, next_from: 1, files: [{ id: "1", name: "Budget.xlsx", drive_id: "d", web_url: "https://x/1", summary: "the <c0>budget</c0>" }] });
  });

  it("search_sites sends a plain search, not $search", async () => {
    const { seen } = await run("search_sites", { search: "marketing" }, () => ({ json: { value: [] } }));
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toEqual({ search: "marketing" });
  });

  it("a path value can't climb out of its place", async () => {
    for (const bad of ["..", "a/b", "a?b", "a#b", "a%2Fb"]) {
      const { err, seen } = await failure("get_file", { drive_id: "d", item_id: bad });
      expect(err.message, bad).toMatch(/item_id isn't in the expected form/);
      expect(seen).toEqual([]);
    }
    const { seen } = await run("list_site_drives", { site_id: "acme.sharepoint.com,2C712604-1370-44E7,2D2244C3" }, () => ({ json: { value: [] } }));
    expect(path(seen[0]!)).toBe("/sites/acme.sharepoint.com,2C712604-1370-44E7,2D2244C3/drives");
  });
});

describe("Microsoft's refusals", () => {
  const refuse = (status: number, error: unknown, headers?: Record<string, string>) => () => ({ status, json: { error }, headers });

  it("a 401 says to sign in again", async () => {
    const { err } = await failure("get_me", {}, refuse(401, { code: "InvalidAuthenticationToken", message: "Access token has expired." }));
    expect(err.message).toBe("The Microsoft sign-in for this account has expired or was removed. Sign in to Microsoft again in Ringkeeper Connect.");
  });

  it("a 403 names the tick boxes that allow the tool, and the IT admin", async () => {
    const { err } = await failure("send_mail", { message: { subject: "x" } }, refuse(403, { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." }));
    expect(err.message).toContain('wasn\'t allowed "Send mail" at sign-in');
    expect(err.message).toContain("IT admin");
  });

  it("throttling, a missing mailbox, 404s and Microsoft's own trouble are plain too, and never carry the token", async () => {
    expect((await failure("get_me", {}, refuse(429, { code: "TooManyRequests", message: "slow down" }))).err.message).toMatch(/limiting how many requests/);
    expect((await failure("list_messages", {}, refuse(404, { code: "MailboxNotEnabledForRESTAPI", message: "REST API is not yet supported for this mailbox." }))).err.message).toMatch(/no Outlook mailbox/);
    expect((await failure("get_message", { message_id: "m1" }, refuse(404, { code: "ErrorItemNotFound", message: "nope" }))).err.message).toBe(
      "Microsoft couldn't find that message. Check the id, and that this account can see it.",
    );
    expect((await failure("get_me", {}, refuse(503, { code: "serviceNotAvailable", message: "down" }))).err.message).toBe("Microsoft had a problem (503). Try again in a moment.");
    const echoed = await failure("create_folder", { drive_id: "d", item_id: "root", name: "x" }, refuse(400, { code: "invalidRequest", message: `Bad token ${TOKEN}` }));
    expect(echoed.err.message).toBe("Microsoft didn't accept that: Bad token [hidden]");
  });

  it("a network failure says to check the connection", async () => {
    const ctx: ToolContext = {
      token: TOKEN,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      base: () => GRAPH,
    };
    await expect(toolNamed("get_me").run({}, ctx)).rejects.toThrow("Couldn't reach Microsoft. Check this computer's internet connection and try again.");
  });
});

/** A zip with stored (uncompressed) entries. */
function zip(entries: Array<[string, Buffer]>): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name);
    const sum = crc(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
