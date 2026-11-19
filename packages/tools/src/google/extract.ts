// The text inside a file: an attachment, or something in Drive (ported from Ringkeeper's
// adapters/extract.py and adapters/files.py, with Node's own zlib only).
//
// Read here: text, CSV, JSON, XML, HTML, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and
// a .zip (its list, and a file in it with `inside`). Not here, unlike Ringkeeper: PDFs, text in
// pictures (OCR), and an attached email (.eml, .msg) need libraries this program doesn't carry,
// so those say so plainly instead of guessing.
//
// These files come from outside: a size that doesn't match what's inside, or an XML entity,
// ends the reading.
import { inflateRawSync } from "node:zlib";
import { ToolError } from "../types.js";
import type { Json } from "./http.js";
import { htmlToText, page, PAGE_CHARS } from "./text.js";

export const MAX_FILE_BYTES = 40_000_000;
const MAX_UNPACKED_BYTES = 200_000_000;
const MAX_TEXT_CHARS = 5_000_000;
const MAX_LISTED = 500;
const MAX_ZIP_FILES = 20_000;
const MOST_SHRUNK = 200;
const OUTLINE_CHARS = 30_000; // a file longer than this starts with its outline
const FIRST_PAGES = 2; // shown with the outline

export const PDF = "application/pdf";
export const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const EXCEL = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const DECK = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const ZIP = "application/zip";
const EML = "message/rfc822";
const MSG = "application/vnd.ms-outlook";

const BY_SUFFIX: Record<string, string> = {
  ".pdf": PDF, ".docx": WORD, ".xlsx": EXCEL, ".pptx": DECK, ".zip": ZIP, ".eml": EML, ".msg": MSG,
  ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".txt": "text/plain", ".md": "text/plain",
  ".log": "text/plain", ".json": "application/json", ".xml": "application/xml", ".html": "text/html",
  ".htm": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".tif": "image/tiff", ".tiff": "image/tiff", ".bmp": "image/bmp",
  ".gif": "image/gif", ".webp": "image/webp",
};
const KNOWN = new Set([...Object.values(BY_SUFFIX), "application/csv", MSG]);
const ALIASES: Record<string, string> = {
  "application/x-zip-compressed": ZIP, "application/x-zip": ZIP, "multipart/x-zip": ZIP,
  "application/x-outlook-msg": MSG, "application/x-msg": MSG, "image/jpg": "image/jpeg",
};
const INSTEAD: Record<string, string> = {
  ".doc": "an old Word document: save it as .docx",
  ".xls": "an old Excel workbook: save it as .xlsx or CSV",
  ".ppt": "an old PowerPoint deck: save it as .pptx",
  ".numbers": "a Numbers spreadsheet: export it as .xlsx",
  ".pages": "a Pages document: export it as .docx",
  ".key": "a Keynote deck: export it as .pptx",
  ".odt": "an OpenDocument text: save it as .docx",
  ".ods": "an OpenDocument spreadsheet: save it as .xlsx or CSV",
  ".odp": "an OpenDocument presentation: save it as .pptx",
  ".rtf": "a rich text file: save it as .docx or plain text",
  ".heic": "an iPhone photo (HEIC)",
  ".heif": "an iPhone photo (HEIF)",
  ".rar": "a RAR archive: send the files themselves, or a .zip",
  ".7z": "a 7-Zip archive: send the files themselves, or a .zip",
  ".tar": "a tar archive: send the files themselves, or a .zip",
  ".gz": "a compressed file: send the file itself, or a .zip",
  ".tgz": "a compressed archive: send the files themselves, or a .zip",
  ".psd": "a Photoshop file",
  ".ai": "an Illustrator file",
  ".dwg": "a CAD drawing",
  ".vsdx": "a Visio drawing",
  ".epub": "an e-book",
};
const PICTURE_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp"]);

export interface Page {
  number: number; // from 1
  text: string;
  pictures: number;
  title: string; // a slide's or a sheet's
}

export interface Extracted {
  text: string;
  kind: string;
  note?: string;
  pages: Page[];
  unit: string; // what one of `pages` is called
  pictures: number;
}

function extracted(text: string, kind: string, more: Partial<Extracted> = {}): Extracted {
  return { text, kind, pages: [], unit: "page", pictures: 0, ...more };
}

function suffix(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const thousands = (n: number) => n.toLocaleString("en-US");

/** Page numbers as a person writes them: 1-3, 7, 9-10. */
export function spans(numbers: number[]): string {
  const found: [number, number][] = [];
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const last = found[found.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else found.push([n, n]);
  }
  return found.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
}

/** A file's type, from its name when the sender only said "octet-stream" (or a type nothing here reads). */
export function kindOf(name: string, mime: string): string {
  let given = (mime.split(";")[0] ?? "").trim().toLowerCase();
  given = ALIASES[given] ?? given;
  const named = BY_SUFFIX[suffix(name)];
  const generic = given === "" || given === "application/octet-stream" || given === "binary/octet-stream";
  const known = KNOWN.has(given) || given.startsWith("text/") || given.startsWith("image/");
  if (!generic && (named === undefined || known)) return given;
  return named ?? (given || "application/octet-stream");
}

function cantRead(name: string, kind: string): ToolError {
  const instead = INSTEAD[suffix(name)];
  if (instead) return new ToolError(`'${name}' is ${instead}. Text can't be taken out of that here.`);
  return new ToolError(
    `'${name}' is a ${kind} file; text can't be taken out of that here. A Word, Excel, PowerPoint or text copy of it would work.`,
  );
}

function decoded(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString("utf16le");
  if (data[0] === 0xfe && data[1] === 0xff) {
    const swapped = Buffer.from(data.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  const start = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(start));
  } catch {
    return data.toString("latin1");
  }
}

// --- A .zip, read from its central directory ---

interface Entry {
  name: string;
  method: number;
  flags: number;
  packed: number;
  size: number;
  offset: number;
}

class Zip {
  readonly entries: Entry[];
  constructor(private readonly data: Buffer) {
    this.entries = Zip.read(data);
  }

  private static damaged(): ToolError {
    return new ToolError("that file is damaged, or isn't what its name says");
  }

  private static read(data: Buffer): Entry[] {
    let end = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65_535); i--) {
      if (data.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw Zip.damaged();
    const count = data.readUInt16LE(end + 10);
    let at = data.readUInt32LE(end + 16);
    if (count > MAX_ZIP_FILES) throw new ToolError("that file holds far more files than it should; it wasn't read");
    const entries: Entry[] = [];
    let total = 0;
    for (let n = 0; n < count; n++) {
      if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) throw Zip.damaged();
      const nameLength = data.readUInt16LE(at + 28);
      const extra = data.readUInt16LE(at + 30);
      const comment = data.readUInt16LE(at + 32);
      const entry: Entry = {
        flags: data.readUInt16LE(at + 8),
        method: data.readUInt16LE(at + 10),
        packed: data.readUInt32LE(at + 20),
        size: data.readUInt32LE(at + 24),
        offset: data.readUInt32LE(at + 42),
        name: data.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
      };
      total += entry.size;
      entries.push(entry);
      at += 46 + nameLength + extra + comment;
    }
    if (total > MAX_UNPACKED_BYTES) throw new ToolError("that file unpacks to far more than it should; it wasn't read");
    return entries;
  }

  files(): Entry[] {
    return this.entries.filter((e) => !e.name.endsWith("/"));
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.name === name);
  }

  get(name: string, most = MAX_UNPACKED_BYTES): Buffer {
    const entry = this.entries.find((e) => e.name === name);
    if (!entry) throw Zip.damaged();
    return this.open(entry, most);
  }

  open(entry: Entry, most = MAX_UNPACKED_BYTES): Buffer {
    const d = this.data;
    const at = entry.offset;
    if (at + 30 > d.length || d.readUInt32LE(at) !== 0x04034b50) throw Zip.damaged();
    const start = at + 30 + d.readUInt16LE(at + 26) + d.readUInt16LE(at + 28);
    const packed = d.subarray(start, start + entry.packed);
    if (entry.size > most) throw new ToolError("that file unpacks to far more than it should; it wasn't read");
    let out: Buffer;
    try {
      if (entry.method === 0) out = Buffer.from(packed);
      else if (entry.method === 8) out = inflateRawSync(packed, { maxOutputLength: Math.max(most, 1) + 1 });
      else throw Zip.damaged();
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError("that file unpacks to far more than it should, or is damaged; it wasn't read");
    }
    if (out.length > most || out.length !== entry.size) throw new ToolError("that file unpacks to far more than it should; it wasn't read");
    return out;
  }
}

function archive(data: Buffer): Zip {
  return new Zip(data);
}

// --- Just enough XML: elements with their namespaces resolved, attributes and text ---

export interface Node {
  tag: string; // {namespace}local, like ElementTree
  attrs: Record<string, string>;
  children: Node[];
  text: string; // the text directly inside, before any child
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function xmlDecode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return XML_ENTITIES[ref] ?? whole;
  });
}

export function parseXml(data: Buffer): Node {
  const source = data.toString("utf8");
  const head = source.slice(0, 4096);
  if (head.includes("<!ENTITY") || head.includes("<!DOCTYPE")) {
    throw new ToolError("that file has XML it has no reason to have; it wasn't read");
  }
  const root: Node = { tag: "", attrs: {}, children: [], text: "" };
  const stack: { node: Node; ns: Record<string, string> }[] = [{ node: root, ns: { xml: "http://www.w3.org/XML/1998/namespace" } }];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s\/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  // Like ElementTree's .text: what comes before an element's first child (text after it isn't used here).
  const addText = (text: string) => {
    const top = stack[stack.length - 1]!.node;
    if (!top.children.length) top.text += text;
  };
  for (const m of source.matchAll(re)) {
    if (m[1] !== undefined) addText(m[1]);
    else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const parent = stack[stack.length - 1]!;
      const raw: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) raw[a[1]!] = xmlDecode(a[2] ?? a[3] ?? "");
      const ns = { ...parent.ns };
      for (const [k, v] of Object.entries(raw)) {
        if (k === "xmlns") ns[""] = v;
        else if (k.startsWith("xmlns:")) ns[k.slice(6)] = v;
      }
      const qualify = (name: string, element: boolean) => {
        const colon = name.indexOf(":");
        const prefix = colon < 0 ? "" : name.slice(0, colon);
        const local = colon < 0 ? name : name.slice(colon + 1);
        const uri = colon < 0 && !element ? undefined : ns[prefix];
        return uri ? `{${uri}}${local}` : local;
      };
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) if (k !== "xmlns" && !k.startsWith("xmlns:")) attrs[qualify(k, false)] = v;
      const node: Node = { tag: qualify(m[3], true), attrs, children: [], text: "" };
      parent.node.children.push(node);
      if (!m[5]) stack.push({ node, ns });
    } else if (m[6] !== undefined) addText(xmlDecode(m[6]));
  }
  const top = root.children[0];
  if (!top) throw new ToolError("that file is damaged, or isn't what its name says");
  return top;
}

function* iter(node: Node, tag?: string): Generator<Node> {
  if (!tag || node.tag === tag) yield node;
  for (const child of node.children) yield* iter(child, tag);
}
const kids = (node: Node, tag: string) => node.children.filter((c) => c.tag === tag);
const allText = (node: Node, tag: string) => [...iter(node, tag)].map((t) => t.text).join("");

const W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}";
const S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}";
const R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}";
const A = "{http://schemas.openxmlformats.org/drawingml/2006/main}";
const P = "{http://schemas.openxmlformats.org/presentationml/2006/main}";
const RELS = "{http://schemas.openxmlformats.org/package/2006/relationships}";

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

/** A part's relations: each id and the file it points to (a path in the archive), with its type after #. */
function relations(zip: Zip, part: string): Record<string, string> {
  const cut = part.lastIndexOf("/");
  const folder = cut < 0 ? "" : part.slice(0, cut);
  const path = `${folder ? `${folder}/` : ""}_rels/${part.slice(cut + 1)}.rels`;
  if (!zip.has(path)) return {};
  const found: Record<string, string> = {};
  for (const item of iter(parseXml(zip.get(path)), `${RELS}Relationship`)) {
    const target = item.attrs.Target ?? "";
    if (item.attrs.TargetMode === "External" || !target) continue;
    const joined = target.startsWith("/") ? target.replace(/^\/+/, "") : `${folder}/${target}`;
    found[item.attrs.Id ?? ""] = `${normalize(joined)}#${item.attrs.Type ?? ""}`;
  }
  return found;
}

function pictureParts(zip: Zip, part: string, root: Node): string[] {
  const rels = relations(zip, part);
  const found: string[] = [];
  for (const blip of iter(root, `${A}blip`)) {
    const path = (rels[blip.attrs[`${R}embed`] ?? ""] ?? "").split("#")[0]!;
    if (path && PICTURE_SUFFIXES.has(suffix(path)) && !found.includes(path)) found.push(path);
  }
  return found;
}

// Word

function wordParagraph(p: Node): string {
  const parts: string[] = [];
  for (const node of iter(p)) {
    if (node.tag === `${W}t`) parts.push(node.text);
    else if (node.tag === `${W}tab`) parts.push("\t");
    else if (node.tag === `${W}br` || node.tag === `${W}cr`) parts.push("\n");
  }
  return parts.join("");
}

function wordBlock(block: Node, lines: string[]) {
  for (const child of block.children) {
    if (child.tag === `${W}p`) lines.push(wordParagraph(child));
    else if (child.tag === `${W}tbl`) {
      for (const row of iter(child, `${W}tr`)) {
        const cells = kids(row, `${W}tc`).map((cell) => [...iter(cell, `${W}p`)].map(wordParagraph).join(" ").trim());
        lines.push(cells.join(" | "));
      }
    } else if (child.tag === `${W}body` || child.tag === `${W}sdt` || child.tag === `${W}sdtContent`) wordBlock(child, lines);
  }
}

function docx(data: Buffer): Extracted {
  const zip = archive(data);
  if (!zip.has("word/document.xml")) throw new ToolError("that isn't a Word document");
  const root = parseXml(zip.get("word/document.xml"));
  const count = pictureParts(zip, "word/document.xml", root).length;
  const lines: string[] = [];
  wordBlock(root, lines);
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const note = count ? `It has ${plural(count, "picture")}, which can't be read here.` : undefined;
  return extracted(text, "word", { note, pictures: count });
}

// Excel

function column(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? "A";
  let n = 0;
  for (const l of letters) n = n * 26 + l.charCodeAt(0) - 64;
  return n - 1;
}

function csvRow(values: string[]): string {
  return values.map((v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",");
}

function xlsx(data: Buffer): Extracted {
  const zip = archive(data);
  if (!zip.has("xl/workbook.xml")) throw new ToolError("that isn't an Excel workbook");
  const shared = zip.has("xl/sharedStrings.xml")
    ? kids(parseXml(zip.get("xl/sharedStrings.xml")), `${S}si`).map((si) => allText(si, `${S}t`))
    : [];
  const book = parseXml(zip.get("xl/workbook.xml"));
  const rels = parseXml(zip.get("xl/_rels/workbook.xml.rels"));
  const targets: Record<string, string> = {};
  for (const r of rels.children) targets[r.attrs.Id ?? ""] = r.attrs.Target ?? "";
  const pages: Page[] = [];
  let written = 0;
  let number = 0;
  for (const sheet of iter(book, `${S}sheet`)) {
    const target = (targets[sheet.attrs[`${R}id`] ?? ""] ?? "").replace(/^\/+/, "");
    const path = target.startsWith("xl/") ? target : `xl/${target}`;
    if (!zip.has(path)) continue;
    number += 1;
    const name = sheet.attrs.name || "Sheet";
    const out = [`# ${name}`];
    for (const row of iter(parseXml(zip.get(path)), `${S}row`)) {
      const values: string[] = [];
      for (const cell of kids(row, `${S}c`)) {
        const at = column(cell.attrs.r ?? "A");
        while (values.length < at) values.push("");
        const kind = cell.attrs.t;
        let value: string;
        if (kind === "inlineStr") value = allText(cell, `${S}t`);
        else {
          const v = kids(cell, `${S}v`)[0]?.text ?? "";
          value = kind === "s" && /^\d+$/.test(v) && Number(v) < shared.length ? shared[Number(v)]! : v;
        }
        values.push(value);
      }
      out.push(csvRow(values));
    }
    const text = out.join("\n").trim();
    pages.push({ number, text, pictures: 0, title: name });
    written += text.length;
    if (written > MAX_TEXT_CHARS) break;
  }
  return extracted(pages.map((p) => p.text).join("\n\n").trim(), "excel", { pages, unit: "sheet" });
}

// PowerPoint

function slideText(node: Node, lines: string[]) {
  for (const child of node.children) {
    if (child.tag === `${A}tr`) {
      const cells = kids(child, `${A}tc`).map((c) => [...iter(c, `${A}p`)].map((p) => allText(p, `${A}t`)).join(" "));
      lines.push(cells.map((c) => c.trim()).join(" | "));
    } else if (child.tag === `${A}p`) lines.push(allText(child, `${A}t`));
    else slideText(child, lines);
  }
}

function placeholder(shape: Node): string {
  const nv = kids(shape, `${P}nvSpPr`)[0];
  const pr = nv && kids(nv, `${P}nvPr`)[0];
  const ph = pr && kids(pr, `${P}ph`)[0];
  return ph ? ph.attrs.type || "body" : "";
}

function shapeText(shape: Node): string {
  const lines: string[] = [];
  slideText(shape, lines);
  return lines.filter((l) => l.trim()).join("\n").trim();
}

export function joined(pages: Page[], unit: string, total?: number): string {
  const of = total ?? pages.length;
  return pages
    .map((p) => {
      if (unit === "sheet") return p.text;
      const title = p.title ? ` ${p.title}` : "";
      return `[${unit[0]!.toUpperCase()}${unit.slice(1)} ${p.number} of ${of}]${title}\n${p.text}`;
    })
    .join("\n\n");
}

function pptx(data: Buffer): Extracted {
  const zip = archive(data);
  if (!zip.has("ppt/presentation.xml")) throw new ToolError("that isn't a PowerPoint deck");
  const deck = parseXml(zip.get("ppt/presentation.xml"));
  const rels = relations(zip, "ppt/presentation.xml");
  const slides: string[] = [];
  for (const s of iter(deck, `${P}sldId`)) {
    const path = (rels[s.attrs[`${R}id`] ?? ""] ?? "").split("#")[0]!;
    if (zip.has(path)) slides.push(path);
  }
  const pages: Page[] = [];
  slides.forEach((slide, i) => {
    const root = parseXml(zip.get(slide));
    const shapes = [...iter(root, `${P}sp`)];
    const titleShape = shapes.find((s) => ["title", "ctrTitle"].includes(placeholder(s)));
    const lines: string[] = [];
    slideText(root, lines);
    let text = lines.filter((l) => l.trim()).join("\n");
    for (const target of Object.values(relations(zip, slide))) {
      const [path, kind] = target.split("#") as [string, string];
      if (kind.endsWith("/notesSlide") && zip.has(path)) {
        const notes = [...iter(parseXml(zip.get(path)), `${P}sp`)].filter((s) => placeholder(s) === "body").map(shapeText).filter(Boolean).join("\n");
        if (notes) text += `\n[Speaker notes]\n${notes}`;
        break;
      }
    }
    const pictures = pictureParts(zip, slide, root).length;
    pages.push({ number: i + 1, text: text.trim(), pictures, title: (titleShape ? shapeText(titleShape) : "").replace(/\n/g, " ") });
  });
  const pictured = pages.filter((p) => p.pictures).map((p) => p.number);
  const note = pictured.length ? `Slides ${spans(pictured)} have pictures, whose text can't be read here.` : undefined;
  return extracted(joined(pages, "slide"), "powerpoint", { note, pages, unit: "slide" });
}

// .zip

function zipListing(data: Buffer): Extracted {
  const files = archive(data).files();
  const listed = files.slice(0, MAX_LISTED).map((f) => `${f.name} (${thousands(f.size)} bytes)`);
  if (files.length > MAX_LISTED) listed.push(`... and ${thousands(files.length - MAX_LISTED)} more`);
  const text = `A .zip of ${plural(files.length, "file")}:\n${listed.join("\n")}`;
  return extracted(text, "zip", { note: files.length ? "Read a file in it with inside=<its path>." : "The .zip is empty." });
}

function fromZip(data: Buffer, inside: string): [string, string, Buffer] {
  const zip = archive(data);
  const files = zip.files();
  const wanted = inside.trim().replace(/^\/+/, "");
  let item = files.find((f) => f.name === wanted);
  if (!item) {
    const named = files.filter((f) => f.name.split("/").pop() === wanted);
    item = named.length === 1 ? named[0] : undefined;
  }
  if (!item) throw new ToolError(`there's no ${inside} in that .zip: its list shows the paths`);
  if (item.flags & 0x1) throw new ToolError(`${item.name} in that .zip has a password, so it can't be read`);
  if (item.size > MAX_FILE_BYTES) throw new ToolError(`${item.name} is too large to read here (${thousands(item.size)} bytes)`);
  if (item.size > 1_000_000 && item.size / Math.max(item.packed, 1) > MOST_SHRUNK) {
    throw new ToolError("that file unpacks to far more than it should; it wasn't read");
  }
  const name = item.name.split("/").pop() ?? item.name;
  return [name, kindOf(item.name, ""), zip.open(item, MAX_FILE_BYTES)];
}

/** The file `inside` names in this one (a .zip's file), or this one. */
function opened(name: string, mime: string, data: Buffer, inside: string | undefined): [string, string, Buffer] {
  if (!inside) return [name, mime, data];
  const kind = kindOf(name, mime);
  if (kind === ZIP) return fromZip(data, inside);
  if (kind === EML || kind === MSG) throw new ToolError(`'${name}' is an attached email, which can't be opened here.`);
  throw new ToolError(`'${name}' has no files inside it: leave out \`inside\``);
}

function readAny(name: string, mime: string, data: Buffer): Extracted {
  const kind = kindOf(name, mime);
  switch (kind) {
    case WORD:
      return docx(data);
    case EXCEL:
      return xlsx(data);
    case DECK:
      return pptx(data);
    case ZIP:
      return zipListing(data);
    case "text/html":
      return extracted(htmlToText(decoded(data)), "html");
    case PDF:
      throw new ToolError(
        `'${name}' is a PDF, and Ringkeeper Connect can't take text out of PDFs yet. Ask the person for the part you need, or for a Word or text copy.`,
      );
    case EML:
    case MSG:
      throw new ToolError(`'${name}' is an attached email, which can't be opened here. Ask the person to forward it instead.`);
  }
  if (INSTEAD[suffix(name)]) throw cantRead(name, kind);
  if (kind.startsWith("text/") || ["application/json", "application/xml", "application/csv", "image/svg+xml"].includes(kind)) {
    return extracted(decoded(data), "text");
  }
  if (kind.startsWith("image/")) {
    throw new ToolError(`'${name}' is a picture. Reading text in pictures isn't available in Ringkeeper Connect: don't guess at what it says.`);
  }
  throw cantRead(name, kind);
}

/** The text of a file (or of the file `inside` names in it), or a ToolError saying why it can't be read. */
export function extract(name: string, mime: string, content: Buffer, inside?: string): Extracted {
  const [n, m, data] = opened(name, mime, content, inside);
  if (data.length > MAX_FILE_BYTES) throw new ToolError(`'${n}' is too large to read here (${thousands(data.length)} bytes)`);
  const found = readAny(n, m, data);
  if (found.text.length <= MAX_TEXT_CHARS) return found;
  return { ...found, text: found.text.slice(0, MAX_TEXT_CHARS), note: `Only the first ${thousands(MAX_TEXT_CHARS)} characters of this file were taken out.` };
}

// --- How a tool answers with a file's text ---

export const PAGES_PATTERN = "^\\s*\\d{1,4}\\s*(-\\s*\\d{1,4})?\\s*$";
const OUTLINE_NOTE = (first: string, unit: string) =>
  `A long file: this is its outline and its first ${first}. Read the ${unit}s you need with pages= (next_pages comes next) before answering, or say your answer is based on part of it.`;
const MORE_PAGES = "More follows: read on with pages=next_pages, or say your answer is based on part.";
const LONG_NOTE = (shown: number, total: number) =>
  `A long file: this is its first ${thousands(shown)} of ${thousands(total)} characters. Read on from next_offset before answering, or say your answer is based on part of it.`;

function pageRange(pages: string, count: number, unit: string): [number, number] {
  const [first, last] = pages.replace(/\s/g, "").split("-");
  let start = Number(first);
  let end = Number(last || first);
  if (start > end) [start, end] = [end, start];
  if (start > count) throw new ToolError(`it has ${plural(count, unit)}`);
  return [start, Math.min(end, count)];
}

/** The pages to read next: as many as fit in about one outline's worth of text. */
function nextPages(rest: Page[]): string | null {
  if (!rest.length) return null;
  let size = 0;
  let last = rest[0]!.number;
  for (const p of rest) {
    if (size && size + p.text.length > OUTLINE_CHARS) break;
    size += p.text.length;
    last = p.number;
  }
  return last === rest[0]!.number ? `${last}` : `${rest[0]!.number}-${last}`;
}

function outline(found: Extracted): Json {
  const unit = found.unit;
  const numbers = found.pages.map((p) => p.number);
  const worded = found.pages.filter((p) => p.text).map((p) => p.number);
  const shown: Json = { [`${unit}s`]: numbers.length, total_chars: found.text.length };
  shown[`${unit}s_with_text`] = spans(worded) || "none";
  const blank = numbers.filter((n) => !worded.includes(n));
  if (blank.length) shown[`${unit}s_without_text`] = spans(blank);
  const pictured = found.pages.filter((p) => p.pictures).map((p) => p.number);
  if (pictured.length) shown[`${unit}s_with_pictures`] = spans(pictured);
  const titles: Record<string, string> = {};
  for (const p of found.pages.slice(0, 200)) if (p.title) titles[String(p.number)] = p.title;
  if (Object.keys(titles).length) shown.titles = titles;
  return shown;
}

/** A file's text as a tool answers it: whole, a part, its outline first when long, or pages=. */
export function textAnswer(meta: Json, found: Extracted, offset: number, limit: number, pages: string | undefined): Json {
  const answer: Json = { ...meta };
  const unit = found.unit;
  const total = found.pages.length;
  if (pages) {
    if (!found.pages.length) throw new ToolError(`'${meta.name}' has no pages: read on with offset instead`);
    const [start, end] = pageRange(pages, found.pages[found.pages.length - 1]!.number, unit);
    const chosen = found.pages.filter((p) => p.number >= start && p.number <= end);
    Object.assign(answer, page(joined(chosen, unit, total), offset, limit));
    answer[`${unit}s_shown`] = spans(chosen.map((p) => p.number));
    answer[`${unit}s`] = total;
    const following = nextPages(found.pages.filter((p) => p.number > end));
    if (following) Object.assign(answer, { next_pages: following, truncated: true, note: MORE_PAGES });
  } else if (offset === 0 && limit === PAGE_CHARS && found.text.length > OUTLINE_CHARS) {
    if (total > FIRST_PAGES) {
      const first = found.pages.slice(0, FIRST_PAGES);
      answer.outline = outline(found);
      Object.assign(answer, page(joined(first, unit, total), 0, OUTLINE_CHARS));
      Object.assign(answer, {
        [`${unit}s_shown`]: spans(first.map((p) => p.number)),
        next_pages: nextPages(found.pages.slice(FIRST_PAGES)),
        truncated: true,
        note: OUTLINE_NOTE(`${FIRST_PAGES} ${unit}s`, unit),
      });
    } else {
      Object.assign(answer, page(found.text, 0, OUTLINE_CHARS));
      answer.note = LONG_NOTE(OUTLINE_CHARS, found.text.length);
    }
  } else {
    Object.assign(answer, page(found.text, offset, limit));
  }
  if (found.note) answer.read_note = found.note;
  return answer;
}
