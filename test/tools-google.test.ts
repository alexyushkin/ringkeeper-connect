// The built-in Google tools against a stand-in for Google (a fake fetch): which tools an
// account's access offers, what each sends and answers, and Google's refusals in plain words.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { google } from "../packages/tools/src/google.js";
import { ACCESS_KEYS } from "../packages/tools/src/google/access.js";
import { mimeMessage } from "../packages/tools/src/google/gmail.js";
import { htmlToText, splitQuoted } from "../packages/tools/src/google/text.js";
import { allowedTools } from "../packages/tools/src/server.js";
import { ToolError, type ToolContext } from "../packages/tools/src/types.js";

const TOKEN = "ya29.secret-token-value";

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}
type Reply = { status?: number; json?: unknown; text?: string; bytes?: Buffer; headers?: Record<string, string> };
type Route = (req: Seen) => Reply | undefined;

/** A stand-in for Google: every API at https://fake.test/<name>, answered by `route`. */
function fakeGoogle(route: Route) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const raw = init.body;
    const body = raw === undefined || raw === null ? "" : typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8");
    const req: Seen = { method: init.method ?? "GET", url: new URL(String(input)), headers, body };
    seen.push(req);
    const reply = route(req) ?? { status: 404, json: { error: { code: 404, message: "Not Found" } } };
    const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
    const content = reply.status === 308 || reply.status === 204 ? null : (reply.bytes ?? text);
    return new Response(content, { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof globalThis.fetch;
  const ctx: ToolContext = { token: TOKEN, fetch, base: (name) => `https://fake.test/${name}` };
  return { ctx, seen };
}

function toolNamed(name: string) {
  const t = google.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

async function run(name: string, args: Record<string, unknown>, route: Route) {
  const { ctx, seen } = fakeGoogle(route);
  const result = (await toolNamed(name).run(args, ctx)) as any;
  return { result, seen };
}

async function failure(name: string, args: Record<string, unknown>, route: Route): Promise<ToolError> {
  const { ctx } = fakeGoogle(route);
  try {
    await toolNamed(name).run(args, ctx);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error("expected a failure");
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const path = (req: Seen) => req.url.pathname;

// Ringkeeper's NEEDS table (adapters/google.py), less the four tools left out here.
const RINGKEEPER_NEEDS: Record<string, string[]> = {
  search_mail: ["mail_read"],
  read_mail: ["mail_read"],
  read_attachment: ["mail_read"],
  get_thread: ["mail_read"],
  send_mail: ["mail_send", "mail_drafts"],
  create_draft: ["mail_drafts"],
  trash_mail: ["mail_trash"],
  search_files: ["drive_files", "drive_read_all"],
  read_file: ["drive_files", "drive_read_all"],
  upload_file: ["drive_files"],
  share_file: ["drive_files"],
  list_events: ["calendar_read", "calendar_write"],
  create_event: ["calendar_write"],
  read_sheet: ["sheets_read", "sheets_write"],
  update_sheet: ["sheets_write"],
  append_rows: ["sheets_write"],
  read_doc: ["docs_read", "docs_write"],
  create_doc: ["docs_write"],
  edit_doc: ["docs_write"],
  list_search_sites: ["search_console_read"],
  search_performance: ["search_console_read"],
  list_analytics_properties: ["analytics_read"],
  analytics_report: ["analytics_read"],
  youtube_channel: ["youtube_read", "youtube_manage"],
  youtube_videos: ["youtube_read", "youtube_manage"],
  youtube_comments: ["youtube_read", "youtube_manage"],
  youtube_report: ["youtube_analytics"],
  // Google Ads (Ringkeeper's google_ads vendor: list_accounts, report, pause_campaign).
  list_ads_accounts: ["ads_read", "ads_pause"],
  ads_report: ["ads_read", "ads_pause"],
  ads_pause_campaigns: ["ads_pause"],
  upload_video: ["youtube_upload", "youtube_manage"],
  edit_video: ["youtube_manage"],
  set_video_privacy: ["youtube_manage"],
  delete_video: ["youtube_manage"],
  reply_to_comment: ["youtube_manage"],
  delete_comment: ["youtube_manage"],
};

describe("the Google tool list", () => {
  it("has unique, valid names, and needs only the 20 access keys", () => {
    const names = google.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of google.tools) {
      expect(t.name).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(t.needs.length).toBeGreaterThan(0);
      for (const n of t.needs) expect(ACCESS_KEYS).toContain(n);
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(10);
    }
    expect(ACCESS_KEYS).toHaveLength(20);
  });

  it("matches Ringkeeper's tool-to-access table", () => {
    expect(Object.fromEntries(google.tools.map((t) => [t.name, t.needs]))).toEqual(RINGKEEPER_NEEDS);
  });

  it("offers only the tools the ticked access allows", () => {
    const read = allowedTools(google, new Set(["mail_read"])).map((t) => t.name);
    expect(read.sort()).toEqual(["get_thread", "read_attachment", "read_mail", "search_mail"]);
    expect(read).not.toContain("send_mail");

    const drafts = allowedTools(google, new Set(["mail_drafts"])).map((t) => t.name);
    expect(drafts.sort()).toEqual(["create_draft", "send_mail"]);

    const sheets = allowedTools(google, new Set(["sheets_read"])).map((t) => t.name);
    expect(sheets).toEqual(["read_sheet"]);

    expect(allowedTools(google, new Set())).toEqual([]);
    expect(allowedTools(google, new Set(ACCESS_KEYS))).toHaveLength(google.tools.length);
  });
});

describe("Gmail", () => {
  const html = `<html><head><style>p{color:red}</style></head><body><p>Hi Anna,</p><p>See <a href="https://acme.example/plan">the plan</a> &amp; reply.</p><table><tr><td>Q1</td><td>10</td></tr></table></body></html>`;
  const message = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    threadId: `t-${id}`,
    labelIds: id === "msg000001" ? ["INBOX", "UNREAD"] : ["INBOX"],
    snippet: "snippet",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Anna <anna@acme.example>" },
        { name: "To", value: "me@agency.example" },
        { name: "Subject", value: `Hello ${id}` },
        { name: "Date", value: "Mon, 16 Nov 2026 10:00:00 +0000" },
      ],
      parts: [
        { partId: "0", mimeType: "text/html", body: { data: b64(html) } },
        { partId: "1", mimeType: "text/csv", filename: "numbers.csv", body: { size: 12, attachmentId: "ATT-LONG-ID" } },
      ],
    },
    ...extra,
  });

  it("search_mail answers a shaped list with previews", async () => {
    const { result, seen } = await run("search_mail", { query: "from:anna" }, (req) => {
      if (path(req) === "/gmail/messages") return { json: { messages: [{ id: "msg000001" }, { id: "msg000002" }] } };
      if (path(req) === "/gmail/profile") return { json: { emailAddress: "me@agency.example" } };
      const id = path(req).split("/").pop()!;
      return { json: message(id) };
    });
    const list = seen.find((r) => path(r) === "/gmail/messages")!;
    expect(list.url.searchParams.get("q")).toBe("from:anna");
    expect(list.url.searchParams.get("maxResults")).toBe("20");
    expect(list.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(result.account).toBe("me@agency.example");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({
      id: "msg000001",
      thread_id: "t-msg000001",
      from: "Anna <anna@acme.example>",
      to: "me@agency.example",
      subject: "Hello msg000001",
      date: "Mon, 16 Nov 2026 10:00:00 +0000",
      unread: true,
      preview: "Hi Anna, See the plan (https://acme.example/plan) & reply. Q1 | 10",
    });
    expect(result.messages[1].unread).toBe(false);
  });

  it("read_mail gives the text, the quoted chain apart, attachments, and parts", async () => {
    const plain = "Thanks, that works.\n\nOn Mon, 16 Nov 2026, Anna <anna@acme.example> wrote:\n> Does Tuesday work?\n";
    const got = (id: string) =>
      message(id, {
        payload: {
          headers: [{ name: "Subject", value: "Re: Tuesday" }, { name: "Cc", value: "bo@acme.example" }],
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64(plain) } },
            { mimeType: "text/html", body: { data: b64("<p>Thanks</p>") } },
            { partId: "2", mimeType: "application/pdf", filename: "deck.pdf", body: { size: 999, attachmentId: "x" } },
          ],
        },
      });
    const { result, seen } = await run("read_mail", { message_id: "msg000009" }, () => ({ json: got("msg000009") }));
    expect(path(seen[0]!)).toBe("/gmail/messages/msg000009");
    expect(seen[0]!.url.searchParams.get("format")).toBe("full");
    expect(result).toMatchObject({
      id: "msg000009",
      subject: "Re: Tuesday",
      cc: "bo@acme.example",
      body: "Thanks, that works.",
      quoted: "On Mon, 16 Nov 2026, Anna <anna@acme.example> wrote:\n> Does Tuesday work?",
      truncated: false,
      next_offset: null,
      attachments: [{ id: "2", name: "deck.pdf", type: "application/pdf", size: 999 }],
    });

    const part = await run("read_mail", { message_id: "msg000009", limit: 6, include_quoted: true }, () => ({ json: got("msg000009") }));
    expect(part.result.body).toBe("Thanks");
    expect(part.result.truncated).toBe(true);
    expect(part.result.next_offset).toBe(6);
    expect(part.result.quoted).toBeUndefined();
  });

  it("read_attachment fetches the part's data and reads it", async () => {
    const { result, seen } = await run("read_attachment", { message_id: "msg000001", attachment_id: "1" }, (req) => {
      if (path(req).endsWith("/attachments/ATT-LONG-ID")) return { json: { data: b64("name,n\nAcme,3\n") } };
      return { json: message("msg000001") };
    });
    expect(seen.map(path)).toEqual(["/gmail/messages/msg000001", "/gmail/messages/msg000001/attachments/ATT-LONG-ID"]);
    expect(result).toMatchObject({ name: "numbers.csv", type: "text/csv", size: 14, text: "name,n\nAcme,3\n", truncated: false });
  });

  it("send_mail builds a base64url RFC 2822 message", async () => {
    const { result, seen } = await run(
      "send_mail",
      { to: ["anna@acme.example", "bo@acme.example"], subject: "Grüße — café", body: "Hello Anna,\nsee you Tuesday.", cc: ["cc@acme.example"] },
      () => ({ json: { id: "sent123", threadId: "t1" } }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(path(seen[0]!)).toBe("/gmail/messages/send");
    const sent = JSON.parse(seen[0]!.body);
    expect(sent.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sent.threadId).toBeUndefined();
    const mime = Buffer.from(sent.raw, "base64url").toString("utf8");
    const [head, body] = mime.split("\r\n\r\n");
    expect(head).toContain("To: anna@acme.example, bo@acme.example\r\n");
    expect(head).toContain("Cc: cc@acme.example\r\n");
    expect(head).toContain("MIME-Version: 1.0");
    expect(head).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(head).toContain("Content-Transfer-Encoding: 7bit");
    const subject = /Subject: (.*(?:\r\n .*)*)/.exec(head!)![1]!;
    expect(subject).toMatch(/^=\?UTF-8\?B\?/);
    const decoded = subject
      .split("\r\n ")
      .map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)![1]!, "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe("Grüße — café");
    expect(body).toBe("Hello Anna,\r\nsee you Tuesday.\r\n");
    expect(result).toEqual({ sent: true, to: ["anna@acme.example", "bo@acme.example"], id: "sent123" });
  });

  it("send_mail answers in the thread, and encodes a non-ASCII body", async () => {
    const { seen } = await run("send_mail", { to: ["anna@acme.example"], subject: "Re: Plan", body: "Danke schön", reply_to: "orig000001" }, (req) => {
      if (req.method === "GET") {
        return { json: { id: "orig000001", threadId: "thread-7", payload: { headers: [{ name: "Message-ID", value: "<abc@mail.example>" }] } } };
      }
      return { json: { id: "sent" } };
    });
    expect(seen[0]!.url.searchParams.get("format")).toBe("metadata");
    expect(seen[0]!.url.searchParams.getAll("metadataHeaders")).toEqual(["Message-ID"]);
    const sent = JSON.parse(seen[1]!.body);
    expect(sent.threadId).toBe("thread-7");
    const mime = Buffer.from(sent.raw, "base64url").toString("utf8");
    expect(mime).toContain("In-Reply-To: <abc@mail.example>\r\nReferences: <abc@mail.example>\r\n");
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    const body = mime.split("\r\n\r\n")[1]!;
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Danke schön\r\n");
  });

  it("keeps line breaks out of headers", () => {
    const mime = mimeMessage({ to: ["a@b.example"], subject: "Hi\r\nBcc: evil@x.example", body: "x" });
    expect(mime).not.toMatch(/^Bcc:/m);
  });

  it("create_draft saves a draft with its Gmail link", async () => {
    const { result } = await run("create_draft", { to: ["anna@acme.example"], subject: "Plan", body: "Draft text" }, (req) => {
      if (path(req) === "/gmail/drafts") return { json: { id: "r-123", message: { id: "m-456" } } };
      if (path(req) === "/gmail/profile") return { json: { emailAddress: "me@agency.example" } };
      return undefined;
    });
    expect(result).toEqual({
      saved: "draft",
      id: "r-123",
      to: ["anna@acme.example"],
      subject: "Plan",
      link: "https://mail.google.com/mail/?authuser=me%40agency.example#drafts?compose=m-456",
    });
  });

  it("checks arguments before calling Google", async () => {
    const { ctx, seen } = fakeGoogle(() => ({ json: {} }));
    await expect(toolNamed("read_mail").run({ message_id: "../../drafts" }, ctx)).rejects.toThrow(ToolError);
    await expect(toolNamed("send_mail").run({ to: [], subject: "x", body: "y" }, ctx)).rejects.toThrow("to can't be empty");
    await expect(toolNamed("send_mail").run({ to: ["not an address"], subject: "x", body: "y" }, ctx)).rejects.toThrow(ToolError);
    await expect(toolNamed("search_mail").run({ limit: 500 }, ctx)).rejects.toThrow("at most 50");
    expect(seen).toHaveLength(0);
  });
});

describe("Google's refusals", () => {
  it("a 401 says to sign in again, without the token", async () => {
    const err = await failure("search_mail", {}, () => ({ status: 401, json: { error: { code: 401, message: `Invalid Credentials for ${TOKEN}`, status: "UNAUTHENTICATED" } } }));
    expect(err.message).toBe("The Google sign-in for this account has expired or was removed. Sign in to Google again in Ringkeeper Connect.");
    expect(err.message).not.toContain(TOKEN);
  });

  it("a 403 for missing access names the access to tick", async () => {
    const scope = {
      status: 403,
      json: {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          status: "PERMISSION_DENIED",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
        },
      },
    };
    const send = await failure("send_mail", { to: ["anna@acme.example"], subject: "x", body: "y" }, () => scope);
    expect(send.message).toBe('This Google account wasn\'t given "Send mail". Sign in to Google again in Ringkeeper Connect and tick it.');
    const sheet = await failure("read_sheet", { spreadsheet_id: "sheet123456", cells: "A1:B2" }, () => scope);
    expect(sheet.message).toContain('"Sheets: read" or "Sheets: read and edit"');
    expect(sheet.message).not.toContain(TOKEN);
  });

  it("other refusals are plain too, and never carry the token", async () => {
    const other = await failure("read_file", { file_id: "file123456" }, () => ({
      status: 403,
      json: { error: { code: 403, message: "The user does not have sufficient permissions for this file.", errors: [{ reason: "insufficientFilePermissions" }] } },
    }));
    expect(other.message).toBe("Google refused this: The user does not have sufficient permissions for this file.. This account may not have access to it.");
    const missing = await failure("read_doc", { document_id: "doc1234567" }, () => ({ status: 404, json: { error: { code: 404, message: "not found" } } }));
    expect(missing.message).toBe("Google couldn't find that document. Check the id, and that this account can see it.");
    const busy = await failure("list_search_sites", {}, () => ({ status: 429, json: { error: { code: 429, message: "slow down" } } }));
    expect(busy.message).toContain("Wait a minute and try again");
    const bad = await failure("list_search_sites", {}, () => ({ status: 400, json: { error: { message: `bad header Bearer ${TOKEN}` } } }));
    expect(bad.message).toBe("Google didn't accept that: bad header Bearer [hidden]");
    const { ctx } = fakeGoogle(() => undefined);
    const offline: ToolContext = { ...ctx, fetch: (async () => { throw new TypeError(`fetch failed ${TOKEN}`); }) as typeof fetch };
    await expect(toolNamed("list_search_sites").run({}, offline)).rejects.toThrow("Couldn't reach Google. Check this computer's internet connection and try again.");
  });
});

describe("Sheets and Docs", () => {
  it("read_sheet reads the A1 range it was given", async () => {
    const { result, seen } = await run("read_sheet", { spreadsheet_id: "1AbCdEfGhIj", cells: "Leads!A1:D20" }, () => ({
      json: { range: "Leads!A1:D20", majorDimension: "ROWS", values: [["Name", "Email"], ["Anna", "anna@acme.example"]] },
    }));
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url.href).toBe("https://fake.test/sheets/1AbCdEfGhIj/values/Leads%21A1%3AD20");
    expect(result).toEqual({ range: "Leads!A1:D20", rows: [["Name", "Email"], ["Anna", "anna@acme.example"]] });
  });

  it("update_sheet overwrites the range as typed", async () => {
    const rows = [["Anna", 3, true, null], ["=SUM(B1:B1)", 2.5, false, "x"]];
    const { result, seen } = await run("update_sheet", { spreadsheet_id: "1AbCdEfGhIj", cells: "'Q1 Leads'!A2", rows }, () => ({
      json: { updatedRange: "'Q1 Leads'!A2:D3", updatedCells: 8 },
    }));
    const req = seen[0]!;
    expect(req.method).toBe("PUT");
    expect(req.url.pathname).toBe("/sheets/1AbCdEfGhIj/values/%27Q1%20Leads%27%21A2");
    expect(req.url.searchParams.get("valueInputOption")).toBe("USER_ENTERED");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body)).toEqual({ values: rows });
    expect(result).toEqual({ updated: "'Q1 Leads'!A2:D3", cells: 8 });
  });

  it("append_rows adds after the table", async () => {
    const { result, seen } = await run("append_rows", { spreadsheet_id: "1AbCdEfGhIj", cells: "Leads!A1", rows: [["Bo"]] }, () => ({
      json: { updates: { updatedRange: "Leads!A7", updatedRows: 1 } },
    }));
    expect(seen[0]!.url.pathname).toBe("/sheets/1AbCdEfGhIj/values/Leads%21A1:append");
    expect(seen[0]!.url.searchParams.get("insertDataOption")).toBe("INSERT_ROWS");
    expect(result).toEqual({ appended: "Leads!A7", rows: 1 });
  });

  it("read_doc gives the document's text, tables as tab-separated rows", async () => {
    const doc = {
      documentId: "doc1234567",
      title: "Brief",
      revisionId: "rev1",
      body: {
        content: [
          { sectionBreak: {} },
          { paragraph: { elements: [{ textRun: { content: "Goals\n" } }] } },
          {
            table: {
              tableRows: [
                { tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: "Q1\n" } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: "10\n" } }] } }] }] },
              ],
            },
          },
        ],
      },
    };
    const { result } = await run("read_doc", { document_id: "doc1234567" }, () => ({ json: doc }));
    expect(result).toMatchObject({ document_id: "doc1234567", title: "Brief", revision_id: "rev1", text: "Goals\nQ1\t10\n", total_chars: 12 });
  });

  it("edit_doc replaces and appends in one batch", async () => {
    const { result, seen } = await run(
      "edit_doc",
      { document_id: "doc1234567", replace: [{ find: "2025", replace_with: "2026" }], append: "\nThe end." },
      () => ({ json: { replies: [{ replaceAllText: { occurrencesChanged: 3 } }, {}] } }),
    );
    expect(seen[0]!.url.pathname).toBe("/docs/documents/doc1234567:batchUpdate");
    expect(JSON.parse(seen[0]!.body).requests).toEqual([
      { replaceAllText: { containsText: { text: "2025", matchCase: true }, replaceText: "2026" } },
      { insertText: { text: "\nThe end.", endOfSegmentLocation: {} } },
    ]);
    expect(result).toMatchObject({ edited: "doc1234567", replaced: [3], appended_chars: 9 });
  });
});

// A .zip, written by hand, for Office files.
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const packed = deflateRawSync(data);
    const n = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, packed);
    centrals.push(central, n);
    offset += 30 + n.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

describe("Drive", () => {
  it("read_file exports a Google Doc as text", async () => {
    const { result, seen } = await run("read_file", { file_id: "file123456" }, (req) => {
      if (path(req) === "/drive/files/file123456") return { json: { id: "file123456", name: "Plan", mimeType: "application/vnd.google-apps.document" } };
      if (path(req) === "/drive/files/file123456/export") return { text: "The plan." };
      return undefined;
    });
    expect(seen[1]!.url.searchParams.get("mimeType")).toBe("text/plain");
    expect(result).toMatchObject({ id: "file123456", name: "Plan", text: "The plan.", total_chars: 9 });
  });

  it("read_file reads a Word document's text and table", async () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const docx = zip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> &amp; welcome</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
    });
    const { result } = await run("read_file", { file_id: "file123456" }, (req) => {
      if (req.url.searchParams.get("alt") === "media") return { bytes: docx };
      return { json: { id: "file123456", name: "brief.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } };
    });
    expect(result.text).toBe("Hello & welcome\nA | B");
  });

  it("upload_file sends a multipart upload", async () => {
    const { result, seen } = await run("upload_file", { name: "notes.csv", content: "a,b\n1,2", mime_type: "text/csv", as_google_doc: true }, () => ({
      json: { id: "new1", name: "notes.csv", webViewLink: "https://drive.example/new1" },
    }));
    expect(seen[0]!.url.pathname).toBe("/upload/drive/v3/files");
    expect(seen[0]!.url.searchParams.get("uploadType")).toBe("multipart");
    expect(seen[0]!.headers["content-type"]).toBe("multipart/related; boundary=ringkeeper-upload");
    expect(seen[0]!.body).toContain('"mimeType":"application/vnd.google-apps.spreadsheet"');
    expect(seen[0]!.body).toContain("Content-Type: text/csv; charset=UTF-8\r\n\r\na,b\n1,2\r\n--ringkeeper-upload--");
    expect(result.id).toBe("new1");
  });
});

describe("Calendar, Search Console, Analytics", () => {
  it("list_events asks for the whole days and shapes the events", async () => {
    const { result, seen } = await run("list_events", { start: "2026-11-03", end: "2026-11-04" }, () => ({
      json: { items: [{ id: "e1", summary: "Call", start: { dateTime: "x" }, end: { dateTime: "y" }, attendees: [{ email: "a@b.example" }], htmlLink: "L" }] },
    }));
    expect(seen[0]!.url.searchParams.get("timeMin")).toBe("2026-11-03T00:00:00Z");
    expect(seen[0]!.url.searchParams.get("timeMax")).toBe("2026-11-04T23:59:59Z");
    expect(result.events[0]).toEqual({ id: "e1", title: "Call", start: { dateTime: "x" }, end: { dateTime: "y" }, location: undefined, attendees: ["a@b.example"], link: "L" });
  });

  it("analytics_report gives rows by column name", async () => {
    const { result, seen } = await run("analytics_report", { property_id: "properties/123", start: "7daysAgo", end: "today", metrics: ["sessions"], dimensions: ["date"] }, () => ({
      json: { dimensionHeaders: [{ name: "date" }], metricHeaders: [{ name: "sessions" }], rows: [{ dimensionValues: [{ value: "20261101" }], metricValues: [{ value: "42" }] }], rowCount: 1 },
    }));
    expect(seen[0]!.url.pathname).toBe("/analyticsdata/properties/123:runReport");
    expect(JSON.parse(seen[0]!.body)).toEqual({ dateRanges: [{ startDate: "7daysAgo", endDate: "today" }], metrics: [{ name: "sessions" }], dimensions: [{ name: "date" }], limit: 100 });
    expect(result).toEqual({ rows: [{ date: "20261101", sessions: "42" }], row_count: 1 });
  });

  it("search_performance quotes the site in the path", async () => {
    const { seen } = await run("search_performance", { site: "sc-domain:acme.example", start: "2026-10-01", end: "2026-10-31" }, () => ({ json: { rows: [] } }));
    expect(seen[0]!.url.pathname).toBe("/webmasters/sites/sc-domain%3Aacme.example/searchAnalytics/query");
    expect(JSON.parse(seen[0]!.body)).toEqual({ startDate: "2026-10-01", endDate: "2026-10-31", dimensions: ["query"], rowLimit: 100 });
  });
});

describe("YouTube", () => {
  it("refuses a schedule that can't work before calling Google", async () => {
    const { ctx, seen } = fakeGoogle(() => ({ json: {} }));
    const set = toolNamed("set_video_privacy");
    await expect(set.run({ video_id: "abcdef123", privacy: "public", publish_at: "2099-01-01T10:00:00Z" }, ctx)).rejects.toThrow("set privacy to private");
    await expect(set.run({ video_id: "abcdef123", privacy: "private", publish_at: "2020-01-01T10:00:00Z" }, ctx)).rejects.toThrow("That time has passed");
    await expect(set.run({ video_id: "abcdef123", privacy: "private", publish_at: "2099-01-01T10:00:00" }, ctx)).rejects.toThrow("needs its time zone");
    expect(seen).toHaveLength(0);
  });

  it("upload_video sends a file from this computer in parts", async () => {
    const folder = await mkdtemp(join(tmpdir(), "rk-yt-"));
    try {
      const file = join(folder, "clip.mp4");
      await writeFile(file, Buffer.from("0123456789"));
      const { result, seen } = await run("upload_video", { file, title: "Launch", made_for_kids: false }, (req) => {
        if (req.method === "POST") return { headers: { Location: "https://fake.test/session/abc" } };
        if (req.method === "PUT") return { json: { id: "vid123", status: { privacyStatus: "private" } } };
        return undefined;
      });
      expect(seen[0]!.url.pathname).toBe("/upload/youtube/v3/videos");
      expect(seen[0]!.headers["x-upload-content-length"]).toBe("10");
      expect(seen[0]!.headers["x-upload-content-type"]).toBe("video/mp4");
      expect(JSON.parse(seen[0]!.body).status).toEqual({ privacyStatus: "private", selfDeclaredMadeForKids: false });
      expect(seen[1]!.url.href).toBe("https://fake.test/session/abc");
      expect(seen[1]!.headers["content-range"]).toBe("bytes 0-9/10");
      expect(result).toEqual({ video_id: "vid123", status: { privacyStatus: "private" } });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe("mail text", () => {
  it("turns HTML into readable text", () => {
    expect(htmlToText("<div>Hi&nbsp;there<br>line two</div><ul><li>one</li><li>two</li></ul><script>x()</script><img alt='Logo'>")).toBe(
      "Hi there\nline two\n\n- one\n- two\n[Logo]",
    );
    expect(htmlToText('<a href="mailto:anna@acme.example">anna@acme.example</a>')).toBe("anna@acme.example");
    expect(htmlToText("<blockquote>quoted</blockquote>")).toBe("> quoted");
  });

  it("sets an Outlook reply chain apart, but not a forward", () => {
    expect(splitQuoted("Yes.\n\nFrom: Anna\nSent: Monday\nTo: me\n\nOld text")).toEqual(["Yes.", "From: Anna\nSent: Monday\nTo: me\n\nOld text"]);
    expect(splitQuoted("FYI\n---------- Forwarded message ---------\nFrom: Anna\nSent: x")[1]).toBe("");
  });
});
