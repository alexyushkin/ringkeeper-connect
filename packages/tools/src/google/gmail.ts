// Gmail: search, read (messages, threads, attachments), send, drafts, trash.
// Left out from Ringkeeper: view_attachment (answers with an image; these tools answer text)
// and save_attachment (saves into a Ringkeeper project's folder, which has no equivalent here).
import { ToolError } from "../types.js";
import { extract, PAGES_PATTERN, textAnswer } from "./extract.js";
import { Google, quoteAll, type Json } from "./http.js";
import { arg, s, tool, type Schema } from "./schema.js";
import { bestText, bodyFields, PAGE_CHARS, preview, THREAD_BODY_CHARS, threadPage } from "./text.js";

// --- Reading a message ---

function headers(payload: Json): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of (payload.headers ?? []) as Json[]) out[String(h.name ?? "").toLowerCase()] = String(h.value ?? "");
  return out;
}

const bytes = (data: string) => Buffer.from(data, "base64url");

/** The message's text: its text/plain part, or its HTML without the tags. */
export function messageText(payload: Json): string {
  const found: Record<string, string> = {};
  const walk = (part: Json) => {
    const mime = String(part.mimeType ?? "");
    const data = part.body?.data;
    if (data && (mime === "text/plain" || mime === "text/html") && !(mime in found)) found[mime] = bytes(String(data)).toString("utf8");
    for (const child of (part.parts ?? []) as Json[]) walk(child);
  };
  walk(payload);
  return bestText(found["text/plain"] ?? "", found["text/html"] ?? "");
}

function attached(payload: Json): Json[] {
  const found: Json[] = [];
  const walk = (part: Json) => {
    if (part.filename) found.push(part);
    for (const child of (part.parts ?? []) as Json[]) walk(child);
  };
  walk(payload);
  return found;
}

/** An attachment as a message lists it. Google's own attachment id changes with every read, so the id is the part's place in the message. */
function listed(part: Json): Json {
  return { id: String(part.partId ?? ""), name: String(part.filename), type: String(part.mimeType ?? ""), size: Number(part.body?.size ?? 0) };
}

function messageFields(message: Json, offset: number, limit: number, includeQuoted = false): Json {
  const payload: Json = message.payload ?? {};
  const h = headers(payload);
  return {
    id: message.id,
    thread_id: message.threadId,
    from: h.from ?? "",
    to: h.to ?? "",
    cc: h.cc ?? "",
    subject: h.subject ?? "",
    date: h.date ?? "",
    ...bodyFields(messageText(payload), offset, limit, includeQuoted),
    attachments: attached(payload).map(listed),
  };
}

async function getMessage(g: Google, id: string): Promise<Json> {
  return g.json("gmail", "GET", `/messages/${quoteAll(id)}`, { params: { format: "full" }, what: "that message" });
}

/** A few at a time, in order. */
async function inTurns<T, R>(items: T[], each: (item: T) => Promise<R>, atOnce = 5): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await each(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, worker));
  return out;
}

// --- Writing a message (RFC 2822, as the Gmail API's "raw") ---

/** A header's value, RFC 2047-encoded when it isn't plain ASCII. Line breaks never get in. */
export function headerValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let chunk = "";
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

export interface Draft {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  inReplyTo?: string;
}

/** The whole message: headers, then a UTF-8 text body (7bit when it can be, base64 otherwise). */
export function mimeMessage(d: Draft): string {
  const lines: string[] = [`To: ${d.to.join(", ")}`];
  if (d.cc?.length) lines.push(`Cc: ${d.cc.join(", ")}`);
  lines.push(`Subject: ${headerValue(d.subject)}`);
  if (d.inReplyTo) {
    const parent = d.inReplyTo.replace(/[\r\n]+/g, " ");
    lines.push(`In-Reply-To: ${parent}`, `References: ${parent}`);
  }
  let body = d.body.replace(/\r\n|\r|\n/g, "\r\n");
  if (!body.endsWith("\r\n")) body += "\r\n";
  const plain = /^[\x00-\x7f]*$/.test(body) && body.split("\r\n").every((l) => l.length <= 998);
  lines.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="utf-8"');
  if (plain) {
    lines.push("Content-Transfer-Encoding: 7bit", "", body);
  } else {
    const encoded = Buffer.from(body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
    lines.push("Content-Transfer-Encoding: base64", "", encoded.endsWith("\r\n") ? encoded : `${encoded}\r\n`);
  }
  return lines.join("\r\n");
}

/** The Gmail API's {"raw", "threadId"} for a new message, or a reply in its thread. */
async function compose(g: Google, a: Json): Promise<Json> {
  const draft: Draft = { to: arg.strs(a, "to")!, subject: arg.str(a, "subject"), body: arg.str(a, "body"), cc: arg.strs(a, "cc") };
  let thread: string | undefined;
  const replyTo = arg.opt(a, "reply_to");
  if (replyTo) {
    const original = await g.json("gmail", "GET", `/messages/${quoteAll(replyTo)}`, {
      params: { format: "metadata", metadataHeaders: ["Message-ID"] },
      what: "the message this answers",
    });
    thread = String(original.threadId ?? "") || undefined;
    const parent = headers(original.payload ?? {})["message-id"];
    if (parent) draft.inReplyTo = parent;
  }
  const raw = Buffer.from(mimeMessage(draft), "utf8").toString("base64url");
  return thread ? { raw, threadId: thread } : { raw };
}

/** Where the draft opens in Gmail on the web. */
function draftLink(address: string, messageId: string): string {
  const who = address ? `?authuser=${quoteAll(address)}` : "";
  return `https://mail.google.com/mail/${who}#drafts?compose=${messageId}`;
}

const MESSAGE_ID = s.id("The message id, from search_mail.");
const THREAD_ID = s.id("The thread_id, from search_mail or read_mail.");
const OFFSET: Schema = s.int({ minimum: 0, default: 0, description: "Where to start, in characters. Use next_offset from the last part." });
const PAGE_LIMIT: Schema = s.int({ minimum: 1, maximum: PAGE_CHARS, default: PAGE_CHARS, description: "The most characters to return in this part." });
export const PAGES: Schema = s.str({ pattern: PAGES_PATTERN, description: "Pages (or slides, sheets) to read, like 3 or 3-6: next_pages says which come next." });
export const INSIDE: Schema = s.str({ minLength: 1, maxLength: 500, description: "A file inside this one: its path in a .zip." });
export const READ_PARTS = { offset: OFFSET, limit: PAGE_LIMIT };
const MAIL_ARGS: Record<string, Schema> = {
  to: s.list(s.address(), { minItems: 1, maxItems: 50 }),
  subject: s.str({ maxLength: 500 }),
  body: s.str({ maxLength: 100_000 }),
  cc: s.list(s.address(), { maxItems: 50 }),
  reply_to: s.id("The id of the message this answers (keeps the thread)."),
};

export const gmailTools = [
  tool({
    name: "search_mail",
    description:
      "Find messages with Gmail's search words, newest first: id, from, to, subject, date, whether it's unread, and a preview (the start of its own text, without what it quotes). The previews are enough to list or summarize what was found: read_mail only a message you need whole.",
    needs: ["mail_read"],
    properties: {
      query: s.str({ description: "Gmail search, e.g. from:anna@acme.example newer_than:7d.", maxLength: 500, default: "" }),
      limit: s.limit(20),
    },
    async run(a, g) {
      const limit = arg.int(a, "limit");
      const [found, profile] = await Promise.all([
        g.json("gmail", "GET", "/messages", { params: { q: arg.str(a, "query") || undefined, maxResults: limit } }),
        g.json("gmail", "GET", "/profile").catch(() => ({}) as Json),
      ]);
      const items = ((found.messages ?? []) as Json[]).slice(0, limit);
      // Each message's text is fetched to make its preview; only the preview goes back.
      const messages = await inTurns(items, async (item) => {
        const message = await getMessage(g, String(item.id));
        const payload: Json = message.payload ?? {};
        const h = headers(payload);
        return {
          id: item.id,
          thread_id: message.threadId,
          from: h.from ?? "",
          to: h.to ?? "",
          subject: h.subject ?? "",
          date: h.date ?? "",
          unread: ((message.labelIds ?? []) as string[]).includes("UNREAD"),
          preview: preview(messageText(payload)) || String(message.snippet ?? ""),
        };
      });
      return { account: profile.emailAddress ?? null, messages };
    },
  }),
  tool({
    name: "read_mail",
    description:
      "Read one message: headers, its whole text and its attachments. Doesn't mark it read. A long message comes in parts: total_chars says how long, next_offset where the next part starts. Earlier messages a reply quotes are in `quoted` (include_quoted puts them in the body). read_attachment reads an attachment; get_thread reads the whole conversation.",
    needs: ["mail_read"],
    properties: {
      message_id: MESSAGE_ID,
      ...READ_PARTS,
      include_quoted: s.bool({ default: false, description: "Keep the earlier messages a reply quotes in the body." }),
    },
    required: ["message_id"],
    async run(a, g) {
      const id = arg.str(a, "message_id");
      const message = await getMessage(g, id);
      return { ...messageFields(message, arg.int(a, "offset"), arg.int(a, "limit"), arg.bool(a, "include_quoted")), id };
    },
  }),
  tool({
    name: "read_attachment",
    description:
      "Read one attachment's text: Word, Excel, PowerPoint, CSV, text, HTML and a .zip (`inside` reads a file in it). A long file starts with its outline: read on with pages=. PDFs, pictures and attached emails can't be read here.",
    needs: ["mail_read"],
    properties: {
      message_id: MESSAGE_ID,
      attachment_id: s.str({ minLength: 1, maxLength: 2000, description: "The attachment's id, from the message." }),
      pages: PAGES,
      inside: INSIDE,
      ...READ_PARTS,
    },
    required: ["message_id", "attachment_id"],
    async run(a, g) {
      const id = arg.str(a, "message_id");
      const wanted = arg.str(a, "attachment_id");
      const message = await getMessage(g, id);
      const part = attached(message.payload ?? {}).find((p) => String(p.partId) === wanted);
      if (!part) throw new ToolError(`This message has no attachment ${wanted}. read_mail lists its attachments.`);
      let data = String(part.body?.data ?? "");
      if (!data) {
        const fetched = await g.json("gmail", "GET", `/messages/${quoteAll(id)}/attachments/${quoteAll(String(part.body?.attachmentId ?? ""))}`, { what: "that attachment" });
        data = String(fetched.data ?? "");
      }
      const content = bytes(data);
      const { id: _id, ...meta } = listed(part);
      const found = extract(String(meta.name), String(meta.type), content, arg.opt(a, "inside"));
      return textAnswer({ ...meta, size: content.length }, found, arg.int(a, "offset"), arg.int(a, "limit"), arg.opt(a, "pages"));
    },
  }),
  tool({
    name: "get_thread",
    description: "Read a conversation, oldest message first. Each message shows the start of its text, with total_chars: read_mail reads the rest of a long one.",
    needs: ["mail_read"],
    properties: {
      thread_id: THREAD_ID,
      offset: s.int({ minimum: 0, default: 0, description: "The message to start from. Use next_offset from the last part." }),
      limit: s.int({ minimum: 1, maximum: 100, default: 20, description: "The most messages to return." }),
      body_chars: s.int({ minimum: 1, maximum: PAGE_CHARS, default: THREAD_BODY_CHARS, description: "The most characters of each message's text." }),
    },
    required: ["thread_id"],
    async run(a, g) {
      const thread = await g.json("gmail", "GET", `/threads/${quoteAll(arg.str(a, "thread_id"))}`, { params: { format: "full" }, what: "that conversation" });
      const messages = [...((thread.messages ?? []) as Json[])].sort((x, y) => Number(x.internalDate ?? 0) - Number(y.internalDate ?? 0));
      const shown = messages.map((m) => messageFields(m, 0, arg.int(a, "body_chars")));
      return threadPage(shown, arg.int(a, "offset"), arg.int(a, "limit"));
    },
  }),
  tool({
    name: "send_mail",
    description: "Send an email from this Google account. reply_to answers a message in its thread.",
    // As in Ringkeeper: "Write drafts" (gmail.compose) can send too. A refusal names "Send mail".
    needs: ["mail_send", "mail_drafts"],
    properties: MAIL_ARGS,
    required: ["to", "subject", "body"],
    async run(a, g) {
      // Answering a message reads its Message-ID first, which gmail.send alone can't.
      const message = await compose(g.as(["mail_read", "mail_drafts"]), a);
      const sent = await g.as(["mail_send"]).json("gmail", "POST", "/messages/send", { json: message });
      return { sent: true, to: arg.strs(a, "to"), id: sent.id };
    },
  }),
  tool({
    name: "create_draft",
    description: "Save an email as a Gmail draft for the user to check and send. Nothing is sent. Put the draft's link in your final message.",
    needs: ["mail_drafts"],
    properties: MAIL_ARGS,
    required: ["to", "subject", "body"],
    async run(a, g) {
      const message = await compose(g, a);
      const saved = await g.json("gmail", "POST", "/drafts", { json: { message } });
      const made = saved.message?.id;
      let link: string | null = null;
      if (made) {
        const profile = await g.json("gmail", "GET", "/profile").catch(() => ({}) as Json);
        link = draftLink(String(profile.emailAddress ?? ""), String(made));
      }
      return { saved: "draft", id: saved.id, to: arg.strs(a, "to"), subject: arg.str(a, "subject"), link };
    },
  }),
  tool({
    name: "trash_mail",
    description: "Move a message to the trash (Gmail empties it after 30 days).",
    needs: ["mail_trash"],
    properties: { message_id: MESSAGE_ID },
    required: ["message_id"],
    async run(a, g) {
      const id = arg.str(a, "message_id");
      await g.json("gmail", "POST", `/messages/${quoteAll(id)}/trash`, { what: "that message" });
      return { trashed: id };
    },
  }),
];
