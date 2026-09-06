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
