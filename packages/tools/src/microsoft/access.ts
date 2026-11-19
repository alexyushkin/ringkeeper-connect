// What a Microsoft account can be given at sign-in: the access keys (Ringkeeper's
// developer_apps.py MICROSOFT_ACCESS, with the scopes of adapters/vendors/microsoft.py),
// their labels as the person sees them, and the Microsoft Graph permissions each asks for.
//
// Two keys are Ringkeeper Connect's own: mail_delete and files_share. Ringkeeper asks the
// person to approve each delete and share as it happens; Ringkeeper Connect doesn't hold
// calls for approval, so those are separate tick boxes, left unticked to begin with.
export const MICROSOFT_ACCESS = {
  mail_read: { label: "Read mail", scope: "Mail.Read" },
  mail_drafts: { label: "Write drafts, mark and move mail", scope: "Mail.ReadWrite" },
  mail_send: { label: "Send mail", scope: "Mail.Send" },
  mail_delete: { label: "Delete mail", scope: "Mail.ReadWrite" },
  calendar_read: { label: "Calendar: read events", scope: "Calendars.Read" },
  calendar_write: { label: "Calendar: add, change and cancel events", scope: "Calendars.ReadWrite" },
  // Finding SharePoint sites needs Sites.Read.All too.
  files_read: { label: "OneDrive and SharePoint: read files", scope: "Files.Read.All Sites.Read.All" },
  files_write: { label: "OneDrive and SharePoint: add, change and delete files", scope: "Files.ReadWrite.All Sites.Read.All" },
  files_share: { label: "OneDrive and SharePoint: share files and make links", scope: "Files.ReadWrite.All Sites.Read.All" },
} as const;

/** Asked for at every sign-in: who signed in, and staying signed in. */
export const MICROSOFT_ALWAYS = "openid profile email offline_access User.Read";

export type MicrosoftAccessKey = keyof typeof MICROSOFT_ACCESS;
export const MICROSOFT_ACCESS_KEYS = Object.keys(MICROSOFT_ACCESS) as MicrosoftAccessKey[];

export function accessLabels(keys: readonly string[]): string {
  return keys.map((k) => `"${MICROSOFT_ACCESS[k as MicrosoftAccessKey]?.label ?? k}"`).join(" or ");
}
