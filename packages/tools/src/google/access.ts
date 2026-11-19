// What a Google account can be given at sign-in: the access keys (as in Ringkeeper's
// services/google_oauth.py ACCESS), their labels as the person sees them, and the
// Google scope each one asks for.
const G = "https://www.googleapis.com/auth/";

export const GOOGLE_ACCESS = {
  mail_read: { label: "Read mail", scope: G + "gmail.readonly" },
  mail_send: { label: "Send mail", scope: G + "gmail.send" },
  mail_drafts: { label: "Write drafts", scope: G + "gmail.compose" },
  mail_trash: { label: "Move mail to the trash", scope: G + "gmail.modify" },
  drive_files: { label: "Drive: files Ringkeeper Connect creates or is given", scope: G + "drive.file" },
  drive_read_all: { label: "Drive: read all files", scope: G + "drive.readonly" },
  calendar_read: { label: "Calendar: read events", scope: G + "calendar.events.readonly" },
  calendar_write: { label: "Calendar: add and change events", scope: G + "calendar.events" },
  sheets_read: { label: "Sheets: read", scope: G + "spreadsheets.readonly" },
  sheets_write: { label: "Sheets: read and edit", scope: G + "spreadsheets" },
  docs_read: { label: "Docs: read", scope: G + "documents.readonly" },
  docs_write: { label: "Docs: read, create and edit", scope: G + "documents" },
  search_console_read: { label: "Search Console: read", scope: G + "webmasters.readonly" },
  analytics_read: { label: "Analytics: read", scope: G + "analytics.readonly" },
  youtube_read: { label: "YouTube: read videos and comments", scope: G + "youtube.readonly" },
  youtube_upload: { label: "YouTube: upload videos", scope: G + "youtube.upload" },
  youtube_manage: { label: "YouTube: edit and delete videos, reply to comments", scope: G + "youtube.force-ssl" },
  youtube_analytics: { label: "YouTube: read analytics", scope: G + "yt-analytics.readonly" },
} as const;

export type AccessKey = keyof typeof GOOGLE_ACCESS;
export const ACCESS_KEYS = Object.keys(GOOGLE_ACCESS) as AccessKey[];

export function accessLabels(keys: readonly string[]): string {
  return keys.map((k) => `"${GOOGLE_ACCESS[k as AccessKey]?.label ?? k}"`).join(" or ");
}
