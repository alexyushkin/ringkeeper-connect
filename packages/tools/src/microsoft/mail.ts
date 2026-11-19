// Outlook mail through Microsoft Graph, as in Ringkeeper's adapters/vendors/microsoft.py.
// mail_read reads; mail_drafts writes drafts, marks and moves; mail_send sends;
// mail_delete deletes (moving to Deleted Items counts as deleting).
import { ToolError } from "../types.js";
import { arg, s, type Schema } from "../google/schema.js";
import { INSIDE, PAGES, READ_PARTS } from "../google/gmail.js";
import { extract, textAnswer } from "../google/extract.js";
import { bodyFields, htmlToText, PAGE_CHARS, threadPage, THREAD_BODY_CHARS } from "../google/text.js";
import type { MicrosoftAccessKey } from "./access.js";
import { MOST_PEOPLE, ODATA, op, PEOPLE, peopleIn, TEXT_BODY, tidy, type Json } from "./graph.js";

const READS: MicrosoftAccessKey[] = ["mail_read", "mail_drafts", "mail_delete"];
const RECIPIENTS = ["toRecipients", "ccRecipients", "bccRecipients"] as const;
/** Well-known folders a move can name. Moving to one of these is deleting. */
const BIN = new Set(["deleteditems", "recoverableitemsdeletions"]);
const ATTACHMENT_FIELDS = "id,name,contentType,size";
const THREAD_FIELDS = "id,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,body";
const LIST_FIELDS = "id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview,webLink";
const MOST_IN_THREAD = 200;
const MESSAGE_ID = { message_id: "The message's id, from list_messages." };

const MESSAGE: Schema = {
  type: "object",
  description:
    'A Graph message: {"subject", "body": {"contentType": "Text" or "HTML", "content"}, "toRecipients": [{"emailAddress": {"address"}}], "ccRecipients", "bccRecipients", "replyTo", "importance"}.',
  properties: {
    subject: s.str({ maxLength: 500 }),
    body: TEXT_BODY,
    toRecipients: PEOPLE,
    ccRecipients: PEOPLE,
    bccRecipients: PEOPLE,
    replyTo: PEOPLE,
    importance: s.oneOf(["low", "normal", "high"]),
  },
};
const DRAFT: Record<string, Schema> = {
  subject: s.str({ maxLength: 500 }),
  body: TEXT_BODY,
  toRecipients: PEOPLE,
  ccRecipients: PEOPLE,
  bccRecipients: PEOPLE,
  replyTo: PEOPLE,
  importance: s.oneOf(["low", "normal", "high"]),
  categories: s.list(s.str({ maxLength: 255 }), { maxItems: 25 }),
};
const ATTACHMENT: Schema = {
  type: "object",
  description: '{"@odata.type": "#microsoft.graph.fileAttachment", "name": "notes.txt", "contentType": "text/plain", "contentBytes": "<base64>"}',
  properties: { name: s.str({ minLength: 1, maxLength: 255 }), contentType: s.str({ maxLength: 255 }), contentBytes: s.str({ maxLength: 4_000_000 }) },
  required: ["name", "contentBytes"],
};
const COMMENT: Schema = s.str({ maxLength: 100_000, description: "Text put above the quoted message." });

/** More than MOST_PEOPLE in one email is a mailing: Ringkeeper Connect doesn't send those. */
function notMany(body: Json): void {
  const total = peopleIn(body, RECIPIENTS);
  if (total > MOST_PEOPLE) throw new ToolError(`That would send to ${total} people at once. Ringkeeper Connect sends to at most ${MOST_PEOPLE} in one email.`);
}

function attachmentRow(found: Json): Json {
  return { id: found.id, name: found.name, type: found.contentType, size: found.size };
}

function textOf(message: Json): string {
  const body: Json = message.body ?? {};
  const content = String(body.content ?? "");
  return String(body.contentType ?? "").toLowerCase() === "html" ? htmlToText(content) : content;
}

/** A message as an agent reads it: text rather than HTML, and what part of it this is. */
function shown(message: Json, offset: number, limit: number, includeQuoted = false): Json {
  if (!message.body || typeof message.body !== "object") return tidy(message) as Json; // a $select that left it out
  const kept: Json = {};
  for (const [k, v] of Object.entries(tidy(message) as Json)) if (!["body", "bodyPreview", "attachments"].includes(k)) kept[k] = v;
  const attachments = Array.isArray(message.attachments) ? (message.attachments as Json[]) : [];
  return { ...kept, ...bodyFields(textOf(message), offset, limit, includeQuoted), attachments: attachments.map(attachmentRow) };
}

/** $search wants its words in quotes. */
function quoted(words: string): string {
  const w = words.trim();
  return w.startsWith('"') ? w : `"${w.replace(/"/g, "")}"`;
}

export const mailTools = [
  op({
    name: "list_messages",
    description:
      "Find messages, newest first: id, conversationId, subject, from, to, date, whether it's read, attachments, a preview and its Outlook link. search= finds words (from:anna, subject:invoice), or filter= picks by field (Graph's $filter); they can't be combined. get_message reads one whole.",
    needs: READS,
    method: "GET",
    path: "/me/messages",
    query: { search: s.str({ maxLength: 500, description: "Words to find, as in Outlook's search box." }), ...ODATA },
    pages: true,
    prepare(params, a) {
      const out: Json = { $select: LIST_FIELDS, $top: 20, ...params };
      if (typeof a.search === "string") out.$search = quoted(a.search);
      else out.$orderby ??= "receivedDateTime desc";
      return out;
    },
  }),
  op({
    name: "get_message",
    description:
      "Read one message: its whole text, in parts if it's long (total_chars, next_offset), and its attachments. Earlier messages a reply quotes are in `quoted` (include_quoted puts them in the body). Doesn't mark it read.",
    needs: READS,
    method: "GET",
    path: "/me/messages/{message_id}",
    ids: MESSAGE_ID,
    what: "that message",
    query: { select: ODATA.select },
    local: { ...READ_PARTS, include_quoted: s.bool({ default: false, description: "Keep the earlier messages a reply quotes in the body." }) },
    prepare: (params) => ({ $expand: `attachments($select=${ATTACHMENT_FIELDS})`, ...params }),
    after: (answer, a) => shown(answer, arg.int(a, "offset"), arg.int(a, "limit"), arg.bool(a, "include_quoted")),
  }),
  op({
    name: "get_thread",
    description:
      "A conversation, oldest message first: conversation_id from a message. Each message shows the start of its text, with total_chars; get_message reads the rest.",
    needs: READS,
    method: "GET",
    path: "/me/messages",
    required: ["conversation_id"],
    local: {
      conversation_id: s.str({ minLength: 1, maxLength: 1000, description: "The message's conversationId." }),
      offset: s.int({ minimum: 0, default: 0, description: "The message to start from. Use next_offset from the last part." }),
      limit: s.int({ minimum: 1, maximum: 100, default: 20, description: "The most messages to return." }),
      body_chars: s.int({ minimum: 1, maximum: PAGE_CHARS, default: THREAD_BODY_CHARS, description: "The most characters of each message's text." }),
    },
    // Not sorted by Graph: it refuses to sort by one field and filter by another.
    prepare: (_params, a) => ({
      $filter: `conversationId eq '${arg.str(a, "conversation_id").replace(/'/g, "''")}'`,
      $select: THREAD_FIELDS,
      $expand: `attachments($select=${ATTACHMENT_FIELDS})`,
      $top: MOST_IN_THREAD,
    }),
    after(answer, a) {
      const found = ((answer.value ?? []) as Json[]).slice().sort((x, y) => String(x.receivedDateTime ?? "").localeCompare(String(y.receivedDateTime ?? "")));
      const part = threadPage(found.map((m) => shown(m, 0, arg.int(a, "body_chars"))), arg.int(a, "offset"), arg.int(a, "limit"));
      if (!answer["@odata.nextLink"]) return part;
      return { ...part, truncated: true, read_note: `This conversation has more than ${MOST_IN_THREAD} messages: only ${MOST_IN_THREAD} were read.` };
    },
  }),
  op({
    name: "list_mail_folders",
    description: "Mail folders, with their ids and how many messages each holds.",
    needs: READS,
    method: "GET",
    path: "/me/mailFolders",
    query: ODATA,
    pages: true,
  }),
  op({
    name: "list_attachments",
    description: "A message's attachments: id, name, type and size.",
    needs: READS,
    method: "GET",
    path: "/me/messages/{message_id}/attachments",
    ids: MESSAGE_ID,
    what: "that message",
    // Graph sends every attachment's whole content unless told not to.
    prepare: () => ({ $select: ATTACHMENT_FIELDS }),
    after: (answer) => ({ attachments: ((answer.value ?? []) as Json[]).map(attachmentRow) }),
  }),
  op({
    name: "read_attachment",
    description:
      "The text of one attachment: Word, Excel, PowerPoint, CSV, text, HTML and a .zip (`inside` reads a file in it). A long one starts with its outline: read on with pages=. PDFs, pictures and attached emails can't be read here.",
    needs: READS,
    method: "GET",
    path: "/me/messages/{message_id}/attachments/{attachment_id}",
    ids: { ...MESSAGE_ID, attachment_id: "The attachment's id, from get_message or list_attachments." },
    what: "that attachment",
    local: { pages: PAGES, inside: INSIDE, ...READ_PARTS },
    after(answer, a) {
      const name = String(answer.name ?? "attachment");
      if (!answer.contentBytes) throw new ToolError(`'${name}' is an attached item or a link, not a file, so it can't be read here.`);
      const data = Buffer.from(String(answer.contentBytes), "base64");
      const meta = { name, type: String(answer.contentType ?? ""), size: data.length };
      return textAnswer(meta, extract(name, meta.type, data, arg.opt(a, "inside")), arg.int(a, "offset"), arg.int(a, "limit"), arg.opt(a, "pages"));
    },
  }),
  op({
    name: "send_mail",
    description: `Send an email now. At most ${MOST_PEOPLE} people in all. create_draft saves one to look at first.`,
    needs: ["mail_send"],
    method: "POST",
    path: "/me/sendMail",
    body: { message: MESSAGE, saveToSentItems: s.bool({ default: true, description: "Keep a copy in Sent Items." }) },
    required: ["message"],
    check: notMany,
  }),
  op({
    name: "reply",
    description: "Reply to the sender now, keeping the conversation. comment is the reply's text; message can add recipients or set the body instead.",
    needs: ["mail_send"],
    method: "POST",
    path: "/me/messages/{message_id}/reply",
    ids: MESSAGE_ID,
    what: "that message",
    body: { comment: COMMENT, message: MESSAGE },
    check: notMany,
  }),
  op({
    name: "reply_all",
    description: "Reply to everyone on a message now. comment is the reply's text.",
    needs: ["mail_send"],
    method: "POST",
    path: "/me/messages/{message_id}/replyAll",
    ids: MESSAGE_ID,
    what: "that message",
    body: { comment: COMMENT, message: MESSAGE },
    check: notMany,
  }),
  op({
    name: "forward",
    description: `Forward a message now, to at most ${MOST_PEOPLE} people. comment goes above it.`,
    needs: ["mail_send"],
    method: "POST",
    path: "/me/messages/{message_id}/forward",
    ids: MESSAGE_ID,
    what: "that message",
    body: { comment: COMMENT, toRecipients: PEOPLE, message: MESSAGE },
    check: notMany,
  }),
  op({
    name: "send_draft",
    description: "Send a saved draft now.",
    needs: ["mail_send"],
    method: "POST",
    path: "/me/messages/{message_id}/send",
    ids: { message_id: "The draft's id, from create_draft." },
    what: "that draft",
  }),
  op({
    name: "create_draft",
    description: "Save an email as a draft in Drafts; it reaches nobody until it's sent. Answers its id and its Outlook link: put the link in your final message.",
    needs: ["mail_drafts"],
    method: "POST",
    path: "/me/messages",
    body: { ...DRAFT, attachments: s.list(ATTACHMENT, { maxItems: 10 }) },
    check(body: Json) {
      notMany(body);
      for (const file of (body.attachments ?? []) as Json[]) file["@odata.type"] ??= "#microsoft.graph.fileAttachment";
    },
    after: (answer) => ({ saved: "draft", id: answer.id, subject: answer.subject, link: answer.webLink }),
  }),
  op({
    name: "update_draft",
    description: "Change a draft: only the fields given change.",
    needs: ["mail_drafts"],
    method: "PATCH",
    path: "/me/messages/{message_id}",
    ids: { message_id: "The draft's id, from create_draft or list_messages." },
    what: "that draft",
    body: DRAFT,
    check: notMany,
    after: (answer) => ({ saved: "draft", id: answer.id, subject: answer.subject, link: answer.webLink }),
  }),
  op({
    name: "mark_message",
    description: "Mark a message read or unread, flagged, important, or in a category.",
    needs: ["mail_drafts"],
    method: "PATCH",
    path: "/me/messages/{message_id}",
    ids: MESSAGE_ID,
    what: "that message",
    body: {
      isRead: s.bool(),
      flag: { type: "object", description: '{"flagStatus": "notFlagged", "flagged" or "complete"}', properties: { flagStatus: s.oneOf(["notFlagged", "flagged", "complete"]) } },
      categories: s.list(s.str({ maxLength: 255 }), { maxItems: 25 }),
      importance: s.oneOf(["low", "normal", "high"]),
    },
    after: (answer) => ({ id: answer.id, isRead: answer.isRead, flag: answer.flag, categories: answer.categories, importance: answer.importance }),
  }),
  op({
    name: "move_message",
    description: "Move a message to a folder: a folder's id from list_mail_folders, or inbox, archive, junkemail, drafts. delete_message deletes one.",
    needs: ["mail_drafts"],
    method: "POST",
    path: "/me/messages/{message_id}/move",
    ids: MESSAGE_ID,
    what: "that message or folder",
    body: { destinationId: s.str({ minLength: 1, maxLength: 1000, description: "The folder's id, or a well-known name such as inbox or archive." }) },
    required: ["destinationId"],
    check(body: Json) {
      if (BIN.has(String(body.destinationId).toLowerCase())) throw new ToolError("Moving to Deleted Items is deleting: use delete_message, which needs \"Delete mail\" ticked.");
    },
    after: (answer) => ({ moved: true, id: answer.id, folder: answer.parentFolderId }),
  }),
  op({
    name: "delete_message",
    description: "Delete a message: it goes to Deleted Items.",
    needs: ["mail_delete"],
    method: "DELETE",
    path: "/me/messages/{message_id}",
    ids: MESSAGE_ID,
    what: "that message",
  }),
];
