// Microsoft 365: Outlook mail and calendar, OneDrive and SharePoint files, through
// Microsoft Graph. Ported from Ringkeeper (src/ringkeeper/adapters/vendors/microsoft.py);
// the pieces are in ./microsoft/. Each of Ringkeeper's operations is its own tool here.
//
// Not carried over: Ringkeeper's approvals (held writes, typed names, undo). In their place,
// deleting mail and sharing files are tick boxes of their own, unticked to begin with, and
// one email or invitation reaches at most 50 people. The tools that only work with
// Ringkeeper's project folders and pictures (view_attachment, view_file, save_attachment,
// save_file) are left out. Left out on purpose, as in Ringkeeper: mail rules and mailbox
// settings, uploads, $batch, other people's mailboxes.
import type { BuiltinService } from "./types.js";
import { op } from "./microsoft/graph.js";
import { MICROSOFT_ACCESS_KEYS } from "./microsoft/access.js";
import { mailTools } from "./microsoft/mail.js";
import { calendarTools } from "./microsoft/calendar.js";
import { fileTools } from "./microsoft/files.js";

export { MICROSOFT_ACCESS, MICROSOFT_ACCESS_KEYS, MICROSOFT_ALWAYS, type MicrosoftAccessKey } from "./microsoft/access.js";

const me = op({
  name: "get_me",
  description: "Who this Microsoft account is: name, email address and job title.",
  needs: MICROSOFT_ACCESS_KEYS,
  method: "GET",
  path: "/me",
  after: (a) => ({ name: a.displayName, email: a.mail ?? a.userPrincipalName, job_title: a.jobTitle ?? null, id: a.id }),
});

export const microsoft: BuiltinService = {
  id: "microsoft",
  name: "Microsoft",
  tools: [me, ...mailTools, ...calendarTools, ...fileTools],
};
