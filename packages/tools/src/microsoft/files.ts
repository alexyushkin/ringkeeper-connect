// OneDrive and SharePoint files through Microsoft Graph, as in Ringkeeper's
// adapters/vendors/microsoft.py. files_read reads; files_write adds, renames, moves,
// copies and deletes; files_share shares and takes access away.
import { ToolError } from "../types.js";
import { arg, s, type Schema } from "../google/schema.js";
import { INSIDE, PAGES, READ_PARTS } from "../google/gmail.js";
import { extract, MAX_FILE_BYTES, textAnswer } from "../google/extract.js";
import type { MicrosoftAccessKey } from "./access.js";
import { ODATA, op, tidy, type Json } from "./graph.js";

const READS: MicrosoftAccessKey[] = ["files_read", "files_write", "files_share"];
const FILE = "/drives/{drive_id}/items/{item_id}";
const FILE_IDS = {
  drive_id: "The drive's id: get_my_drive for this account's OneDrive, list_site_drives for a SharePoint library, or parentReference.driveId of a file.",
  item_id: "The file or folder's id, from list_folder, list_my_files or search_files. root is the top of the drive.",
};
const PARENT: Schema = {
  type: "object",
  description: '{"driveId": "...", "id": "<the folder\'s id>"}',
  properties: { driveId: s.str({ maxLength: 1000 }), id: s.str({ maxLength: 1000 }) },
};
const NAME: Schema = s.str({ minLength: 1, maxLength: 255, description: "The file or folder's name." });

function fileRow(item: Json): Json {
  return {
    id: item.id,
    name: item.name,
    ...(item.folder ? { folder: true, children: item.folder.childCount } : { size: item.size, type: item.file?.mimeType }),
    modified: item.lastModifiedDateTime,
    drive_id: item.parentReference?.driveId,
    web_url: item.webUrl,
  };
}

export const fileTools = [
  op({
    name: "get_my_drive",
    description: "This account's OneDrive: its id (drive_id for the other file tools), owner and space used.",
    needs: READS,
    method: "GET",
    path: "/me/drive",
  }),
  op({
    name: "list_my_files",
    description: "What's at the top of this account's OneDrive: each file or folder's id, name, size, when it changed and its link.",
    needs: READS,
    method: "GET",
    path: "/me/drive/root/children",
    query: ODATA,
    pages: true,
  }),
  op({
    name: "list_folder",
    description: "What's in a folder: each file or folder's id, name, size, when it changed and its link.",
    needs: READS,
    method: "GET",
    path: `${FILE}/children`,
    ids: FILE_IDS,
    what: "that folder",
    query: ODATA,
    pages: true,
  }),
  op({
    name: "get_file",
    description: "One file or folder's details.",
    needs: READS,
    method: "GET",
    path: FILE,
    ids: FILE_IDS,
    what: "that file",
    query: { select: ODATA.select },
  }),
  op({
    name: "read_file",
    description:
      "A file's text: Word, Excel, PowerPoint, CSV, text, HTML and a .zip (`inside` reads a file in it). A long one starts with its outline: read on with pages=. PDFs and pictures can't be read here.",
    needs: READS,
    method: "GET",
    path: FILE,
    ids: FILE_IDS,
    what: "that file",
    local: { pages: PAGES, inside: INSIDE, ...READ_PARTS },
    async after(meta, a, g, path) {
      const name = String(meta.name ?? "file");
      if (meta.folder) throw new ToolError(`'${name}' is a folder: list_folder shows what's in it.`);
      if (Number(meta.size) > MAX_FILE_BYTES) throw new ToolError(`'${name}' is too large to read here (${Number(meta.size).toLocaleString("en-US")} bytes).`);
      const data = await g.download(`${path}/content`, `'${name}'`);
      const shown = { id: meta.id, name, type: String(meta.file?.mimeType ?? ""), size: data.length, web_url: meta.webUrl };
      return textAnswer(shown, extract(name, shown.type, data, arg.opt(a, "inside")), arg.int(a, "offset"), arg.int(a, "limit"), arg.opt(a, "pages"));
    },
  }),
  op({
    name: "list_file_access",
    description: "Who can reach a file or folder: each person, group or link, with its role and permission id.",
    needs: READS,
    method: "GET",
    path: `${FILE}/permissions`,
    ids: FILE_IDS,
    what: "that file",
    query: { select: ODATA.select },
    pages: true,
  }),
  op({
    name: "search_files",
    description: "Search OneDrive and SharePoint files by name and what's in them (work or school accounts). For a personal account, list_my_files and list_folder.",
    needs: READS,
    method: "POST",
    path: "/search/query",
    body: {},
    local: {
      query: s.str({ minLength: 1, maxLength: 1000, description: "Words to find, e.g. budget 2026 or filetype:xlsx." }),
      limit: s.int({ minimum: 1, maximum: 100, default: 25, description: "The most files to return." }),
      from: s.int({ minimum: 0, default: 0, description: "Where to start: next_from from the last answer." }),
    },
    required: ["query"],
    check(body, a) {
      body.requests = [{ entityTypes: ["driveItem"], query: { queryString: arg.str(a, "query") }, from: arg.int(a, "from"), size: arg.int(a, "limit") }];
    },
    after(answer, a) {
      const found = ((answer.value ?? []) as Json[]).flatMap((v) => (v.hitsContainers ?? []) as Json[]);
      const hits = found.flatMap((c) => (c.hits ?? []) as Json[]);
      const more = found.some((c) => c.moreResultsAvailable);
      return {
        files: hits.map((h) => ({ ...fileRow((h.resource ?? {}) as Json), summary: h.summary })),
        total: found.reduce((n, c) => n + Number(c.total ?? 0), 0),
        ...(more ? { next_from: arg.int(a, "from") + hits.length, note: "More follow: call again with from=next_from." } : {}),
      };
    },
  }),
  op({
    name: "search_sites",
    description: "Find SharePoint sites this account can see, by name: each site's id (for list_site_drives), name and link.",
    needs: READS,
    method: "GET",
    path: "/sites",
    query: { search: s.str({ minLength: 1, maxLength: 500, description: "Words in the site's name; * finds every site." }) },
    queryNames: { search: "search" },
    required: ["search"],
    pages: true,
  }),
  op({
    name: "list_site_drives",
    description: "A SharePoint site's document libraries, each with its drive id.",
    needs: READS,
    method: "GET",
    path: "/sites/{site_id}/drives",
    ids: { site_id: "The site's id, from search_sites." },
    what: "that site",
    pages: true,
  }),
  op({
    name: "create_folder",
    description: "Add a folder inside a folder (item_id root for the top of the drive).",
    needs: ["files_write"],
    method: "POST",
    path: `${FILE}/children`,
    ids: { ...FILE_IDS, item_id: "The folder it goes in; root for the top of the drive." },
    what: "that folder",
    body: { name: NAME, conflictBehavior: s.oneOf(["rename", "fail", "replace"], { default: "fail", description: "If the name is taken: rename the new one, fail, or replace the old one." }) },
    bodyNames: { conflictBehavior: "@microsoft.graph.conflictBehavior" },
    required: ["name"],
    check(body) {
      body.folder = {};
    },
    after: (answer) => fileRow(answer),
  }),
  op({
    name: "rename_file",
    description: "Rename a file or folder, or change its description.",
    needs: ["files_write"],
    method: "PATCH",
    path: FILE,
    ids: FILE_IDS,
    what: "that file",
    body: { name: NAME, description: s.str({ maxLength: 1000 }) },
    after: (answer) => fileRow(answer),
  }),
  op({
    name: "move_file",
    description: "Move a file or folder into another folder, and rename it if name is given.",
    needs: ["files_write"],
    method: "PATCH",
    path: FILE,
    ids: FILE_IDS,
    what: "that file",
    body: { parentReference: PARENT, name: NAME },
    required: ["parentReference"],
    after: (answer) => fileRow(answer),
  }),
  op({
    name: "copy_file",
    description: "Copy a file or folder into a folder. Microsoft makes the copy in the background, so it can take a moment to appear.",
    needs: ["files_write"],
    method: "POST",
    path: `${FILE}/copy`,
    ids: FILE_IDS,
    what: "that file",
    body: { parentReference: PARENT, name: NAME },
    required: ["parentReference"],
    after: () => ({ copying: true, note: "Microsoft is making the copy: list_folder shows it once it's done." }),
  }),
  op({
    name: "delete_file",
    description: "Delete a file or folder: it goes to the recycle bin.",
    needs: ["files_write"],
    method: "DELETE",
    path: FILE,
    ids: FILE_IDS,
    what: "that file",
  }),
  op({
    name: "share_file",
    description: "Share a file or folder with people by email: roles read or write. They get an invitation unless sendInvitation is false.",
    needs: ["files_share"],
    method: "POST",
    path: `${FILE}/invite`,
    ids: FILE_IDS,
    what: "that file",
    body: {
      recipients: s.list({ type: "object", description: '{"email": "anna@acme.example"}', properties: { email: s.address() }, required: ["email"] }, { minItems: 1, maxItems: 50 }),
      roles: s.list(s.oneOf(["read", "write"]), { minItems: 1, maxItems: 1 }),
      requireSignIn: s.bool({ default: true }),
      sendInvitation: s.bool({ default: true }),
      message: s.str({ maxLength: 2000 }),
      expirationDateTime: s.str({ maxLength: 40, description: "When the access ends, e.g. 2026-12-31T00:00:00Z." }),
    },
    required: ["recipients", "roles"],
    after: (answer) => ({ shared: true, access: tidy(answer.value ?? []) }),
  }),
  op({
    name: "create_share_link",
    description:
      "Make a link to a file or folder. type: view or edit. scope: organization (people in the client's company), users (only people it's shared with) or anonymous (anyone with the link, where allowed).",
    needs: ["files_share"],
    method: "POST",
    path: `${FILE}/createLink`,
    ids: FILE_IDS,
    what: "that file",
    body: {
      type: s.oneOf(["view", "edit", "embed"]),
      scope: s.oneOf(["organization", "users", "anonymous"]),
      expirationDateTime: s.str({ maxLength: 40, description: "When the link stops working, e.g. 2026-12-31T00:00:00Z." }),
      retainInheritedPermissions: s.bool(),
    },
    required: ["type"],
    after: (answer) => ({ link: answer.link?.webUrl, type: answer.link?.type, scope: answer.link?.scope, permission_id: answer.id, expires: answer.expirationDateTime ?? null }),
  }),
  op({
    name: "remove_file_access",
    description: "Take away a person's, group's or link's access to a file: its permission id from list_file_access.",
    needs: ["files_share"],
    method: "DELETE",
    path: `${FILE}/permissions/{permission_id}`,
    ids: { ...FILE_IDS, permission_id: "The permission's id, from list_file_access." },
    what: "that file or permission",
  }),
];
