/**
 * Notes. Markdown in, Zotero note HTML out.
 *
 * Zotero stores a note as an HTML string and derives the note's displayed title
 * from its first line, so the converted HTML must lead with the content rather
 * than a wrapper.
 */

import { marked } from "marked";
import { InvalidArgumentError } from "../errors";
import { htmlToText } from "./readService";
import { UNDO_ACTIONS, undoLabel } from "./undo";
import { buildItemUris } from "./uriService";
import type { ItemResolver } from "./itemResolver";
import type { ZoteroGateway } from "./zoteroGateway";

export interface NoteWriteResult {
  key: string;
  parentKey?: string;
  action: "create" | "update" | "append";
  title: string;
  chars: number;
  uri: ReturnType<typeof buildItemUris>;
  note?: string;
}

export function markdownToNoteHtml(markdown: string): string {
  const html = marked.parse(markdown, {
    async: false,
    gfm: true,
    breaks: false,
  }) as string;
  return html.trim();
}

/**
 * Zotero note HTML back to Markdown, the rough inverse of markdownToNoteHtml.
 *
 * A note is stored as HTML, so reading one back as the Markdown a caller would
 * edit means undoing the common block and inline structure marked emits:
 * headings, lists (nested included), blockquotes, code, tables and inline
 * emphasis. The conversion is best-effort for the note subset, not a general
 * HTML converter, and it runs on plain strings so it stays testable off-DOM.
 */
export function noteHtmlToMarkdown(html: string): string {
  if (typeof html !== "string" || !html.trim()) return "";

  // Zotero wraps editor notes in <div data-schema-version>…</div>; drop it.
  let s = html.trim();
  s = s.replace(/^<div\b[^>]*>/i, "").replace(/<\/div>\s*$/i, "");

  // Fenced code is protected before any other rewrite touches its contents.
  const codeBlocks: string[] = [];
  s = s.replace(
    /<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_m, code: string) => {
      const text = decodeEntities(stripTags(code)).replace(/\n+$/, "");
      codeBlocks.push("```\n" + text + "\n```");
      return `\uE000C${codeBlocks.length - 1}\uE000`;
    },
  );

  s = s.replace(
    /<table\b[^>]*>([\s\S]*?)<\/table>/gi,
    (_m, body: string) => "\n" + tableToMarkdown(body) + "\n",
  );

  s = s.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_m, level: string, inner: string) =>
      `\n${"#".repeat(Number(level))} ${inlineToMarkdown(inner).trim()}\n`,
  );

  s = s.replace(/<hr\b[^>]*\/?>/gi, "\n---\n");

  s = s.replace(
    /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_m, inner: string) => {
      const text = noteHtmlToMarkdown(inner).trim();
      const quoted = text
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
      return `\n${quoted}\n`;
    },
  );

  s = listsToMarkdown(s, 0);

  s = s.replace(
    /<p\b[^>]*>([\s\S]*?)<\/p>/gi,
    (_m, inner: string) => `\n${inlineToMarkdown(inner).trim()}\n`,
  );

  s = inlineToMarkdown(s);
  s = s.replace(
    /\uE000C(\d+)\uE000/g,
    (_m, i: string) => `\n${codeBlocks[Number(i)]}\n`,
  );

  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Convert top-level <ul>/<ol> in `html`, recursing into nested lists. */
function listsToMarkdown(html: string, depth: number): string {
  let out = "";
  let cursor = 0;

  while (cursor < html.length) {
    const open = /<(ul|ol)\b[^>]*>/i.exec(html.slice(cursor));
    if (!open) {
      out += html.slice(cursor);
      break;
    }

    const openAt = cursor + open.index;
    out += html.slice(cursor, openAt);

    const tag = open[1].toLowerCase();
    const contentStart = openAt + open[0].length;
    const closeAt = findMatchingClose(html, contentStart, tag);
    if (closeAt === -1) {
      out += html.slice(openAt);
      break;
    }

    const body = html.slice(contentStart, closeAt);
    out += "\n" + renderList(tag, body, depth) + "\n";
    cursor = closeAt + `</${tag}>`.length;
  }

  return out;
}

/** Index of the tag's matching close, honouring same-tag nesting, or -1. */
function findMatchingClose(html: string, from: number, tag: string): number {
  const token = new RegExp(`<(/?)(${tag})\\b[^>]*>`, "gi");
  token.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html))) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

function renderList(tag: string, body: string, depth: number): string {
  const ordered = tag === "ol";
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let index = 0;

  for (const item of listItems(body)) {
    index += 1;
    const marker = ordered ? `${index}. ` : "- ";
    const split = /<(ul|ol)\b[^>]*>/i.exec(item);
    const ownHtml = split ? item.slice(0, split.index) : item;
    const nestedHtml = split ? item.slice(split.index) : "";
    const own = inlineToMarkdown(ownHtml).trim();
    const nested = nestedHtml
      ? listsToMarkdown(nestedHtml, depth + 1).replace(/^\n+|\n+$/g, "")
      : "";
    lines.push(`${indent}${marker}${own}`);
    if (nested) lines.push(nested);
  }

  return lines.join("\n");
}

/** Split an <li> list body into item bodies, honouring nested lists. */
function listItems(body: string): string[] {
  const items: string[] = [];
  const open = /<li\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = open.exec(body))) {
    const start = match.index + match[0].length;
    const close = findMatchingClose(body, start, "li");
    const end = close === -1 ? body.length : close;
    items.push(body.slice(start, end));
    open.lastIndex = close === -1 ? body.length : end + "</li>".length;
  }
  return items;
}

function tableToMarkdown(body: string): string {
  const rows: string[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(body))) {
    const cells: string[] = [];
    const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cell: RegExpExecArray | null;
    while ((cell = cellRe.exec(row[1]))) {
      cells.push(inlineToMarkdown(cell[1]).trim().replace(/\|/g, "\\|"));
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return "";

  const [header, ...rest] = rows;
  const divider = header.map(() => "---");
  return [header, divider, ...rest]
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n");
}

/** Inline HTML to Markdown: emphasis, code, links, images and line breaks. */
function inlineToMarkdown(html: string): string {
  return decodeEntities(
    html
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
      .replace(
        /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
        (_m, href: string, text: string) => `[${text}](${href})`,
      )
      .replace(/<img\b[^>]*>/gi, imageToMarkdown)
      .replace(/<[^>]+>/g, ""),
  );
}

/**
 * An <img> to Markdown. Zotero embeds a note image as an attachment and refers
 * to it by data-attachment-key; that key is turned into a select link so the
 * bytes stay reachable through image_read (source 'attachment'). A plain src is
 * kept as-is. The alt text, if any, becomes the image label.
 */
function imageToMarkdown(tag: string): string {
  const alt = /\balt="([^"]*)"/i.exec(tag)?.[1] ?? "";
  const attachmentKey = /\bdata-attachment-key="([^"]+)"/i.exec(tag)?.[1];
  const src = /\bsrc="([^"]+)"/i.exec(tag)?.[1];
  const target = attachmentKey
    ? `zotero://select/library/items/${attachmentKey}`
    : (src ?? "");
  return `![${alt}](${target})`;
}

/** Strip tags; when `keep` is given, remove only text outside those elements. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export class NoteService {
  constructor(
    private readonly gateway: ZoteroGateway,
    private readonly resolver: ItemResolver,
  ) {}

  public async create(
    markdown: unknown,
    parentItemKey?: unknown,
  ): Promise<NoteWriteResult> {
    const html = this.render(markdown);
    const parent =
      parentItemKey === undefined || parentItemKey === null
        ? null
        : await this.resolver.resolveItem(parentItemKey);

    if (
      parent &&
      (parent.isAttachment() || String(parent.itemType) === "note")
    ) {
      throw new InvalidArgumentError(
        `A note cannot be attached to "${parent.key}" (item type ` +
          `"${parent.itemType}"). Attach it to a regular item, or omit the ` +
          `parent for a standalone note.`,
      );
    }

    const note = await this.gateway.createNote(html, parent);

    return {
      key: note.key,
      ...(parent ? { parentKey: parent.key } : {}),
      action: "create",
      title: firstLine(html),
      chars: html.length,
      uri: buildItemUris({ key: note.key, isAttachment: false }),
      note: "Creating an item is not undoable in Zotero; trash it if unwanted.",
    };
  }

  public async update(
    noteKey: unknown,
    markdown: unknown,
  ): Promise<NoteWriteResult> {
    const note = await this.resolveNote(noteKey);
    const html = this.render(markdown);

    (note as unknown as { setNote(html: string): void }).setNote(html);
    await this.gateway.saveItem(note, undoLabel(UNDO_ACTIONS.editNote));

    return this.result(note, "update", html);
  }

  public async append(
    noteKey: unknown,
    markdown: unknown,
  ): Promise<NoteWriteResult> {
    const note = await this.resolveNote(noteKey);
    const addition = this.render(markdown);
    const existing = safeNote(note);

    const combined = existing ? `${existing}\n${addition}` : addition;
    (note as unknown as { setNote(html: string): void }).setNote(combined);
    await this.gateway.saveItem(note, undoLabel(UNDO_ACTIONS.editNote));

    return this.result(note, "append", combined);
  }

  private result(
    note: Zotero.Item,
    action: "update" | "append",
    html: string,
  ): NoteWriteResult {
    return {
      key: note.key,
      ...(typeof note.parentKey === "string"
        ? { parentKey: note.parentKey }
        : {}),
      action,
      title: firstLine(html),
      chars: html.length,
      uri: buildItemUris({ key: note.key, isAttachment: false }),
    };
  }

  private render(markdown: unknown): string {
    if (typeof markdown !== "string" || !markdown.trim()) {
      throw new InvalidArgumentError(
        '"content" must be a non-empty Markdown string.',
      );
    }
    return markdownToNoteHtml(markdown);
  }

  private async resolveNote(key: unknown): Promise<Zotero.Item> {
    const item = await this.resolver.resolveItem(key);
    if (String(item.itemType) !== "note") {
      throw new InvalidArgumentError(
        `Item "${item.key}" is not a note (item type "${item.itemType}").`,
      );
    }
    return item;
  }
}

function safeNote(item: Zotero.Item): string {
  try {
    return item.getNote() ?? "";
  } catch {
    return "";
  }
}

function firstLine(html: string): string {
  return htmlToText(html).split("\n")[0]?.slice(0, 120) || "(untitled note)";
}
