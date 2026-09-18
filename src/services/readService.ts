/**
 * Item reading: the shaped records every tool returns.
 *
 * All output is built here so a record looks the same whether it came from a
 * search hit or a direct read, and so `zotero://` links are attached in exactly
 * one place.
 */

import { noteHtmlToMarkdown } from "./noteService";
import { buildItemUris, type ItemUris } from "./uriService";
import type { ZoteroGateway } from "./zoteroGateway";

export type ReadSection =
  | "metadata"
  | "abstract"
  | "children"
  | "attachments"
  | "tags"
  | "notes"
  | "annotations";

export const ALL_SECTIONS: ReadSection[] = [
  "metadata",
  "abstract",
  "children",
  "attachments",
  "tags",
  "notes",
  "annotations",
];

export interface ItemSummary {
  key: string;
  itemType: string;
  title: string;
  creators?: string;
  year?: string;
  uri: ItemUris;
}

export interface AttachmentRecord {
  key: string;
  title: string;
  contentType: string | null;
  filename?: string;
  /** Absolute path on disk, or null when the file is missing or unlinked. */
  path: string | null;
  linkMode?: string;
  uri: ItemUris;
}

export interface AnnotationRecord {
  key: string;
  attachmentKey: string;
  type: string;
  text?: string;
  comment?: string;
  color?: string;
  pageLabel?: string;
  page?: number;
  tags?: string[];
  uri: ItemUris;
}

export interface NoteRecord {
  key: string;
  parentKey?: string;
  title: string;
  text: string;
  markdown: string;
  uri: ItemUris;
}

export interface ItemReadResult {
  key: string;
  itemType: string;
  uri: ItemUris;
  metadata?: Record<string, unknown>;
  abstract?: string | null;
  children?: { attachments: ItemSummary[]; notes: ItemSummary[] };
  attachments?: AttachmentRecord[];
  tags?: string[];
  notes?: NoteRecord[];
  annotations?: AnnotationRecord[];
}

/** Fields dropped from a metadata dump: internal, noisy, or reported elsewhere. */
const METADATA_OMIT = new Set([
  "key",
  "version",
  "itemType",
  "tags",
  "collections",
  "relations",
  "abstractNote",
]);

export class ReadService {
  constructor(private readonly gateway: ZoteroGateway) {}

  public summarize(item: Zotero.Item): ItemSummary {
    const isAttachment = item.isAttachment();
    return {
      key: item.key,
      itemType: item.itemType,
      title: safeField(item, "title") || "(untitled)",
      ...(creatorSummary(item) ? { creators: creatorSummary(item) } : {}),
      ...(safeField(item, "date")
        ? { year: String(safeField(item, "date")).slice(0, 4) }
        : {}),
      uri: buildItemUris({
        key: item.key,
        isAttachment,
        contentType: isAttachment ? item.attachmentContentType : null,
      }),
    };
  }

  public async read(
    item: Zotero.Item,
    sections: ReadSection[],
  ): Promise<ItemReadResult> {
    const wanted = new Set(sections);
    const result: ItemReadResult = {
      key: item.key,
      itemType: item.itemType,
      uri: buildItemUris({
        key: item.key,
        isAttachment: item.isAttachment(),
        contentType: item.isAttachment() ? item.attachmentContentType : null,
      }),
    };

    if (wanted.has("metadata")) result.metadata = this.metadata(item);
    if (wanted.has("abstract")) {
      result.abstract = safeField(item, "abstractNote") || null;
    }
    if (wanted.has("tags")) {
      result.tags = item.getTags().map((tag) => tag.tag);
    }

    const needsAttachments =
      wanted.has("attachments") || wanted.has("annotations");
    const attachments = needsAttachments
      ? await this.gateway.getItemsByID(item.getAttachments())
      : [];

    if (wanted.has("attachments")) {
      result.attachments = await Promise.all(
        attachments.map((attachment) => this.attachmentRecord(attachment)),
      );
    }

    if (wanted.has("children")) {
      const childAttachments = wanted.has("attachments")
        ? attachments
        : await this.gateway.getItemsByID(item.getAttachments());
      const childNotes = isNoteItem(item)
        ? []
        : await this.gateway.getItemsByID(item.getNotes());
      result.children = {
        attachments: childAttachments.map((child) => this.summarize(child)),
        notes: childNotes.map((child) => this.summarize(child)),
      };
    }

    if (wanted.has("notes")) {
      // A note item has no child notes; return the note itself so a caller can
      // read a standalone note by its own key rather than hitting getNotes().
      if (isNoteItem(item)) {
        result.notes = [this.noteRecord(item)];
      } else {
        const notes = await this.gateway.getItemsByID(item.getNotes());
        result.notes = notes.map((note) => this.noteRecord(note, item.key));
      }
    }

    if (wanted.has("annotations")) {
      const records: AnnotationRecord[] = [];
      for (const attachment of attachments) {
        for (const annotation of safeAnnotations(attachment)) {
          records.push(this.annotationRecord(annotation, attachment));
        }
      }
      result.annotations = records;
    }

    return result;
  }

  public metadata(item: Zotero.Item): Record<string, unknown> {
    // Zotero's own JSON is the authority on which fields an item type has, so
    // per-type field lists never need duplicating here.
    const json = item.toJSON() as Record<string, unknown>;
    const metadata: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(json)) {
      if (METADATA_OMIT.has(field)) continue;
      if (value === "" || value === null || value === undefined) continue;
      metadata[field] = value;
    }
    return metadata;
  }

  public async attachmentRecord(
    attachment: Zotero.Item,
  ): Promise<AttachmentRecord> {
    return {
      key: attachment.key,
      title: safeField(attachment, "title") || "(untitled attachment)",
      contentType: attachment.attachmentContentType ?? null,
      ...(attachment.attachmentFilename
        ? { filename: attachment.attachmentFilename }
        : {}),
      path: await this.gateway.getAttachmentPath(attachment),
      ...(typeof attachment.attachmentLinkMode === "number"
        ? { linkMode: linkModeName(attachment.attachmentLinkMode) }
        : {}),
      uri: buildItemUris({
        key: attachment.key,
        isAttachment: true,
        contentType: attachment.attachmentContentType,
      }),
    };
  }

  public noteRecord(note: Zotero.Item, parentKey?: string): NoteRecord {
    const html = safeNote(note);
    return {
      key: note.key,
      ...(parentKey ? { parentKey } : {}),
      title: safeField(note, "title") || firstLine(html) || "(untitled note)",
      text: htmlToText(html),
      markdown: noteHtmlToMarkdown(html),
      uri: buildItemUris({ key: note.key, isAttachment: false }),
    };
  }

  public annotationRecord(
    annotation: Zotero.Item,
    attachment: Zotero.Item,
  ): AnnotationRecord {
    const raw = annotation as unknown as {
      annotationType?: string;
      annotationText?: string;
      annotationComment?: string;
      annotationColor?: string;
      annotationPageLabel?: string;
      annotationPosition?: string;
    };
    const pageIndex = parsePageIndex(raw.annotationPosition);

    return {
      key: annotation.key,
      attachmentKey: attachment.key,
      type: raw.annotationType ?? "unknown",
      ...(raw.annotationText ? { text: raw.annotationText } : {}),
      ...(raw.annotationComment ? { comment: raw.annotationComment } : {}),
      ...(raw.annotationColor ? { color: raw.annotationColor } : {}),
      ...(raw.annotationPageLabel
        ? { pageLabel: raw.annotationPageLabel }
        : {}),
      ...(pageIndex === undefined ? {} : { page: pageIndex + 1 }),
      ...(annotation.getTags().length
        ? { tags: annotation.getTags().map((tag) => tag.tag) }
        : {}),
      // The link opens the attachment at the annotation, not the annotation item.
      uri: buildItemUris({
        key: attachment.key,
        isAttachment: true,
        contentType: attachment.attachmentContentType,
        location: { annotationKey: annotation.key, pageIndex },
      }),
    };
  }
}

function safeField(item: Zotero.Item, field: string): string {
  try {
    return String(item.getField(field as never) ?? "");
  } catch {
    // Asking a type for a field it does not have is normal, not an error.
    return "";
  }
}

function isNoteItem(item: Zotero.Item): boolean {
  return String(item.itemType) === "note" || Boolean(item.isNote?.());
}

function safeNote(item: Zotero.Item): string {
  try {
    return item.getNote() ?? "";
  } catch {
    return "";
  }
}

function safeAnnotations(attachment: Zotero.Item): Zotero.Item[] {
  try {
    return attachment.getAnnotations() ?? [];
  } catch {
    return [];
  }
}

function creatorSummary(item: Zotero.Item): string {
  try {
    const creators = item.getCreators();
    if (!creators?.length) return "";
    const names = creators.map(
      (creator) =>
        (creator as { lastName?: string; name?: string }).lastName ||
        (creator as { name?: string }).name ||
        "",
    );
    const shown = names.filter(Boolean);
    if (!shown.length) return "";
    return shown.length > 3 ? `${shown[0]} et al.` : shown.join(", ");
  } catch {
    return "";
  }
}

function parsePageIndex(position: unknown): number | undefined {
  if (typeof position !== "string" || !position) return undefined;
  try {
    const parsed = JSON.parse(position) as { pageIndex?: number };
    return typeof parsed.pageIndex === "number" ? parsed.pageIndex : undefined;
  } catch {
    return undefined;
  }
}

const LINK_MODES: Record<number, string> = {
  0: "imported_file",
  1: "imported_url",
  2: "linked_file",
  3: "linked_url",
  4: "embedded_image",
};

function linkModeName(mode: number): string {
  return LINK_MODES[mode] ?? String(mode);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstLine(html: string): string {
  return htmlToText(html).split("\n")[0]?.slice(0, 120) ?? "";
}
