/**
 * Reader inspection service.
 *
 * Exposes the currently active reader in Zotero (PDF, EPUB or snapshot),
 * its current page or location, active text or annotation selection,
 * and surrounding text context.
 */

import { InvalidArgumentError } from "../errors";
import {
  blocksToText,
  firstPageIndex,
  flattenOutline,
} from "./documentTextService";
import type { ItemResolver } from "./itemResolver";
import { buildItemUris } from "./uriService";
import type { SdtNode, ZoteroGateway } from "./zoteroGateway";

export interface ReaderOptions {
  /** Optional 8-character attachment key to inspect a specific reader. */
  attachmentKey?: string;
  /** Whether to include surrounding text context for the selection or location. Default true. */
  includeContext?: boolean;
  /** Maximum characters of surrounding context to return. Default 600. */
  contextChars?: number;
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
  ): Promise<{ title: string; level?: number } | undefined> {
    const flat = flattenOutline(outline);
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
