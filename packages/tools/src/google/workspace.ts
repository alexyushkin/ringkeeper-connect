// Drive, Calendar, Sheets and Docs.
// Left out from Ringkeeper: view_file (answers with an image; these tools answer text) and
// save_file (saves into a Ringkeeper project's folder, which has no equivalent here).
import { ToolError } from "../types.js";
import { extract, MAX_FILE_BYTES, textAnswer, type Extracted } from "./extract.js";
import { INSIDE, PAGES, READ_PARTS } from "./gmail.js";
import { quoteAll, type Json } from "./http.js";
import { arg, ID_PATTERN, s, tool, type Schema } from "./schema.js";
import { page } from "./text.js";

// --- Drive ---

function driveQuery(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const words = text ? `(name contains '${escaped}' or fullText contains '${escaped}') and ` : "";
  return `${words}trashed = false`;
}

// A Doc, a Sheet or a Slides deck, as the text it's read as.
const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const FILE_ID = s.id("The file id, from search_files.");

// --- Calendar ---

const WHEN: Schema = s.str({ maxLength: 40, description: "RFC 3339 date-time (2026-11-03T15:00:00-05:00), or a date (2026-11-03) for all day." });
const when = (value: string): Json => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value });

// --- Sheets ---

const SHEET_ID = s.id("The spreadsheet id (in its URL, after /d/).");
const RANGE: Schema = s.str({ minLength: 1, maxLength: 200, description: "A range in A1 notation, e.g. Leads!A1:D20." });
const ROWS: Schema = s.list(s.list({ type: ["string", "number", "boolean", "null"] }), { minItems: 1, maxItems: 1000 });
const cellsPath = (id: string, cells: string) => `/${quoteAll(id)}/values/${quoteAll(cells)}`;

// --- Docs ---

const DOC_ID = s.id("The document id (in its URL, after /d/).");
const DOC_TEXT: Schema = s.str({ minLength: 1, maxLength: 100_000 });
const docLink = (id: string) => `https://docs.google.com/document/d/${id}/edit`;

/** A document's words, in order: paragraphs, each table cell's, and a table of contents. */
export function docText(elements: Json[]): string {
  const parts: string[] = [];
  for (const item of elements) {
    if (item.paragraph) {
      for (const run of (item.paragraph.elements ?? []) as Json[]) parts.push(String(run.textRun?.content ?? ""));
    } else if (item.table) {
      for (const row of (item.table.tableRows ?? []) as Json[]) {
        const cells = ((row.tableCells ?? []) as Json[]).map((cell) => docText(cell.content ?? []).trim());
        parts.push(`${cells.join("\t")}\n`);
      }
    } else if (item.tableOfContents) {
      parts.push(docText(item.tableOfContents.content ?? []));
    }
  }
  return parts.join("");
}

export const workspaceTools = [
  tool({
    name: "search_files",
    description: 'Find Drive files (id, name, type, modified, link). With "files Ringkeeper Connect creates or is given" access, only those files are visible.',
    needs: ["drive_files", "drive_read_all"],
    properties: { query: s.str({ description: "Words in the file's name or text.", maxLength: 300, default: "" }), limit: s.limit(20) },
    async run(a, g) {
      const found = await g.json("drive", "GET", "/files", {
        params: {
          q: driveQuery(arg.str(a, "query")),
          pageSize: arg.int(a, "limit"),
          orderBy: "modifiedTime desc",
          fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        },
      });
      return { files: found.files ?? [] };
    },
  }),
  tool({
    name: "read_file",
    description:
      "Read a Drive file's text: Docs and Slides as text, Sheets as CSV, text files as they are, and what's in Word, Excel, PowerPoint and .zip files. A long file starts with its outline: read on with pages=. PDFs and pictures can't be read here.",
    needs: ["drive_files", "drive_read_all"],
    properties: { file_id: FILE_ID, pages: PAGES, inside: INSIDE, ...READ_PARTS },
    required: ["file_id"],
    async run(a, g) {
      const id = arg.str(a, "file_id");
      const meta = await g.json("drive", "GET", `/files/${quoteAll(id)}`, { params: { fields: "id,name,mimeType" }, what: "that file" });
      const mime = String(meta.mimeType ?? "");
      let path = `/files/${quoteAll(id)}`;
      let params: Json = { alt: "media" };
      if (EXPORTS[mime]) {
        path += "/export";
        params = { mimeType: EXPORTS[mime] };
      } else if (mime.startsWith("application/vnd.google-apps.")) {
        throw new ToolError(`'${meta.name}' is a Google ${mime.split(".").pop()}, which has nothing to read here.`);
      }
      const response = await g.raw("drive", "GET", path, { params, what: "that file", timeoutMs: 120_000 });
      if (Number(response.headers.get("content-length") ?? 0) > MAX_FILE_BYTES) {
        throw new ToolError(`'${meta.name}' is too large to read here.`);
      }
      const content = Buffer.from(await response.arrayBuffer());
      const answer = { id, name: meta.name, type: mime };
      const found: Extracted = EXPORTS[mime]
        ? { text: content.toString("utf8"), kind: "text", pages: [], unit: "page", pictures: 0 }
        : extract(String(meta.name ?? ""), mime, content, arg.opt(a, "inside"));
      return textAnswer(answer, found, arg.int(a, "offset"), arg.int(a, "limit"), arg.opt(a, "pages"));
    },
  }),
  tool({
    name: "upload_file",
    description: "Create a file in Drive from text. It's then one of the files this connection can see.",
    needs: ["drive_files"],
    properties: {
      name: s.str({ minLength: 1, maxLength: 255 }),
      content: s.str({ maxLength: 1_000_000 }),
      mime_type: s.str({ pattern: "^[\\w.+-]+/[\\w.+-]+$", default: "text/plain" }),
      folder_id: s.str({ pattern: ID_PATTERN }),
      as_google_doc: s.bool({ default: false, description: "Convert to a Google Doc (text) or Sheet (CSV)." }),
    },
    required: ["name", "content"],
    async run(a, g) {
      const mimeType = arg.str(a, "mime_type");
      const meta: Json = { name: arg.str(a, "name") };
      const folder = arg.opt(a, "folder_id");
      if (folder) meta.parents = [folder];
      if (arg.bool(a, "as_google_doc")) {
        meta.mimeType = mimeType === "text/csv" ? "application/vnd.google-apps.spreadsheet" : "application/vnd.google-apps.document";
      }
      const boundary = "ringkeeper-upload";
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${arg.str(a, "content")}\r\n--${boundary}--`;
      return g.json("upload", "POST", "/drive/v3/files", {
        params: { uploadType: "multipart", fields: "id,name,webViewLink" },
        body: Buffer.from(body, "utf8"),
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        what: "that folder",
      });
    },
  }),
  tool({
    name: "share_file",
    description: "Share a Drive file with someone.",
    needs: ["drive_files"],
    properties: {
      file_id: FILE_ID,
      email: s.address(),
      role: s.oneOf(["reader", "commenter", "writer"], { default: "reader" }),
      notify: s.bool({ default: true, description: "Email them that it's shared." }),
    },
    required: ["file_id", "email"],
    async run(a, g) {
      const id = arg.str(a, "file_id");
      const role = arg.str(a, "role");
      const email = arg.str(a, "email");
      await g.json("drive", "POST", `/files/${quoteAll(id)}/permissions`, {
        params: { sendNotificationEmail: arg.bool(a, "notify") ? "true" : "false" },
        json: { type: "user", role, emailAddress: email },
        what: "that file",
      });
      return { shared: id, with: email, role };
    },
  }),

  tool({
    name: "list_events",
    description: "Events in the primary calendar between start and end (title, when, attendees, link).",
    needs: ["calendar_read", "calendar_write"],
    properties: { start: WHEN, end: WHEN, query: s.str({ maxLength: 300, default: "" }), limit: s.limit(25) },
    required: ["start", "end"],
    async run(a, g) {
      const start = arg.str(a, "start");
      const end = arg.str(a, "end");
      const found = await g.json("calendar", "GET", "/calendars/primary/events", {
        params: {
          timeMin: start.includes("T") ? start : `${start}T00:00:00Z`,
          timeMax: end.includes("T") ? end : `${end}T23:59:59Z`,
          q: arg.str(a, "query") || undefined,
          maxResults: arg.int(a, "limit"),
          singleEvents: "true",
          orderBy: "startTime",
        },
      });
      return {
        events: ((found.items ?? []) as Json[]).map((e) => ({
          id: e.id,
          title: e.summary,
          start: e.start,
          end: e.end,
          location: e.location,
          attendees: ((e.attendees ?? []) as Json[]).map((x) => x.email),
          link: e.htmlLink,
        })),
      };
    },
  }),
  tool({
    name: "create_event",
    description: "Add an event to the primary calendar; attendees get Google's invitation email.",
    needs: ["calendar_write"],
    properties: {
      title: s.str({ minLength: 1, maxLength: 500 }),
      start: WHEN,
      end: WHEN,
      attendees: s.list(s.address(), { maxItems: 100 }),
      description: s.str({ maxLength: 8000, default: "" }),
      location: s.str({ maxLength: 500, default: "" }),
    },
    required: ["title", "start", "end"],
    async run(a, g) {
      const attendees = arg.strs(a, "attendees") ?? [];
      const event: Json = { summary: arg.str(a, "title"), start: when(arg.str(a, "start")), end: when(arg.str(a, "end")) };
      if (arg.str(a, "description")) event.description = arg.str(a, "description");
      if (arg.str(a, "location")) event.location = arg.str(a, "location");
      if (attendees.length) event.attendees = attendees.map((email) => ({ email }));
      const made = await g.json("calendar", "POST", "/calendars/primary/events", {
        params: { sendUpdates: attendees.length ? "all" : "none" },
        json: event,
      });
      return { created: made.id, link: made.htmlLink, invited: attendees };
    },
  }),

  tool({
    name: "read_sheet",
    description: "Read a range of a spreadsheet: its rows, as shown.",
    needs: ["sheets_read", "sheets_write"],
    properties: { spreadsheet_id: SHEET_ID, cells: RANGE },
    required: ["spreadsheet_id", "cells"],
    async run(a, g) {
      const got = await g.json("sheets", "GET", cellsPath(arg.str(a, "spreadsheet_id"), arg.str(a, "cells")), { what: "that spreadsheet or range" });
      return { range: got.range, rows: got.values ?? [] };
    },
  }),
  tool({
    name: "update_sheet",
    description: "Overwrite a range with these rows (formulas and numbers as if typed).",
    needs: ["sheets_write"],
    properties: { spreadsheet_id: SHEET_ID, cells: RANGE, rows: ROWS },
    required: ["spreadsheet_id", "cells", "rows"],
    async run(a, g) {
      const done = await g.json("sheets", "PUT", cellsPath(arg.str(a, "spreadsheet_id"), arg.str(a, "cells")), {
        params: { valueInputOption: "USER_ENTERED" },
        json: { values: a.rows },
        what: "that spreadsheet or range",
      });
      return { updated: done.updatedRange, cells: done.updatedCells };
    },
  }),
  tool({
    name: "append_rows",
    description: "Add rows after the table in this range (nothing that was there changes).",
    needs: ["sheets_write"],
    properties: { spreadsheet_id: SHEET_ID, cells: RANGE, rows: ROWS },
    required: ["spreadsheet_id", "cells", "rows"],
    async run(a, g) {
      const done = await g.json("sheets", "POST", `${cellsPath(arg.str(a, "spreadsheet_id"), arg.str(a, "cells"))}:append`, {
        params: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
        json: { values: a.rows },
        what: "that spreadsheet or range",
      });
      return { appended: done.updates?.updatedRange, rows: done.updates?.updatedRows };
    },
  }),

  tool({
    name: "read_doc",
    description:
      "Read a Google Doc: its title and its text, tables as tab-separated rows. A long one comes in parts: total_chars says how long, next_offset where the next part starts.",
    needs: ["docs_read", "docs_write"],
    properties: { document_id: DOC_ID, ...READ_PARTS },
    required: ["document_id"],
    async run(a, g) {
      const doc = await g.json("docs", "GET", `/documents/${quoteAll(arg.str(a, "document_id"))}`, { what: "that document" });
      return {
        document_id: doc.documentId,
        title: doc.title,
        revision_id: doc.revisionId,
        ...page(docText(doc.body?.content ?? []), arg.int(a, "offset"), arg.int(a, "limit")),
      };
    },
  }),
  tool({
    name: "create_doc",
    description: "Make a new Google Doc in the account's Drive, with this text in it. Only the account can see it until someone shares it.",
    needs: ["docs_write"],
    properties: { title: s.str({ minLength: 1, maxLength: 300 }), text: DOC_TEXT },
    required: ["title"],
    async run(a, g) {
      const made = await g.json("docs", "POST", "/documents", { json: { title: arg.str(a, "title") } });
      const id = String(made.documentId ?? "");
      const text = arg.opt(a, "text");
      if (text) {
        await g.json("docs", "POST", `/documents/${quoteAll(id)}:batchUpdate`, {
          json: { requests: [{ insertText: { text, endOfSegmentLocation: {} } }] },
        });
      }
      return { created: id, title: made.title, link: docLink(id) };
    },
  }),
  tool({
    name: "edit_doc",
    description: "Change a Google Doc: replace every match of a piece of text, and/or add text at the end. Nothing else in it changes.",
    needs: ["docs_write"],
    properties: {
      document_id: DOC_ID,
      replace: s.list(
        {
          type: "object",
          description: "Every match of `find` becomes `replace_with`.",
          properties: {
            find: s.str({ minLength: 1, maxLength: 1000 }),
            replace_with: s.str({ maxLength: 10_000 }),
            match_case: s.bool({ description: "True unless said." }),
          },
          required: ["find", "replace_with"],
        },
        { maxItems: 50 },
      ),
      append: DOC_TEXT,
    },
    required: ["document_id"],
    async run(a, g) {
      const id = arg.str(a, "document_id");
      const replace = (a.replace ?? []) as Json[];
      const append = arg.opt(a, "append");
      if (!replace.length && !append) throw new ToolError("Say what to change: replace, append, or both.");
      const requests: Json[] = replace.map((r) => ({
        replaceAllText: { containsText: { text: r.find, matchCase: r.match_case ?? true }, replaceText: r.replace_with },
      }));
      if (append) requests.push({ insertText: { text: append, endOfSegmentLocation: {} } });
      const done = await g.json("docs", "POST", `/documents/${quoteAll(id)}:batchUpdate`, { json: { requests }, what: "that document" });
      const replies = (done.replies ?? []) as Json[];
      const changed = replies.slice(0, replace.length).map((r) => Number(r.replaceAllText?.occurrencesChanged ?? 0));
      return { edited: id, replaced: changed, appended_chars: (append ?? "").length, link: docLink(id) };
    },
  }),
];
