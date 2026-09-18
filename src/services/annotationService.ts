/**
 * Annotation writing.
 *
 * Zotero renders a highlight from `position.rects`, so a highlight cannot be
 * created from text alone unless rects can be derived. SDT packs do carry glyph
 * geometry, but the shipped read module exports no decoder for it — only text —
 * so character-precise rects would mean reimplementing an undocumented packed
 * format, with silently misplaced highlights as the failure mode.
 *
 * The compromise, reported in every result rather than hidden: text-located
 * highlights cover the *containing block* (paragraph), and callers who need
 * exact geometry pass rects themselves. A wrong-position highlight is worse than
 * a coarse one, and a coarse one that says so is honest.
 */

import { InvalidArgumentError, TextNotFoundError } from "../errors";
import {
  blockText,
  collectTextLeaves,
  EPUB_CONTENT_TYPE,
  firstPageIndex,
  PDF_CONTENT_TYPE,
} from "./documentTextService";
import { EpubCfiService } from "./epubCfiService";
import { rectsForText, type TextLeaf } from "./pdfTextMap";
import { UNDO_ACTIONS, undoLabel } from "./undo";
import { buildItemUris, type UriLocation } from "./uriService";
import type { ItemResolver } from "./itemResolver";
import type { SdtNode, ZoteroGateway } from "./zoteroGateway";

export type AnnotationGranularity = "exact" | "block";

export interface CreatedAnnotation {
  key: string;
  type: string;
  page?: number;
  granularity: AnnotationGranularity;
  uri: ReturnType<typeof buildItemUris>;
  note?: string;
}

export interface HighlightFromTextInput {
  text: string;
  comment?: string;
  color?: string;
  tags?: string[];
}

export interface RectInput {
  page: number;
  rects: number[][];
  text?: string;
  comment?: string;
  color?: string;
  tags?: string[];
}

/** Zotero's palette; an arbitrary hex is accepted too. */
const DEFAULT_COLOR = "#ffd400";

export class AnnotationService {
  constructor(
    private readonly gateway: ZoteroGateway,
    private readonly resolver: ItemResolver,
    private readonly epubCfi: EpubCfiService = new EpubCfiService(gateway),
  ) {}

  /**
   * Locates `text` in the document and highlights it. A PDF highlight covers the
   * containing block, since Zotero's structured text carries no character-level
   * geometry; an EPUB highlight is character-exact, built from a CFI. Refuses
   * rather than guessing when the text is absent or ambiguous.
   */
  public async highlightText(
    attachment: Zotero.Item,
    input: HighlightFromTextInput,
  ): Promise<CreatedAnnotation> {
    this.assertHighlightable(attachment);

    const needle = (input.text ?? "").trim();
    if (needle.length < 4) {
      throw new InvalidArgumentError(
        "Provide at least four characters of the text to highlight; a shorter " +
          "string matches too much of the document to place reliably.",
      );
    }

    if (attachment.attachmentContentType === EPUB_CONTENT_TYPE) {
      return this.highlightEpubText(attachment, needle, input);
    }

    const reader = await this.gateway.getSdtReader(attachment.id);
    if (!reader) {
      throw new InvalidArgumentError(
        `No structured text is available for attachment "${attachment.key}", so ` +
          `text cannot be located. Pass a page and rects instead.`,
      );
    }

    const total = reader.getTopLevelBlockCount();
    const blocks = total > 0 ? await reader.getBlocks(0, total - 1) : [];

    const matches: { block: SdtNode; index: number }[] = [];
    const normalizedNeedle = normalize(needle);
    for (const [index, block] of blocks.entries()) {
      if (normalize(blockText(block)).includes(normalizedNeedle)) {
        matches.push({ block, index });
      }
    }

    if (!matches.length) {
      throw new TextNotFoundError(attachment.key, needle);
    }
    if (matches.length > 1) {
      throw new InvalidArgumentError(
        `The text appears in ${matches.length} places in attachment ` +
          `"${attachment.key}". Quote a longer, unique passage, or pass a page ` +
          `and rects.`,
      );
    }

    const { block } = matches[0];

    // Prefer a character-exact highlight built from the leaves' glyph geometry;
    // fall back to the block rectangle when the quote is not present verbatim
    // (e.g. whitespace differs) or the pack carries no textMap.
    const leaves = collectTextLeaves(block) as TextLeaf[];
    const exact = rectsForText(leaves, needle);
    if (exact) {
      return this.savePdf(attachment, {
        type: "highlight",
        pageIndex: exact.pageIndex,
        rects: exact.rects,
        text: needle,
        comment: input.comment,
        color: input.color,
        tags: input.tags,
        granularity: "exact",
      });
    }

    const pageRects = block.anchor?.pageRects ?? [];
    if (!pageRects.length) {
      throw new InvalidArgumentError(
        "The matching text has no page geometry, so a highlight cannot be " +
          "positioned. Pass a page and rects instead.",
      );
    }

    const pageIndex = firstPageIndex(block);
    if (pageIndex === undefined) {
      throw new InvalidArgumentError(
        "The matching text has no page index, so a highlight cannot be " +
          "positioned. Pass a page and rects instead.",
      );
    }

    // One block can span pages; keep only the rects on the page it starts on, so
    // the annotation's position stays single-page as Zotero expects.
    const rects = pageRects
      .filter((rect) => rect[0] === pageIndex)
      .map((rect) => rect.slice(1));

    return this.savePdf(attachment, {
      type: "highlight",
      pageIndex,
      rects,
      text: blockText(block).trim(),
      comment: input.comment,
      color: input.color,
      tags: input.tags,
      granularity: "block",
      note:
        "The highlight covers the paragraph containing the quoted text, " +
        "because the exact quote could not be matched to glyph geometry " +
        "(often a whitespace difference). Quote the text verbatim, or pass " +
        "page and rects, for a character-exact highlight.",
    });
  }

  /**
   * Highlights the exact quoted text in an EPUB via a CFI range. EPUBs have no
   * page geometry, so this is the only way to place a highlight — and unlike the
   * PDF path it is character-exact.
   */
  private async highlightEpubText(
    attachment: Zotero.Item,
    needle: string,
    input: HighlightFromTextInput,
  ): Promise<CreatedAnnotation> {
    const matches = await this.epubCfi.locate(attachment, needle);

    if (!matches.length) {
      throw new TextNotFoundError(attachment.key, needle);
    }
    if (matches.length > 1) {
      throw new InvalidArgumentError(
        `The text appears in ${matches.length} places in attachment ` +
          `"${attachment.key}". Quote a longer, unique passage.`,
      );
    }

    const match = matches[0];
    return this.persist(attachment, {
      type: "highlight",
      text: match.matchedText,
      comment: input.comment,
      color: input.color,
      tags: input.tags,
      granularity: "exact",
      position: {
        type: "FragmentSelector",
        conformsTo: "http://www.idpf.org/epub/linking/cfi/epub-cfi.html",
        value: match.rangeCfi,
      },
      sortIndex: match.sortIndex,
      pageLabel: "",
      uriLocation: {},
    });
  }

  /** Highlight from caller-supplied PDF user-space rects. */
  public async highlightRects(
    attachment: Zotero.Item,
    input: RectInput,
  ): Promise<CreatedAnnotation> {
    this.assertHighlightable(attachment);
    const { pageIndex, rects } = normalizeRectInput(input);

    return this.savePdf(attachment, {
      type: "highlight",
      pageIndex,
      rects,
      text: input.text ?? "",
      comment: input.comment,
      color: input.color,
      tags: input.tags,
      granularity: "exact",
    });
  }

  /** Area annotation: an image region of a page. */
  public async area(
    attachment: Zotero.Item,
    input: RectInput,
  ): Promise<CreatedAnnotation> {
    if (attachment.attachmentContentType !== PDF_CONTENT_TYPE) {
      throw new InvalidArgumentError(
        `Area annotations require a PDF attachment; "${attachment.key}" is ` +
          `"${attachment.attachmentContentType ?? "unknown"}".`,
      );
    }

    const { pageIndex, rects } = normalizeRectInput(input);
    if (rects.length !== 1) {
      throw new InvalidArgumentError(
        `An area annotation takes exactly one rectangle, got ${rects.length}.`,
      );
    }

    return this.savePdf(attachment, {
      type: "image",
      pageIndex,
      rects,
      comment: input.comment,
      color: input.color,
      tags: input.tags,
      granularity: "exact",
    });
  }

  public async update(
    annotationKey: unknown,
    changes: { comment?: string; color?: string; tags?: string[] },
  ): Promise<{ key: string; changed: string[] }> {
    const annotation = await this.resolveAnnotation(annotationKey);
    const target = annotation as unknown as Record<string, unknown> & {
      setTags(tags: { tag: string }[]): void;
    };

    const changed: string[] = [];
    if (changes.comment !== undefined) {
      target.annotationComment = changes.comment;
      changed.push("comment");
    }
    if (changes.color !== undefined) {
      target.annotationColor = changes.color;
      changed.push("color");
    }
    if (changes.tags !== undefined) {
      target.setTags(changes.tags.map((tag) => ({ tag })));
      changed.push("tags");
    }

    if (!changed.length) {
      throw new InvalidArgumentError(
        "Nothing to update: provide a comment, color or tags.",
      );
    }

    await this.gateway.saveItem(
      annotation,
      undoLabel(UNDO_ACTIONS.editAnnotation),
    );
    return { key: annotation.key, changed };
  }

  public async remove(annotationKey: unknown): Promise<{ key: string }> {
    const annotation = await this.resolveAnnotation(annotationKey);
    await this.gateway.trashItem(annotation, undoLabel(UNDO_ACTIONS.trash));
    return { key: annotation.key };
  }

  private async resolveAnnotation(key: unknown): Promise<Zotero.Item> {
    const item = await this.resolver.resolveItem(key);
    if (String(item.itemType) !== "annotation") {
      throw new InvalidArgumentError(
        `Item "${item.key}" is not an annotation (item type "${item.itemType}").`,
      );
    }
    return item;
  }

  private assertHighlightable(attachment: Zotero.Item): void {
    const contentType = attachment.attachmentContentType;
    if (contentType !== PDF_CONTENT_TYPE && contentType !== EPUB_CONTENT_TYPE) {
      throw new InvalidArgumentError(
        `Highlights require a PDF or EPUB attachment; "${attachment.key}" is ` +
          `"${contentType ?? "unknown"}".`,
      );
    }
  }

  private async savePdf(
    attachment: Zotero.Item,
    input: {
      type: string;
      pageIndex: number;
      rects: number[][];
      text?: string;
      comment?: string;
      color?: string;
      tags?: string[];
      granularity: AnnotationGranularity;
      note?: string;
    },
  ): Promise<CreatedAnnotation> {
    return this.persist(attachment, {
      type: input.type,
      text: input.text,
      comment: input.comment,
      color: input.color,
      tags: input.tags,
      granularity: input.granularity,
      note: input.note,
      position: { pageIndex: input.pageIndex, rects: input.rects },
      sortIndex: buildSortIndex(input.pageIndex, input.rects),
      pageLabel: String(input.pageIndex + 1),
      uriLocation: { pageIndex: input.pageIndex },
      page: input.pageIndex + 1,
    });
  }

  private async persist(
    attachment: Zotero.Item,
    input: {
      type: string;
      text?: string;
      comment?: string;
      color?: string;
      tags?: string[];
      granularity: AnnotationGranularity;
      note?: string;
      position: Record<string, unknown>;
      sortIndex: string;
      pageLabel: string;
      uriLocation: UriLocation;
      page?: number;
    },
  ): Promise<CreatedAnnotation> {
    const key = this.gateway.generateObjectKey();

    const saved = await this.gateway.saveAnnotation(
      attachment,
      {
        key,
        type: input.type,
        ...(input.text === undefined ? {} : { text: input.text }),
        comment: input.comment ?? "",
        color: input.color ?? DEFAULT_COLOR,
        pageLabel: input.pageLabel,
        sortIndex: input.sortIndex,
        position: input.position,
        tags: (input.tags ?? []).map((tag) => ({ name: tag })),
      },
      // Creating an object is not undoable in Zotero, so no undo label is
      // claimed here; the result says so instead.
      {},
    );

    return {
      key: (saved.key as string) ?? key,
      type: input.type,
      ...(input.page === undefined ? {} : { page: input.page }),
      granularity: input.granularity,
      uri: buildItemUris({
        key: attachment.key,
        isAttachment: true,
        contentType: attachment.attachmentContentType,
        location: { ...input.uriLocation, annotationKey: key },
      }),
      ...(input.note ? { note: input.note } : {}),
    };
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeRectInput(input: RectInput): {
  pageIndex: number;
  rects: number[][];
} {
  const page = Number(input.page);
  if (!Number.isInteger(page) || page < 1) {
    throw new InvalidArgumentError(
      `Invalid page ${JSON.stringify(input.page)}: expected a 1-based page number.`,
    );
  }

  if (!Array.isArray(input.rects) || !input.rects.length) {
    throw new InvalidArgumentError(
      "Provide at least one rectangle as [x1, y1, x2, y2] in PDF user space " +
        "(origin bottom-left, points).",
    );
  }

  const rects = input.rects.map((rect) => {
    if (
      !Array.isArray(rect) ||
      rect.length !== 4 ||
      rect.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new InvalidArgumentError(
        `Invalid rectangle ${JSON.stringify(rect)}: expected four finite ` +
          `numbers [x1, y1, x2, y2].`,
      );
    }
    return rect;
  });

  return { pageIndex: page - 1, rects };
}

/**
 * Zotero orders the annotation sidebar by a `pageIndex|offset|top` string, each
 * part zero-padded. `top` is measured from the page top, which needs the page
 * height; without it the rect's own y is a stable enough proxy for ordering.
 */
export function buildSortIndex(pageIndex: number, rects: number[][]): string {
  const top = rects.length ? Math.max(0, Math.floor(rects[0][3])) : 0;
  return [
    String(pageIndex).slice(0, 5).padStart(5, "0"),
    "000000",
    String(top).slice(0, 5).padStart(5, "0"),
  ].join("|");
}
