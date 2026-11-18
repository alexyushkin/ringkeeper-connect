// Text the way someone reads it (ported from Ringkeeper's adapters/mail_text.py and
// adapters/paging.py): HTML as plain text that keeps links and tables, a reply's quoted
// chain set apart, and anything long answered in parts that say which part they are.
import type { Json } from "./http.js";

export const PAGE_CHARS = 200_000; // a generous page: most messages and files arrive whole
export const QUOTED_SHOWN = 20_000; // the rest of a long chain is read with include_quoted
export const THREAD_BODY_CHARS = 20_000; // of each message; read_mail has the rest
export const PREVIEW_CHARS = 300;
const PARTIAL_NOTE =
  "This is only part of it. Read from next_offset for the rest before answering, or say your answer is based on part of it.";

/** Python's str.splitlines(): no empty last line for a text that ends with a line break. */
export function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** One part of `text`, saying what part it is. `truncated` is true while more follows. */
export function page(text: string, offset = 0, limit = PAGE_CHARS, field = "text"): Json {
  const part = text.slice(offset, offset + limit);
  const end = offset + part.length;
  const more = end < text.length;
  const answer: Json = {
    [field]: part,
    total_chars: text.length,
    offset,
    returned_chars: part.length,
    truncated: more || offset > 0,
    next_offset: more ? end : null,
  };
  if (more) answer.note = PARTIAL_NOTE;
  return answer;
}

// --- HTML to text ---

const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "center", "dd", "div", "dl", "dt", "fieldset",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav",
  "ol", "p", "pre", "section", "table", "ul",
]);
const HIDDEN = new Set(["head", "script", "style", "title", "template", "noscript"]);
const RAW_TEXT = new Set(["script", "style"]); // their content is never markup

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\xa0", copy: "©", reg: "®",
  trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“",
  rdquo: "”", sbquo: "‚", bdquo: "„", laquo: "«", raquo: "»", bull: "•", middot: "·",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", deg: "°", plusmn: "±",
  times: "×", divide: "÷", frac12: "½", frac14: "¼", frac34: "¾", zwnj: "\u200c", zwj: "\u200d",
  shy: "\xad", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", iexcl: "¡", iquest: "¿",
  dagger: "†", Dagger: "‡", larr: "←", rarr: "→", uarr: "↑", darr: "↓", hearts: "♥", check: "✓",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é",
  egrave: "è", ecirc: "ê", aacute: "á", agrave: "à", acirc: "â", iacute: "í", oacute: "ó",
  uacute: "ú", ntilde: "ñ", ccedil: "ç", Eacute: "É", aring: "å", oslash: "ø", aelig: "æ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(code);
    }
    return ENTITIES[ref] ?? whole;
  });
}

type Attrs = Record<string, string | null>;

class HtmlText {
  out: string[] = [];
  hidden = 0;
  link: string | null = null;
  linkText = "";
  quote = 0;
  cells = 0;
  pre = 0;

  private line() {
    this.out.push("\n");
  }

  start(tag: string, attrs: Attrs) {
    if (HIDDEN.has(tag)) this.hidden += 1;
    if (this.hidden) return;
    if (tag === "blockquote") this.quote += 1;
    if (BLOCKS.has(tag) || tag === "br" || tag === "tr") this.line();
    switch (tag) {
      case "tr":
        this.cells = 0;
        break;
      case "td":
      case "th":
        if (this.cells) this.out.push(" | ");
        this.cells += 1;
        break;
      case "li":
        this.line();
        this.out.push("- ");
        break;
      case "a":
        this.link = attrs.href || null;
        this.linkText = "";
        break;
      case "img": {
        const alt = (attrs.alt ?? "").trim();
        if (alt) this.out.push(`[${alt}]`);
        break;
      }
      case "pre":
        this.pre += 1;
        break;
    }
  }

  end(tag: string) {
    if (HIDDEN.has(tag)) {
      this.hidden = Math.max(this.hidden - 1, 0);
      return;
    }
    if (this.hidden) return;
    if (tag === "a" && this.link) {
      const shown = this.linkText.trim();
      const lower = this.link.toLowerCase();
      const target = lower.startsWith("mailto:") ? this.link.slice(7) : this.link;
      if ((lower.startsWith("http:") || lower.startsWith("https:") || lower.startsWith("mailto:")) && !shown.includes(target)) {
        this.out.push(` (${this.link})`);
      }
      this.link = null;
    }
    if (tag === "pre") this.pre = Math.max(this.pre - 1, 0);
    if (tag === "blockquote") this.quote = Math.max(this.quote - 1, 0);
    if (BLOCKS.has(tag)) this.line();
  }

  data(raw: string) {
    if (this.hidden || !raw) return;
    let text = this.pre ? raw : raw.replace(/\s+/g, " ");
    if (this.link !== null) this.linkText += text;
    if (this.quote && text.trim()) {
      const mark = "> ".repeat(this.quote);
      text = splitlines(text).map((l) => mark + l).join("\n");
    }
    this.out.push(text);
  }
}

function parseAttrs(source: string): Attrs {
  const attrs: Attrs = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of source.matchAll(re)) {
    const name = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4];
    if (!(name in attrs)) attrs[name] = value === undefined ? null : decodeEntities(value);
  }
  return attrs;
}

/** Readable text from an email's HTML, keeping links and tables. */
export function htmlToText(html: string): string {
  const p = new HtmlText();
  let i = 0;
  let text = "";
  const flush = () => {
    if (text) p.data(decodeEntities(text));
    text = "";
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    i = lt;
    if (html.startsWith("<!--", i)) {
      flush();
      const close = html.indexOf("-->", i + 4);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      flush();
      const close = html.indexOf(">", i);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    const endTag = /^<\/([A-Za-z][^\s\/>]*)[^>]*>/.exec(html.slice(i, i + 500));
    if (endTag) {
      flush();
      p.end(endTag[1]!.toLowerCase());
      i += endTag[0].length;
      continue;
    }
    const startTag = /^<([A-Za-z][^\s\/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(html.slice(i, i + 20_000));
    if (!startTag) {
      text += "<";
      i += 1;
      continue;
    }
    flush();
    const tag = startTag[1]!.toLowerCase();
    const rest = startTag[2] ?? "";
    const selfClosing = /\/\s*$/.test(rest);
    p.start(tag, parseAttrs(selfClosing ? rest.replace(/\/\s*$/, "") : rest));
    i += startTag[0].length;
    if (selfClosing) {
      p.end(tag);
    } else if (RAW_TEXT.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      const stop = close < 0 ? html.length : close;
      p.data(html.slice(i, stop));
      i = stop;
    }
  }
  flush();
  const lines = splitlines(p.out.join("")).map((l) => l.replace(/[ \t]+$/, ""));
  const joined = lines.map((l) => (l.startsWith("  ") ? l : l.replace(/^ +/, ""))).join("\n");
  return joined.replace(/\n{3,}/g, "\n\n").trim();
}

/** The plain version, unless it's a stub ("view this in your browser") of the HTML one. */
export function bestText(plain: string, html: string): string {
  const readable = html ? htmlToText(html) : "";
  return readable.length > 2 * plain.trim().length ? readable : plain.trim();
}

// --- What a reply quotes ---

const REPLY_HEADER =
  /^\s*(?:>\s*)?(?:On\s.{1,200}\swrote:|Am\s.{1,200}\sschrieb.{0,30}:|Le\s.{1,200}\sa\s[ée]crit\s?:|El\s.{1,200}\sescribi[óo]:|-{2,}\s*Original Message\s*-{2,})\s*$/i;
const FORWARD = /^\s*(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)\s*$/i;
const OUTLOOK_FROM = /^\s*\*?(?:From|De|Von):\*?\s+\S/i;
const OUTLOOK_NEXT = /^\s*\*?(?:Sent|Date|Envoy[ée]|Gesendet|Enviado):\*?\s+\S/i;

/** The first line of an earlier message: "On ... wrote:" or an Outlook header block. */
function chainStart(lines: string[]): number | null {
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (FORWARD.test(line)) return null;
    if (REPLY_HEADER.test(line)) return n;
    const following = lines[n + 1] ?? "";
    if (line.trimStart().startsWith("________") && OUTLOOK_FROM.test(following)) return n;
    if (OUTLOOK_FROM.test(line) && lines.slice(n + 1, n + 4).some((l) => OUTLOOK_NEXT.test(l))) return n;
  }
  return null;
}

/** (what's new, what it quotes). Only a chain at the end moves; a message that's nothing but a chain stays as it is. */
export function splitQuoted(text: string): [string, string] {
  const lines = splitlines(text);
  let cut = chainStart(lines);
  if (cut === null) {
    cut = lines.length;
    while (cut > 0 && (!lines[cut - 1]!.trim() || lines[cut - 1]!.trimStart().startsWith(">"))) cut -= 1;
  }
  const fresh = lines.slice(0, cut).join("\n").trim();
  const quoted = lines.slice(cut).join("\n").trim();
  return fresh ? [fresh, quoted] : [text.trim(), ""];
}

/** The start of a message's own text, on one line, for a list of messages. */
export function preview(text: string, chars = PREVIEW_CHARS): string {
  const [fresh] = splitQuoted(text);
  const flat = fresh.split(/\s+/).filter(Boolean).join(" ");
  return flat.length <= chars ? flat : `${flat.slice(0, chars - 1).trimEnd()}…`;
}

/** Some of a conversation's messages, oldest first, saying which. */
export function threadPage(ordered: Json[], offset: number, limit: number): Json {
  const chosen = ordered.slice(offset, offset + limit);
  const end = offset + chosen.length;
  const more = end < ordered.length;
  const answer: Json = {
    messages: chosen,
    total_messages: ordered.length,
    offset,
    returned_messages: chosen.length,
    truncated: more || offset > 0,
    next_offset: more ? end : null,
  };
  if (more) answer.note = "More messages follow. Read from next_offset before answering.";
  return answer;
}

/** A message's body as a tool answers it: the part asked for, and the quoted chain apart unless asked for. */
export function bodyFields(text: string, offset = 0, limit = PAGE_CHARS, includeQuoted = false): Json {
  if (includeQuoted) return page(text.trim(), offset, limit, "body");
  const [fresh, quoted] = splitQuoted(text);
  const answer = page(fresh, offset, limit, "body");
  if (quoted) {
    Object.assign(answer, {
      quoted: quoted.slice(0, QUOTED_SHOWN),
      quoted_chars: quoted.length,
      quoted_truncated: quoted.length > QUOTED_SHOWN,
    });
  }
  return answer;
}
