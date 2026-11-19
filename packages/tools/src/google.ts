// Google account: Gmail, Drive, Calendar, Sheets, Docs, Search Console,
// Analytics, YouTube, Google Ads. Ported from Ringkeeper (src/ringkeeper/adapters/google.py);
// the pieces are in ./google/.
//
// Not carried over: Ringkeeper's vault, its approvals (write rules, typed names,
// undo, the stale-edit check on edit_doc) and its project folders. The tools that only
// work with those (view_attachment, view_file: they answer with images; save_attachment,
// save_file: they save into a project's folder) are left out. upload_video takes a file's
// full path on this computer instead of a path in a project's folder.
import type { BuiltinService } from "./types.js";
import { gmailTools } from "./google/gmail.js";
import { mediaTools } from "./google/media.js";
import { workspaceTools } from "./google/workspace.js";
import { adsTools } from "./google/ads.js";

export { ACCESS_KEYS, GOOGLE_ACCESS, type AccessKey } from "./google/access.js";

export const google: BuiltinService = {
  id: "google",
  name: "Google",
  tools: [...gmailTools, ...workspaceTools, ...mediaTools, ...adsTools],
};
