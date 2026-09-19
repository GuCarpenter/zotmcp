/**
 * Reader inspection service.
 *
 * Exposes the currently active reader in Zotero (PDF, EPUB or snapshot),
 * its current page or location, active text or annotation selection,
 * and surrounding text context.
 */

import { InvalidArgumentError, NotFoundError } from "../errors";
import {
  blocksToText,
  EPUB_CONTENT_TYPE,
  firstPageIndex,
  flattenOutline,
  pageBlockResolver,
  preferAuthoredOutline,
} from "./documentTextService";
import type { ItemResolver } from "./itemResolver";
import { buildItemUris } from "./uriService";
import type {
  ReaderNavLocation,
  SdtNode,
  ZoteroGateway,
} from "./zoteroGateway";

export interface ReaderOptions {
  /** Optional 8-character attachment key to inspect a specific reader. */
  attachmentKey?: string;
  /** Whether to include surrounding text context for the selection or location. Default true. */
  includeContext?: boolean;
  /** Maximum characters of surrounding context to return. Default 600. */
  contextChars?: number;
}

export interface ReaderNavigateOptions {
  /** 8-character attachment key to open or navigate. Required. */
  attachmentKey: unknown;
  /** 1-based page number (PDF). */
  page?: unknown;
  /** Physical page label to navigate to (PDF), e.g. "iv" or "12". */
  pageLabel?: unknown;
  /** Annotation key to scroll to and select; its page is resolved for PDFs. */
  annotationKey?: unknown;
  /** EPUB CFI, e.g. `epubcfi(/6/12!/4/2/26/1:17)`. */
  cfi?: unknown;
  /** Open without selecting the tab or stealing focus. Default false. */
  openInBackground?: unknown;
  /** Open in a standalone reader window instead of a tab. Default false. */
  openInWindow?: unknown;
  /** Whether the returned reader state includes surrounding context. Default false. */
  includeContext?: boolean;
  /** Maximum characters of surrounding context to return. Default 600. */
  contextChars?: number;
}

export interface ReaderNavigateResult {
  navigated: true;
  target: {
    attachmentKey: string;
    page?: number;
    pageLabel?: string;
    annotationKey?: string;
    cfi?: string;
  };
  reader: ReaderResult;
}

export interface ReaderLocationInfo {
  pageIndex?: number;
  pageNumber?: number;
  pageLabel?: string;
  totalPages?: number;
  cfi?: string;
  scrollYPercent?: number;
  scrollXPercent?: number;
  scale?: string | number;
  top?: number;
  left?: number;
  scrollMode?: number;
  spreadMode?: number;
}

export interface ReaderSelectionInfo {
  type: "text" | "annotation";
  text: string;
  pageIndex?: number;
  pageNumber?: number;
  pageLabel?: string;
  position?: Record<string, unknown>;
  annotationKey?: string;
  annotationType?: string;
  comment?: string;
  color?: string;
}

export interface ReaderContextInfo {
  textBefore?: string;
  textAfter?: string;
  paragraph?: string;
  surroundingText?: string;
  section?: {
    title: string;
    level?: number;
  };
  pageTextSnippet?: string;
}

export interface ReaderResultOpen {
  open: true;
  reader: {
    attachmentKey: string;
    attachmentItemID: number;
    title: string;
    type: string;
    parentItemKey?: string;
    parentItemID?: number;
    tabID?: string;
    windowID?: string;
    readOnly?: boolean;
    uri: {
      select: string;
      open?: string;
      openPdf?: string;
    };
  };
  location: ReaderLocationInfo;
  selection: ReaderSelectionInfo | null;
  context: ReaderContextInfo | null;
}

export interface ReaderResultClosed {
  open: false;
  message: string;
  openReaders?: {
    attachmentKey?: string;
    title: string;
    type: string;
  }[];
}

export type ReaderResult = ReaderResultOpen | ReaderResultClosed;

const DEFAULT_CONTEXT_CHARS = 600;
const MAX_CONTEXT_CHARS = 5000;

/** Poll budget for a reader to report a concrete location after open/navigate. */
const READER_SETTLE_ATTEMPTS = 40;
const READER_SETTLE_INTERVAL_MS = 50;

/** What a settled reader must show for a given navigation target. */
interface ReaderSettleExpectation {
  expectedPageIndex?: number;
  expectedPageLabel?: string;
  expectedAnnotationKey?: string;
  expectedAnnotationPageIndex?: number;
  expectingCfi?: boolean;
  baselineCfi?: string;
  baselinePageIndex?: number;
}

export class ReaderService {
  public constructor(
    private readonly gateway: ZoteroGateway,
    private readonly resolver: ItemResolver,
  ) {}

  public async getOpenReader(
    options: ReaderOptions = {},
  ): Promise<ReaderResult> {
    const contextChars = this.normalizeContextChars(options.contextChars);
    const includeContext = options.includeContext !== false;

    let targetAttachmentItem: Zotero.Item | undefined;
    if (options.attachmentKey) {
      targetAttachmentItem = await this.resolver.resolveItem(
        options.attachmentKey,
      );
    }

    const active = this.gateway.getActiveReader(targetAttachmentItem?.id);
    if (!active) {
      if (options.attachmentKey) {
        const allOpen = this.gateway.getOpenReaders();
        const openSummaries = [];
        for (const r of allOpen) {
          const it = this.gateway.getItemByID(r.itemID);
          openSummaries.push({
            attachmentKey: it ? it.key : undefined,
            title: r.title,
            type: r.type,
          });
        }
        return {
          open: false,
          message: `Attachment "${options.attachmentKey}" is not currently open in any reader.`,
          ...(openSummaries.length ? { openReaders: openSummaries } : {}),
        };
      }
      return {
        open: false,
        message: "No reader is currently open in Zotero.",
      };
    }

    const item =
      targetAttachmentItem ?? this.gateway.getItemByID(active.itemID);
    if (!item) {
      return {
        open: false,
        message: `Attachment item ${active.itemID} could not be loaded.`,
      };
    }

    // Scoped strictly to My Library
    this.resolver.assertUserLibraryObject("item", item.key, item.libraryID);

    let parentKey: string | undefined;
    if (item.parentItemID) {
      const parent = this.gateway.getItemByID(item.parentItemID);
      if (parent) parentKey = parent.key;
    }

    const uri = buildItemUris({
      key: item.key,
      isAttachment: true,
      contentType: item.attachmentContentType,
      location: { pageIndex: active.state?.pageIndex },
    });

    const location: ReaderLocationInfo = {
      pageIndex: active.state?.pageIndex,
      pageNumber:
        active.state?.pageIndex !== undefined
          ? active.state.pageIndex + 1
          : undefined,
      pageLabel: active.pageLabel,
      totalPages: active.totalPages,
      cfi: active.state?.cfi,
      scrollYPercent: active.state?.scrollYPercent,
      scrollXPercent: active.state?.scrollXPercent,
      scale: active.state?.scale,
      top: active.state?.top,
      left: active.state?.left,
      scrollMode: active.state?.scrollMode,
      spreadMode: active.state?.spreadMode,
    };

    let selection: ReaderSelectionInfo | null = null;
    if (active.selection && active.selection.text) {
      selection = {
        type: active.selection.type,
        text: active.selection.text,
        position: active.selection.position,
        pageIndex: active.selection.pageIndex,
        pageNumber:
          active.selection.pageIndex !== undefined
            ? active.selection.pageIndex + 1
            : undefined,
        pageLabel: active.selection.pageLabel,
        annotationKey: active.selection.annotationKey,
        annotationType: active.selection.annotationType,
        comment: active.selection.comment,
        color: active.selection.color,
      };
    }

    let context: ReaderContextInfo | null = null;
    if (includeContext) {
      context = await this.extractContext(
        item,
        location,
        selection,
        contextChars,
      );
    }

    return {
      open: true,
      reader: {
        attachmentKey: item.key,
        attachmentItemID: item.id,
        title: active.title || item.getField("title") || "",
        type: active.type,
        parentItemKey: parentKey,
        parentItemID: item.parentItemID || undefined,
        tabID: active.tabID,
        windowID: active.windowID,
        readOnly: active.readOnly,
        uri,
      },
      location,
      selection,
      context,
    };
  }

  /**
   * Opens an attachment in Zotero's reader, or navigates the reader already open
   * for it, to a page, page label, annotation or EPUB CFI. Returns the resulting
   * reader state via {@link getOpenReader}.
   */
  public async navigate(
    options: ReaderNavigateOptions,
  ): Promise<ReaderNavigateResult> {
    const attachment = await this.resolver.resolveAttachment(
      options.attachmentKey,
    );
    // Scoped strictly to My Library, like every other resolved object.
    this.resolver.assertUserLibraryObject(
      "item",
      attachment.key,
      attachment.libraryID,
    );

    const isEpub = attachment.attachmentContentType === EPUB_CONTENT_TYPE;
    const location: ReaderNavLocation = {};
    const target: ReaderNavigateResult["target"] = {
      attachmentKey: attachment.key,
    };

    const page = this.normalizeOptionalPage(options.page);
    const pageLabel =
      typeof options.pageLabel === "string" && options.pageLabel.trim()
        ? options.pageLabel.trim()
        : undefined;
    const annotationKey =
      typeof options.annotationKey === "string" && options.annotationKey
        ? options.annotationKey
        : undefined;
    const cfi =
      typeof options.cfi === "string" && options.cfi.trim()
        ? options.cfi.trim()
        : undefined;

    if (
      page === undefined &&
      pageLabel === undefined &&
      annotationKey === undefined &&
      cfi === undefined
    ) {
      throw new InvalidArgumentError(
        'Pass one of "page", "pageLabel", "annotationKey" or "cfi" to navigate ' +
          "the reader, or open the attachment without a target by omitting them.",
      );
    }

    if (cfi && !isEpub) {
      throw new InvalidArgumentError(
        `"cfi" only applies to EPUB attachments; "${attachment.key}" is ` +
          `${attachment.attachmentContentType ?? "not an EPUB"}.`,
      );
    }
    if (cfi && !/^epubcfi\(.*\)$/.test(cfi)) {
      throw new InvalidArgumentError(
        `"cfi" must be an epubcfi(...) string, got ${JSON.stringify(cfi)}.`,
      );
    }

    if (page !== undefined) {
      location.pageIndex = page - 1;
      target.page = page;
    }
    if (pageLabel !== undefined) {
      location.pageLabel = pageLabel;
      target.pageLabel = pageLabel;
    }
    let annotationPageIndex: number | undefined;
    if (annotationKey !== undefined) {
      annotationPageIndex = await this.assertAnnotationOf(
        attachment,
        annotationKey,
      );
      location.annotationID = annotationKey;
      target.annotationKey = annotationKey;
    }
    if (cfi !== undefined) {
      // Same shape Zotero's own zotero://open handler builds for a CFI.
      location.position = {
        type: "FragmentSelector",
        conformsTo: "http://www.idpf.org/epub/linking/cfi/epub-cfi.html",
        value: cfi,
      };
      target.cfi = cfi;
    }

    // Capture where the reader sat before navigating. An already-open reader
    // reports its previous location immediately, so a "changed from baseline"
    // check avoids reading stale state back after a same-tab navigation.
    const baseline = this.gateway.getActiveReader(attachment.id)?.state;

    await this.gateway.openReader({
      itemID: attachment.id,
      location,
      openInBackground: Boolean(options.openInBackground),
      openInWindow: Boolean(options.openInWindow),
    });

    // Opening or navigating a reader settles asynchronously: pdf.js (or the EPUB
    // view) needs a few frames to lay out and apply the target. Poll briefly so
    // the returned state reflects where the reader actually landed.
    await this.waitForReaderSettled(attachment.id, {
      expectedPageIndex: page !== undefined ? page - 1 : undefined,
      expectedPageLabel: pageLabel,
      expectedAnnotationKey: annotationKey,
      expectedAnnotationPageIndex: annotationPageIndex,
      expectingCfi: cfi !== undefined,
      baselineCfi: baseline?.cfi,
      baselinePageIndex: baseline?.pageIndex,
    });

    const reader = await this.getOpenReader({
      attachmentKey: attachment.key,
      includeContext: options.includeContext === true,
      contextChars: options.contextChars,
    });

    return { navigated: true, target, reader };
  }

  /**
   * Waits, up to a short budget, for a just-opened or just-navigated reader to
   * reach the requested target. The settle test is target-specific:
   * - a page navigation settles once the reported `pageIndex` matches;
   * - an annotation once that annotation becomes the reader's selection;
   * - a CFI (which snaps to a page boundary and so rarely matches verbatim) or a
   *   page label once the location differs from the pre-navigation baseline;
   * - a bare open once any concrete location is reported.
   * Returns as soon as the test passes, or after the timeout so navigation never
   * blocks indefinitely.
   */
  private async waitForReaderSettled(
    attachmentItemID: number,
    expect: ReaderSettleExpectation,
  ): Promise<void> {
    for (let attempt = 0; attempt < READER_SETTLE_ATTEMPTS; attempt++) {
      const active = this.gateway.getActiveReader(attachmentItemID);
      if (active && this.readerReachedTarget(active, expect)) return;
      await new Promise((resolve) =>
        setTimeout(resolve, READER_SETTLE_INTERVAL_MS),
      );
    }
  }

  private readerReachedTarget(
    active: NonNullable<ReturnType<ZoteroGateway["getActiveReader"]>>,
    expect: ReaderSettleExpectation,
  ): boolean {
    const state = active.state;

    if (expect.expectedAnnotationKey !== undefined) {
      const selected =
        active.selection?.annotationKey === expect.expectedAnnotationKey;
      if (!selected) return false;
      // Selection registers before the viewport finishes scrolling, so also
      // wait for the annotation's own page when we know it (PDF).
      if (expect.expectedAnnotationPageIndex !== undefined) {
        return state?.pageIndex === expect.expectedAnnotationPageIndex;
      }
      return true;
    }
    if (expect.expectedPageIndex !== undefined) {
      return state?.pageIndex === expect.expectedPageIndex;
    }
    if (expect.expectingCfi) {
      return Boolean(state?.cfi) && state?.cfi !== expect.baselineCfi;
    }
    if (expect.expectedPageLabel !== undefined) {
      if (active.pageLabel === expect.expectedPageLabel) return true;
      // No cheap label→index map here, so accept any settled move instead.
      return (
        state?.pageIndex !== undefined &&
        state.pageIndex !== expect.baselinePageIndex
      );
    }
    // Bare open: any concrete location means the reader is ready.
    return state?.pageIndex !== undefined || Boolean(state?.cfi);
  }

  private normalizeOptionalPage(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1) {
      throw new InvalidArgumentError(
        `"page" must be a 1-based integer, got ${JSON.stringify(value)}.`,
      );
    }
    return num;
  }

  /**
   * Verifies an annotation exists and belongs to the attachment, and returns its
   * 0-based page index when it carries one (PDF annotations). Undefined for EPUB
   * or snapshot annotations, whose position is a selector rather than a page.
   */
  private async assertAnnotationOf(
    attachment: Zotero.Item,
    annotationKey: string,
  ): Promise<number | undefined> {
    this.resolver.assertKeyShape("annotation", annotationKey);
    const annotation = await this.gateway.getItemByKey(
      this.gateway.userLibraryID,
      annotationKey,
    );
    if (!annotation || !annotation.isAnnotation?.()) {
      throw new NotFoundError("annotation", annotationKey);
    }
    if (annotation.parentItemID !== attachment.id) {
      throw new InvalidArgumentError(
        `Annotation "${annotationKey}" does not belong to attachment ` +
          `"${attachment.key}".`,
      );
    }

    const raw = (annotation as { annotationPosition?: unknown })
      .annotationPosition;
    if (typeof raw === "string" && raw) {
      try {
        const pos = JSON.parse(raw) as { pageIndex?: unknown };
        if (typeof pos.pageIndex === "number") return pos.pageIndex;
      } catch {
        // A non-JSON or selector-based position has no page index.
      }
    }
    return undefined;
  }

  private normalizeContextChars(value: unknown): number {
    if (value === undefined || value === null) return DEFAULT_CONTEXT_CHARS;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      throw new InvalidArgumentError(
        `"contextChars" must be a non-negative number, got ${JSON.stringify(value)}.`,
      );
    }
    return Math.min(Math.floor(num), MAX_CONTEXT_CHARS);
  }

  private async extractContext(
    attachment: Zotero.Item,
    location: ReaderLocationInfo,
    selection: ReaderSelectionInfo | null,
    maxChars: number,
  ): Promise<ReaderContextInfo | null> {
    const sdt = await this.gateway.getSdtReader(attachment.id);
    const targetPageIndex = selection?.pageIndex ?? location.pageIndex;

    // 1. Try to find section info from SDT catalog outline
    let section: { title: string; level?: number } | undefined;
    if (sdt && targetPageIndex !== undefined) {
      try {
        const catalog = await sdt.getCatalog();
        if (catalog.outline && catalog.outline.length) {
          section = await this.findSectionForPage(
            sdt,
            catalog.outline,
            targetPageIndex,
            pageBlockResolver(catalog),
          );
        }
      } catch {
        // Outline extraction is best effort
      }
    }

    // 2. If text selection exists, cut surrounding context around it
    if (selection?.text) {
      const selectedText = selection.text.trim();

      // Try SDT page blocks first
      if (sdt && targetPageIndex !== undefined) {
        try {
          const blocks = await sdt.getPageBlocks(targetPageIndex);
          if (blocks.length > 0) {
            const blockTexts = blocks
              .map((b) => this.blockText(b))
              .filter(Boolean);

            // Check single block
            const matchingBlock = blockTexts.find((t) =>
              t.includes(selectedText),
            );
            if (matchingBlock) {
              const idx = matchingBlock.indexOf(selectedText);
              const half = Math.floor(maxChars / 2);
              const textBefore = matchingBlock.slice(
                Math.max(0, idx - half),
                idx,
              );
              const textAfter = matchingBlock.slice(
                idx + selectedText.length,
                idx + selectedText.length + half,
              );
              return {
                paragraph: matchingBlock,
                textBefore,
                textAfter,
                surroundingText:
                  matchingBlock.length <= maxChars
                    ? matchingBlock
                    : `${textBefore}${selectedText}${textAfter}`,
                section,
              };
            }

            // Check across all blocks of the page
            const pageText = blockTexts.join("\n\n");
            const idx = pageText.indexOf(selectedText);
            if (idx !== -1) {
              const half = Math.floor(maxChars / 2);
              const textBefore = pageText.slice(Math.max(0, idx - half), idx);
              const textAfter = pageText.slice(
                idx + selectedText.length,
                idx + selectedText.length + half,
              );
              return {
                textBefore,
                textAfter,
                surroundingText: `${textBefore}${selectedText}${textAfter}`,
                section,
              };
            }
          }
        } catch {
          // Fall through to cache
        }
      }

      // Fall back to full-text cache file
      try {
        const cachePath = this.gateway.fulltextCachePath(attachment);
        if (cachePath) {
          const fullText = await this.gateway.readTextFile(cachePath);
          const idx = fullText.indexOf(selectedText);
          if (idx !== -1) {
            const half = Math.floor(maxChars / 2);
            const textBefore = fullText.slice(Math.max(0, idx - half), idx);
            const textAfter = fullText.slice(
              idx + selectedText.length,
              idx + selectedText.length + half,
            );
            return {
              textBefore,
              textAfter,
              surroundingText: `${textBefore}${selectedText}${textAfter}`,
              section,
            };
          }
        }
      } catch {
        // Fall back
      }

      return section ? { section } : null;
    }

    // 3. If NO selection, provide page text snippet and section
    let pageTextSnippet: string | undefined;
    if (sdt && targetPageIndex !== undefined) {
      try {
        const blocks = await sdt.getPageBlocks(targetPageIndex);
        if (blocks.length > 0) {
          const pageText = blocksToText(blocks);
          if (pageText) {
            pageTextSnippet =
              pageText.length <= maxChars
                ? pageText
                : `${pageText.slice(0, maxChars)}…`;
          }
        }
      } catch {
        // Best effort
      }
    }

    if (section || pageTextSnippet) {
      return {
        section,
        pageTextSnippet,
      };
    }

    return null;
  }

  private async findSectionForPage(
    sdt: { getBlocks(start: number, end: number): Promise<SdtNode[]> },
    outline: Parameters<typeof flattenOutline>[0],
    pageIndex: number,
    resolvePageBlock?: Parameters<typeof flattenOutline>[1],
  ): Promise<{ title: string; level?: number } | undefined> {
    const flat = preferAuthoredOutline(
      flattenOutline(outline, resolvePageBlock),
    );
    if (!flat.length) return undefined;

    // Resolve pageIndex for flat entries if missing
    for (const entry of flat) {
      if (
        entry.pageIndex === undefined &&
        typeof entry.blockIndex === "number"
      ) {
        try {
          const [block] = await sdt.getBlocks(
            entry.blockIndex,
            entry.blockIndex,
          );
          if (block) {
            entry.pageIndex = firstPageIndex(block);
          }
        } catch {
          // Ignore
        }
      }
    }

    // Find the latest section that starts at or before pageIndex
    let candidate: (typeof flat)[0] | undefined;
    for (const entry of flat) {
      if (entry.pageIndex !== undefined && entry.pageIndex <= pageIndex) {
        candidate = entry;
      } else if (entry.pageIndex !== undefined && entry.pageIndex > pageIndex) {
        break;
      }
    }

    return candidate
      ? { title: candidate.title, level: candidate.level }
      : undefined;
  }

  private blockText(block: SdtNode): string {
    const parts: string[] = [];
    this.collectText(block, parts);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  private collectText(node: SdtNode, out: string[]): void {
    if (typeof node.text === "string" && node.text) {
      out.push(node.text);
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) this.collectText(child, out);
    }
  }
}
