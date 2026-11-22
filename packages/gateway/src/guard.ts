// How much the AI may do for a client, and what kind of action a tool is.
//
// AI apps have their own permission modes (ask every time, auto, and so on),
// so Ringkeeper Connect doesn't ask about ordinary changes. It adds two things
// those modes can't know about, because they aren't per client:
//   - "ask_delete": ask the person before something is deleted for this client;
//   - "look_only":  this client's tools may only read.
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Per client. "free" leaves everything to the AI app's own permission mode. */
export type ClientGuard = "free" | "ask_delete" | "look_only";

export const CLIENT_GUARDS: readonly ClientGuard[] = ["free", "ask_delete", "look_only"];

/** Deleting is the one thing that can't be put right afterwards, so asking about it is the default. */
export const DEFAULT_GUARD: ClientGuard = "ask_delete";

export function isClientGuard(v: unknown): v is ClientGuard {
  return typeof v === "string" && (CLIENT_GUARDS as readonly string[]).includes(v);
}

export type ActionKind = "read" | "change" | "delete";

/** Words in a tool's name that mean something is removed for good (or as good as). */
const DELETE_WORDS = new Set(["delete", "deletes", "deleted", "remove", "removes", "destroy", "drop", "purge", "erase", "wipe", "trash", "truncate", "revoke", "terminate", "uninstall", "cancel", "reset"]);

/** Words that mean a tool only looks. */
const READ_WORDS = new Set(["get", "list", "search", "read", "reader", "fetch", "find", "describe", "show", "view", "count", "retrieve", "lookup", "query", "check", "explain", "inspect", "compare", "export", "download", "analytics", "report", "validate", "verify", "analyze", "summarize", "preview", "estimate"]);

/** Words that mean a tool changes something, even when a looking word is there too ("get_or_create"). */
const CHANGE_WORDS = new Set([
  "create", "add", "adds", "update", "updater", "set", "write", "edit", "send", "post", "put", "patch", "insert", "upsert", "append", "move", "copy", "rename",
  "publish", "unpublish", "deploy", "run", "execute", "exec", "start", "stop", "pause", "resume", "restart", "import", "upload", "merge", "apply", "make", "call",
  "invite", "assign", "unassign", "approve", "reject", "submit", "save", "store", "share", "archive", "restore", "enable", "disable", "install", "rotate", "provision",
  "register", "link", "unlink", "label", "unlabel", "mark", "unmark", "reply", "forward", "duplicate", "clone", "fork", "transfer", "refund", "pay", "charge", "book",
  "schedule", "trigger", "test", "simulate", "generate", "compose", "convert", "clear", "complete", "close", "open", "respond", "react", "boost", "end", "manage", "mutate", "use", "switch",
]);

/** "TwilioApiV2010--DeleteCall", "notion-delete-pages" and "delete_records" all give [..., "delete", ...]. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * What a tool does, from what its own server says about it and from its name.
 * When it isn't clearly reading, it counts as a change: a wrong "read" would
 * let a "look only" client be changed, and a wrong "change" only refuses a look.
 */
export function actionKind(tool: Pick<Tool, "name" | "annotations">): ActionKind {
  const says = tool.annotations?.readOnlyHint;
  if (says === true) return "read";
  const words = nameWords(tool.name);
  if (words.some((w) => DELETE_WORDS.has(w))) return "delete";
  if (says === false) return "change";
  // "netlify-deploy-services-reader": a tool named after what it is, ending in "reader".
  const last = words[words.length - 1] ?? "";
  if (last === "reader" || last === "viewer") return "read";
  // A clear changing word anywhere means a change ("get_or_create_drive").
  if (words.some((w) => CHANGE_WORDS.has(w) && !NOUN_TOO.has(w))) return "change";
  // Otherwise the first action word decides: "FetchCall" looks, "test_workflow" changes.
  const first = words.find((w) => READ_WORDS.has(w) || CHANGE_WORDS.has(w));
  return first && READ_WORDS.has(first) ? "read" : "change";
}

/** Changing words that are also things ("FetchCall", "list_deploy_logs"): they count only when they come first. */
const NOUN_TOO = new Set(["call", "test", "label", "link", "book", "mark", "charge", "end", "open", "close", "deploy", "store", "share", "use", "switch", "boost", "post"]);

/**
 * Which of a tool's actions the AI apps get. Left out: all of them. "read": only the ones that
 * only read. A list: only those, by the action's own name. Some tools bring hundreds of actions;
 * fewer make the AI quicker and better at picking.
 */
export type ActionChoice = "read" | string[];

export function isActionChoice(v: unknown): v is ActionChoice {
  return v === "read" || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 200));
}

/** Whether the AI apps get this action of a tool. */
export function offersAction(choice: ActionChoice | undefined, tool: Pick<Tool, "name" | "annotations">): boolean {
  if (choice === undefined) return true;
  if (choice === "read") return actionKind(tool) === "read";
  return choice.includes(tool.name);
}

/** One thing an AI app did, or tried to do, for a client. Never holds what was sent or returned. */
export interface Activity {
  /** When, as milliseconds since 1970. */
  at: number;
  clientId: string;
  connectionId: string;
  connectionName: string;
  /** The tool's own name, without the connection's prefix. */
  tool: string;
  kind: ActionKind;
  /** The AI app that asked, by the name people know. */
  app: string;
  /**
   * ran: it was carried out. failed: the service reported an error.
   * not_allowed: the person didn't allow a deletion. look_only: refused because the client only allows looking.
   * wrong_client: the AI named a different client than the active one, so nothing ran.
   */
  outcome: "ran" | "failed" | "not_allowed" | "look_only" | "wrong_client";
}
