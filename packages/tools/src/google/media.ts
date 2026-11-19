// Search Console, Analytics (read-only) and YouTube.
import { open, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { ToolError } from "../types.js";
import { Google, quoteAll, type Json } from "./http.js";
import { arg, ID_PATTERN, s, tool, type Schema } from "./schema.js";

const DAY: Schema = s.str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD." });
const ANALYTICS_DAY: Schema = s.str({ pattern: "^(\\d{4}-\\d{2}-\\d{2}|today|yesterday|\\d{1,4}daysAgo)$", description: "YYYY-MM-DD, today, yesterday or NdaysAgo." });
const NAMES: Schema = s.list(s.str({ maxLength: 100 }), { maxItems: 10 });
const REPORT_ROWS: Schema = s.int({ minimum: 1, maximum: 1000, default: 100 });

// --- YouTube ---

const PRIVACY = ["private", "unlisted", "public"];
const VIDEO_ID: Schema = s.str({ description: "The video's ID.", pattern: "^[A-Za-z0-9_\\-]{6,20}$" });
const COMMENT_ID: Schema = s.str({ description: "The comment's ID.", pattern: ID_PATTERN });
const PUBLISH_AT: Schema = s.str({ maxLength: 40, description: "When a private video goes public by itself, like 2026-11-20T15:00:00-05:00. Only with privacy private." });
const TITLE: Schema = s.str({ minLength: 1, maxLength: 100 });
const DESCRIPTION: Schema = s.str({ maxLength: 5000 });
const TAGS: Schema = s.list(s.str({ maxLength: 100 }), { maxItems: 50 });
const PAGE_TOKEN: Schema = s.str({ maxLength: 200 });

// A part of a video at a time. YouTube wants a multiple of 256 KB.
const UPLOAD_CHUNK = 32 * 256 * 1024;
const UPLOAD_TIMEOUT_MS = 300_000;
const UPLOAD_MORE = 308; // YouTube's answer to every part but the last
const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mpeg": "video/mpeg", ".mpg": "video/mpeg", ".3gp": "video/3gpp",
};

/** YouTube publishes a time in the past at once, so one never reaches it. */
export function checkSchedule(privacy: string, publishAt: string | undefined, now = Date.now()): void {
  if (publishAt === undefined) return;
  if (privacy !== "private") throw new ToolError("A scheduled video stays private until its time: set privacy to private.");
  const m = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(publishAt);
  const when = m ? Date.parse(publishAt.replace(" ", "T")) : NaN;
  if (!m || Number.isNaN(when)) throw new ToolError("publish_at isn't a date and time like 2026-11-20T15:00:00-05:00.");
  if (!m[1]) throw new ToolError("publish_at needs its time zone, like -05:00.");
  if (when <= now) throw new ToolError("That time has passed, and YouTube would publish at once: pick a new one.");
}

async function channel(g: Google): Promise<Json> {
  const found = await g.json("youtube", "GET", "/channels", { params: { part: "snippet,statistics,contentDetails", mine: "true" } });
  const item = ((found.items ?? []) as Json[])[0];
  if (!item) throw new ToolError("This Google account has no YouTube channel.");
  return item;
}

async function video(g: Google, id: string, part: string): Promise<Json> {
  const found = await g.json("youtube", "GET", "/videos", { params: { part, id } });
  const item = ((found.items ?? []) as Json[])[0];
  if (!item) throw new ToolError(`There's no video ${id} on this channel.`);
  return item;
}

/** A video file on this computer (Ringkeeper takes one from a project's folder; there are no projects here). */
async function videoFile(file: string): Promise<{ path: string; size: number; type: string }> {
  if (!isAbsolute(file)) throw new ToolError("Give the video's full path on this computer, like C:\\Users\\Anna\\Videos\\launch.mp4.");
  const type = VIDEO_TYPES[extname(file).toLowerCase()];
  if (!type) throw new ToolError(`YouTube won't take a ${extname(file) || "file like this"}.`);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new ToolError(`There's no video at ${file}.`);
  return { path: file, size: info.size, type };
}

/** The video, a part at a time, so a large one is never all in memory. */
async function sendParts(g: Google, address: string, path: string, size: number): Promise<Json> {
  let answer: Json = {};
  const handle = await open(path, "r");
  try {
    let start = 0;
    while (start < size) {
      const buffer = Buffer.alloc(Math.min(UPLOAD_CHUNK, size - start));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      if (!bytesRead) break;
      const end = start + bytesRead - 1;
      const response = await g.raw("upload", "PUT", "", {
        url: address,
        body: buffer.subarray(0, bytesRead),
        headers: { "Content-Range": `bytes ${start}-${end}/${size}` },
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      if (response.status !== UPLOAD_MORE) {
        const text = await response.text();
        answer = text ? (JSON.parse(text) as Json) : {};
      }
      start = end + 1;
    }
  } finally {
    await handle.close();
  }
  return answer;
}

export const mediaTools = [
  tool({
    name: "list_search_sites",
    description: "The sites this account can see in Search Console, and its access to each.",
    needs: ["search_console_read"],
    async run(_a, g) {
      const found = await g.json("webmasters", "GET", "/sites");
      return { sites: ((found.siteEntry ?? []) as Json[]).map((x) => ({ site: x.siteUrl, access: x.permissionLevel })) };
    },
  }),
  tool({
    name: "search_performance",
    description: "Clicks, impressions, CTR and position from Search Console. `dimensions`: query, page, country, device, date.",
    needs: ["search_console_read"],
    properties: {
      site: s.str({ maxLength: 300, description: "From list_search_sites." }),
      start: DAY,
      end: DAY,
      dimensions: NAMES,
      limit: REPORT_ROWS,
    },
    required: ["site", "start", "end"],
    async run(a, g) {
      const body = { startDate: a.start, endDate: a.end, dimensions: arg.strs(a, "dimensions") ?? ["query"], rowLimit: a.limit };
      const found = await g.json("webmasters", "POST", `/sites/${quoteAll(arg.str(a, "site"))}/searchAnalytics/query`, { json: body, what: "that site" });
      return { rows: found.rows ?? [] };
    },
  }),
  tool({
    name: "list_analytics_properties",
    description: "The Google Analytics accounts and properties this account can read.",
    needs: ["analytics_read"],
    async run(_a, g) {
      const found = await g.json("analyticsadmin", "GET", "/accountSummaries");
      return {
        accounts: ((found.accountSummaries ?? []) as Json[]).map((x) => ({
          account: x.displayName,
          properties: ((x.propertySummaries ?? []) as Json[]).map((p) => ({ property: p.property, name: p.displayName })),
        })),
      };
    },
  }),
  tool({
    name: "analytics_report",
    description: 'A Google Analytics report, like metrics ["sessions", "totalUsers"] by dimensions ["date"]. Names are GA4\'s own.',
    needs: ["analytics_read"],
    properties: {
      property_id: s.str({ pattern: "^(properties/)?\\d+$", description: "From list_analytics_properties." }),
      start: ANALYTICS_DAY,
      end: ANALYTICS_DAY,
      metrics: { ...NAMES, minItems: 1 },
      dimensions: NAMES,
      limit: REPORT_ROWS,
    },
    required: ["property_id", "start", "end", "metrics"],
    async run(a, g) {
      const number = arg.str(a, "property_id").split("/").pop()!;
      const body = {
        dateRanges: [{ startDate: a.start, endDate: a.end }],
        metrics: arg.strs(a, "metrics")!.map((name) => ({ name })),
        dimensions: (arg.strs(a, "dimensions") ?? []).map((name) => ({ name })),
        limit: a.limit,
      };
      const found = await g.json("analyticsdata", "POST", `/properties/${number}:runReport`, { json: body, what: "that property" });
      const columns = [...((found.dimensionHeaders ?? []) as Json[]), ...((found.metricHeaders ?? []) as Json[])].map((h) => String(h.name));
      const rows = ((found.rows ?? []) as Json[]).map((r) => {
        const values = [...((r.dimensionValues ?? []) as Json[]), ...((r.metricValues ?? []) as Json[])].map((v) => v.value);
        return Object.fromEntries(columns.slice(0, values.length).map((c, i) => [c, values[i]]));
      });
      return { rows, row_count: found.rowCount ?? rows.length };
    },
  }),

  tool({
    name: "youtube_channel",
    description: "This account's YouTube channel: its name, its numbers and its uploads list.",
    needs: ["youtube_read", "youtube_manage"],
    run: (_a, g) => channel(g),
  }),
  tool({
    name: "youtube_videos",
    description: "The channel's videos, newest first, with their privacy and numbers.",
    needs: ["youtube_read", "youtube_manage"],
    properties: { limit: s.limit(25), page_token: PAGE_TOKEN },
    async run(a, g) {
      const uploads = (await channel(g)).contentDetails?.relatedPlaylists?.uploads;
      const listed = await g.json("youtube", "GET", "/playlistItems", {
        params: { part: "contentDetails", playlistId: uploads, maxResults: a.limit, pageToken: arg.opt(a, "page_token") },
      });
      const ids = ((listed.items ?? []) as Json[]).map((i) => String(i.contentDetails?.videoId));
      if (!ids.length) return { videos: [] };
      const found = await g.json("youtube", "GET", "/videos", { params: { part: "snippet,status,statistics", id: ids.join(",") } });
      return { videos: found.items ?? [], next_page: listed.nextPageToken ?? null };
    },
  }),
  tool({
    name: "youtube_comments",
    description: "A video's comments and their replies.",
    needs: ["youtube_read", "youtube_manage"],
    properties: { video_id: VIDEO_ID, limit: s.limit(25), page_token: PAGE_TOKEN },
    required: ["video_id"],
    async run(a, g) {
      const found = await g.json("youtube", "GET", "/commentThreads", {
        params: { part: "snippet,replies", videoId: a.video_id, maxResults: a.limit, pageToken: arg.opt(a, "page_token"), textFormat: "plainText" },
        what: "that video",
      });
      return { comments: found.items ?? [], next_page: found.nextPageToken ?? null };
    },
  }),
  tool({
    name: "youtube_report",
    description: "The channel's numbers between two dates.",
    needs: ["youtube_analytics"],
    properties: {
      start: s.str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
      end: s.str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
      metrics: s.str({ maxLength: 300, description: "Like views,likes,comments." }),
      dimensions: s.str({ maxLength: 100, description: "Like day." }),
    },
    required: ["start", "end", "metrics"],
    run: (a, g) =>
      g.json("youtubeanalytics", "GET", "/reports", {
        params: { ids: "channel==MINE", startDate: a.start, endDate: a.end, metrics: a.metrics, dimensions: arg.opt(a, "dimensions") },
      }),
  }),
  tool({
    name: "upload_video",
    description: "Upload a video file from this computer (its full path) to the channel. It's private unless you say otherwise.",
    needs: ["youtube_upload", "youtube_manage"],
    properties: {
      file: s.str({ minLength: 1, maxLength: 500, description: "The video's full path on this computer." }),
      title: TITLE,
      made_for_kids: s.bool({ description: "YouTube requires an answer." }),
      description: { ...DESCRIPTION, default: "" },
      tags: TAGS,
      privacy: s.oneOf(PRIVACY, { default: "private" }),
      publish_at: PUBLISH_AT,
    },
    required: ["file", "title", "made_for_kids"],
    async run(a, g) {
      const privacy = arg.str(a, "privacy");
      const publishAt = arg.opt(a, "publish_at");
      checkSchedule(privacy, publishAt);
      const file = await videoFile(arg.str(a, "file"));
      const status: Json = { privacyStatus: privacy, selfDeclaredMadeForKids: arg.bool(a, "made_for_kids") };
      if (publishAt) status.publishAt = publishAt;
      const meta = { snippet: { title: a.title, description: a.description, tags: arg.strs(a, "tags") ?? [] }, status };
      const opened = await g.raw("upload", "POST", "/youtube/v3/videos", {
        params: { uploadType: "resumable", part: "snippet,status" },
        json: meta,
        headers: { "X-Upload-Content-Length": String(file.size), "X-Upload-Content-Type": file.type },
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      const address = opened.headers.get("location");
      if (!address) throw new ToolError("YouTube didn't start the upload. Try again in a moment.");
      const found = await sendParts(g, address, file.path, file.size);
      return { video_id: found.id ?? null, status: found.status ?? null };
    },
  }),
  tool({
    name: "edit_video",
    description: "Change a video's title, description or tags. What isn't named stays as it is.",
    needs: ["youtube_manage"],
    properties: { video_id: VIDEO_ID, title: TITLE, description: DESCRIPTION, tags: TAGS },
    required: ["video_id"],
    async run(a, g) {
      const id = arg.str(a, "video_id");
      const snippet: Json = (await video(g, id, "snippet")).snippet ?? {};
      const merged: Json = {};
      for (const k of ["title", "description", "tags", "categoryId", "defaultLanguage"]) if (k in snippet) merged[k] = snippet[k];
      for (const k of ["title", "description", "tags"]) if (a[k] !== undefined) merged[k] = a[k];
      return g.json("youtube", "PUT", "/videos", { params: { part: "snippet" }, json: { id, snippet: merged }, what: "that video" });
    },
  }),
  tool({
    name: "set_video_privacy",
    description: "Make a video private, unlisted or public, or set when a private one goes public.",
    needs: ["youtube_manage"],
    properties: { video_id: VIDEO_ID, privacy: s.oneOf(PRIVACY), publish_at: PUBLISH_AT },
    required: ["video_id", "privacy"],
    async run(a, g) {
      const id = arg.str(a, "video_id");
      const privacy = arg.str(a, "privacy");
      const publishAt = arg.opt(a, "publish_at");
      checkSchedule(privacy, publishAt);
      const status: Json = (await video(g, id, "status")).status ?? {};
      const sent: Json = {};
      for (const k of ["embeddable", "license", "publicStatsViewable", "selfDeclaredMadeForKids"]) if (k in status) sent[k] = status[k];
      sent.privacyStatus = privacy;
      if (publishAt) sent.publishAt = publishAt;
      return g.json("youtube", "PUT", "/videos", { params: { part: "status" }, json: { id, status: sent }, what: "that video" });
    },
  }),
  tool({
    name: "delete_video",
    description: "Delete a video. It can't be undone.",
    needs: ["youtube_manage"],
    properties: { video_id: VIDEO_ID },
    required: ["video_id"],
    async run(a, g) {
      await g.json("youtube", "DELETE", "/videos", { params: { id: a.video_id }, what: "that video" });
      return { deleted: a.video_id };
    },
  }),
  tool({
    name: "reply_to_comment",
    description: "Reply to a comment, as the channel.",
    needs: ["youtube_manage"],
    properties: { comment_id: COMMENT_ID, text: s.str({ minLength: 1, maxLength: 10_000 }) },
    required: ["comment_id", "text"],
    run: (a, g) =>
      g.json("youtube", "POST", "/comments", {
        params: { part: "snippet" },
        json: { snippet: { parentId: a.comment_id, textOriginal: a.text } },
        what: "that comment",
      }),
  }),
  tool({
    name: "delete_comment",
    description: "Delete one of the channel's own comments or replies.",
    needs: ["youtube_manage"],
    properties: { comment_id: COMMENT_ID },
    required: ["comment_id"],
    async run(a, g) {
      await g.json("youtube", "DELETE", "/comments", { params: { id: a.comment_id }, what: "that comment" });
      return { deleted: a.comment_id };
    },
  }),
];
