/**
 * Document text, built on Zotero 10's Structured Document Text (SDT) packs.
 *
 * SDT is the same primitive Zotero's own reader uses: a cached, hash-invalidated
 * parse of a PDF, EPUB or snapshot attachment into typed blocks (`heading`,
 * `paragraph`, `caption`, …) with a page catalogue and an outline. One code path
 * therefore serves both PDF and EPUB — no zip parsing, no page-offset
 * arithmetic, and real section structure instead of heading heuristics.
 *
 * Fallbacks, in order, because a pack can be unavailable, stale or refused for a
 * password-protected file:
 *   1. SDT pack
 *   2. `PDFWorker.getFullText` (PDF only)
 *   3. Zotero's cached extracted text
 *   4. `NoTextLayerError`
 */

import {
  InvalidArgumentError,
  NoTextLayerError,
  UnsupportedAttachmentError,
} from "../errors";
import type {
  SdtNode,
  SdtOutlineItem,
  SdtReader,
  ZoteroGateway,
} from "./zoteroGateway";

export const DEFAULT_MAX_CHARS = 60_000;
export const MAX_MAX_CHARS = 400_000;

export const PDF_CONTENT_TYPE = "application/pdf";
export const EPUB_CONTENT_TYPE = "application/epub+zip";
const SNAPSHOT_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];

export type TextSource = "sdt" | "pdf-worker" | "fulltext-cache";

export interface TextResult {
  text: string;
  source: TextSource;
  truncated: boolean;
  totalChars: number;
  note?: string;
}

export interface PageResult {
  pageNumber: number;
  /** The document's own label, which may be roman or unnumbered front matter. */
  label?: string;
  text: string;
}

export interface PagesResult {
  pages: PageResult[];
  totalPages: number;
  source: TextSource;
  truncated: boolean;
  note?: string;
}

export interface SectionResult {
  title: string;
  level: number;
  /** 1-based page the section starts on, when the document has pages. */
  startPage?: number;
  text?: string;
  charCount: number;
  /** Set when this section's own text was cut by a cap. */
  truncated?: boolean;
}

export interface SectionsResult {
  sections: SectionResult[];
  source: "sdt-outline" | "sdt-headings";
  truncated: boolean;
  /** Sections the document has, before any selector was applied. */
  totalSections: number;
  /** Selectors that matched no section, so a typo is visible. */
  unmatchedSelectors?: string[];
  note?: string;
}

export interface SectionsOptions {
  includeText?: boolean;
  /** Total character budget across all returned sections. */
  maxChars?: number;
  /**
   * Read only these sections. A selector matches when the section title starts
   * with it or contains it, case-insensitively — so `"3.1"` selects
   * `3.1 Algorithm` together with `3.1.1` and `3.1.2`, and `"background"`
   * selects `2 Background`. Without a selector every section is returned.
   */
  select?: string[];
  /** Per-section character cap, so one long section cannot eat the budget. */
  perSectionMaxChars?: number;
}

/** Normalizes a title or selector for comparison. */
function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** A selector like `3` or `3.1.2`, as opposed to words. */
const NUMERIC_SELECTOR = /^\d+(?:\.\d+)*$/;
const LEADING_SECTION_NUMBER = /^(\d+(?:\.\d+)*)/;

export function matchesSelector(title: string, selector: string): boolean {
  const needle = normalizeForMatch(selector);
  if (!needle) return false;
  const haystack = normalizeForMatch(title);

  // A numeric selector must align with the title's own section number.
  // Substring matching would make "3.1" match "2.3.1 Forward pass", which is a
  // different section entirely.
  if (NUMERIC_SELECTOR.test(needle)) {
    const leading = LEADING_SECTION_NUMBER.exec(haystack)?.[1];
    if (!leading) return false;
    return leading === needle || leading.startsWith(`${needle}.`);
  }

  return haystack.startsWith(needle) || haystack.includes(needle);
}

/** Recursively concatenates a block's text leaves, as Zotero's own reader does. */
export function blockText(node: SdtNode): string {
  if (node.text !== undefined) return node.text;
  if (!node.content) return "";

  const hasChildBlock = node.content.some((child) => child.text === undefined);
  if (!hasChildBlock) {
    return node.content.map((child) => child.text ?? "").join("");
  }

  return node.content
    .filter((child) => child.text === undefined)
    .map((child) => blockText(child))
    .filter(Boolean)
    .join("\n");
}

export function blocksToText(blocks: SdtNode[]): string {
  return blocks
    .map((block) => blockText(block).trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Flattens a block to its text leaves in reading order — the nodes that carry
 * `text` and the `anchor.textMap` glyph geometry. Used to map a quoted string
 * to character-exact rectangles.
 */
export function collectTextLeaves(node: SdtNode): SdtNode[] {
  if (typeof node.text === "string") return [node];
  const leaves: SdtNode[] = [];
  for (const child of node.content ?? []) {
    leaves.push(...collectTextLeaves(child));
  }
  return leaves;
}

/**
 * A block's page comes from its anchor's first page rect, whose leading element
 * is the 0-based page index (`[pageIndex, x1, y1, x2, y2]`). Blocks without an
 * anchor of their own inherit one from their children.
 */
export function firstPageIndex(node: SdtNode): number | undefined {
  const rect = node.anchor?.pageRects?.[0];
  if (Array.isArray(rect) && typeof rect[0] === "number") return rect[0];
  if (typeof node.anchor?.pageIndex === "number") return node.anchor.pageIndex;

  for (const child of node.content ?? []) {
    const found = firstPageIndex(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Flattens an SDT outline, keeping nesting depth as the section level. */
export function flattenOutline(
  items: SdtOutlineItem[] | undefined,
  level = 1,
): { title: string; blockIndex: number; pageIndex?: number; level: number }[] {
  const flat: {
    title: string;
    blockIndex: number;
    pageIndex?: number;
    level: number;
  }[] = [];

  for (const item of items ?? []) {
    const blockIndex = Array.isArray(item.ref) ? item.ref[0] : undefined;
    if (typeof blockIndex === "number" && Number.isInteger(blockIndex)) {
      flat.push({
        title: (item.title ?? "").trim() || "(untitled section)",
        blockIndex,
        pageIndex: item.target?.position?.pageIndex,
        level,
      });
    }
    // PDF and EPUB packs nest under different keys, so both are accepted.
    const children = item.items ?? item.children;
    if (children?.length) flat.push(...flattenOutline(children, level + 1));
  }

  return flat.sort((a, b) => a.blockIndex - b.blockIndex);
}

export function parsePageRange(spec: unknown, totalPages: number): number[] {
  if (spec === undefined || spec === null || spec === "") {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const text = String(spec).trim();
  const pages = new Set<number>();

  for (const part of text.split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(chunk);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to < from) {
        throw new InvalidArgumentError(
          `Invalid page range "${chunk}": expected 1-based ascending pages.`,
        );
      }
      for (let page = from; page <= to; page++) pages.add(page);
      continue;
    }

    const single = Number(chunk);
    if (!Number.isInteger(single) || single < 1) {
      throw new InvalidArgumentError(
        `Invalid page "${chunk}": expected a 1-based page number or range.`,
      );
    }
    pages.add(single);
  }

  const wanted = [...pages].sort((a, b) => a - b);
  const inRange = wanted.filter((page) => page <= totalPages);
  if (!inRange.length) {
    throw new InvalidArgumentError(
      `No requested page exists: the document has ${totalPages} page(s).`,
    );
  }
  return inRange;
}

export class DocumentTextService {
  constructor(private readonly gateway: ZoteroGateway) {}

  public normalizeMaxChars(value: unknown): number {
    if (value === undefined || value === null) return DEFAULT_MAX_CHARS;
    const chars = Number(value);
    if (!Number.isFinite(chars) || chars < 1) {
      throw new InvalidArgumentError(
        `Invalid maxChars ${JSON.stringify(value)}: expected a positive number.`,
      );
    }
    return Math.min(Math.floor(chars), MAX_MAX_CHARS);
  }

  public assertReadable(attachment: Zotero.Item): void {
    const contentType = attachment.attachmentContentType ?? null;
    const readable =
      contentType === PDF_CONTENT_TYPE ||
      contentType === EPUB_CONTENT_TYPE ||
      SNAPSHOT_CONTENT_TYPES.includes(contentType ?? "");
    if (!readable) {
      throw new UnsupportedAttachmentError(
        attachment.key,
        contentType,
        "a PDF, EPUB or web snapshot attachment",
      );
    }
  }

  public isPdf(attachment: Zotero.Item): boolean {
    return attachment.attachmentContentType === PDF_CONTENT_TYPE;
  }

  /**
   * The 0-based page a quoted string first appears on, for a PDF full-text hit.
   * Matches on whitespace-normalized block text, so a query that survives a
   * line wrap still resolves. Null when there is no page structure or no match.
   */
  public async pageOfText(
    attachment: Zotero.Item,
    query: string,
  ): Promise<number | null> {
    if (!this.isPdf(attachment)) return null;
    const needle = normalizeForMatch(query);
    if (!needle) return null;

    const reader = await this.gateway.getSdtReader(attachment.id);
    if (!reader) return null;

    const total = reader.getTopLevelBlockCount();
    const blocks = total > 0 ? await reader.getBlocks(0, total - 1) : [];
    for (const block of blocks) {
      if (normalizeForMatch(blockText(block)).includes(needle)) {
        const pageIndex = firstPageIndex(block);
        if (pageIndex !== undefined) return pageIndex;
      }
    }
    return null;
  }

  public async fullText(
    attachment: Zotero.Item,
    maxChars = DEFAULT_MAX_CHARS,
  ): Promise<TextResult> {
    this.assertReadable(attachment);

    const reader = await this.gateway.getSdtReader(attachment.id);
    if (reader) {
      const count = reader.getTopLevelBlockCount();
      const blocks = count > 0 ? await reader.getBlocks(0, count - 1) : [];
      const text = blocksToText(blocks);
      if (text) return cap(text, maxChars, "sdt");
    }

    return this.fallbackText(attachment, maxChars);
  }

  public async pages(
    attachment: Zotero.Item,
    rangeSpec: unknown,
    maxChars = DEFAULT_MAX_CHARS,
  ): Promise<PagesResult> {
    this.assertReadable(attachment);

    const reader = await this.gateway.getSdtReader(attachment.id);
    if (!reader) {
      throw new NoTextLayerError(attachment.key);
    }

    const catalog = await reader.getCatalog();
    const catalogPages = catalog.pages ?? [];
    if (!catalogPages.length) {
      throw new InvalidArgumentError(
        `Attachment "${attachment.key}" has no page structure; read it with ` +
          `mode 'fulltext' or 'sections' instead.`,
      );
    }

    const wanted = parsePageRange(rangeSpec, catalogPages.length);
    const pages: PageResult[] = [];
    let used = 0;
    let truncated = false;

    for (const pageNumber of wanted) {
      if (used >= maxChars) {
        truncated = true;
        break;
      }
      const blocks = await reader.getPageBlocks(pageNumber - 1);
      let text = blocksToText(blocks);
      if (used + text.length > maxChars) {
        text = text.slice(0, Math.max(0, maxChars - used));
        truncated = true;
      }
      used += text.length;
      pages.push({
        pageNumber,
        ...(catalogPages[pageNumber - 1]?.label
          ? { label: String(catalogPages[pageNumber - 1].label) }
          : {}),
        text,
      });
    }

    return {
      pages,
      totalPages: catalogPages.length,
      source: "sdt",
      truncated,
      ...(catalog.pageMappingType === "locations"
        ? {
            note:
              "This document has no physical pages; page numbers are reading " +
              "locations derived by Zotero.",
          }
        : {}),
    };
  }

  /**
   * Sections for PDF *and* EPUB. The pack's outline is preferred — for a PDF it
   * combines the embedded outline with detected headings, and for an EPUB it
   * comes from the navigation document. Failing that, `heading` blocks in the
   * stream define the boundaries.
   */
  public async sections(
    attachment: Zotero.Item,
    options: SectionsOptions = {},
  ): Promise<SectionsResult> {
    this.assertReadable(attachment);

    const includeText = options.includeText !== false;
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

    const reader = await this.gateway.getSdtReader(attachment.id);
    if (!reader) throw new NoTextLayerError(attachment.key);

    const catalog = await reader.getCatalog();
    const total = reader.getTopLevelBlockCount();

    const outline = flattenOutline(catalog.outline);
    if (outline.length) {
      return this.buildSections(
        reader,
        outline.map((entry) => ({
          title: entry.title,
          level: entry.level,
          blockIndex: entry.blockIndex,
          pageIndex: entry.pageIndex,
        })),
        total,
        includeText,
        maxChars,
        "sdt-outline",
        options,
      );
    }

    const blocks = total > 0 ? await reader.getBlocks(0, total - 1) : [];
    const headings = blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => block.type === "heading")
      .map(({ block, index }) => ({
        title: blockText(block).trim() || "(untitled section)",
        level: 1,
        blockIndex: index,
        pageIndex: firstPageIndex(block),
      }));

    if (!headings.length) {
      return {
        sections: [],
        source: "sdt-headings",
        truncated: false,
        totalSections: 0,
        note:
          "This document has no outline and no detected headings, so it has no " +
          "sections. Read it with mode 'fulltext' or 'pages'.",
      };
    }

    return this.buildSections(
      reader,
      headings,
      total,
      includeText,
      maxChars,
      "sdt-headings",
      options,
    );
  }

  private async buildSections(
    reader: SdtReader,
    entries: {
      title: string;
      level: number;
      blockIndex: number;
      pageIndex?: number;
    }[],
    totalBlocks: number,
    includeText: boolean,
    maxChars: number,
    source: "sdt-outline" | "sdt-headings",
    options: SectionsOptions,
  ): Promise<SectionsResult> {
    const totalSections = entries.length;
    const selectors = (options.select ?? []).filter(
      (selector) => typeof selector === "string" && selector.trim(),
    );
    const perSectionMaxChars = options.perSectionMaxChars;

    // Section boundaries must be computed from the full list: a selected
    // section still ends where the *next* section begins, selected or not.
    const spans = entries.map((entry, i) => ({
      entry,
      start: entry.blockIndex,
      end:
        i + 1 < entries.length
          ? Math.max(entry.blockIndex, entries[i + 1].blockIndex - 1)
          : totalBlocks - 1,
    }));

    const unmatched = selectors.filter(
      (selector) =>
        !spans.some(({ entry }) => matchesSelector(entry.title, selector)),
    );

    const wanted = selectors.length
      ? spans.filter(({ entry }) =>
          selectors.some((selector) => matchesSelector(entry.title, selector)),
        )
      : spans;

    const sections: SectionResult[] = [];
    let used = 0;
    let truncated = false;

    for (const { entry, start, end } of wanted) {
      let text: string | undefined;
      let charCount = 0;
      let sectionTruncated = false;
      let pageIndex = entry.pageIndex;

      if (includeText && start <= end && used < maxChars) {
        const blocks = await reader.getBlocks(start, end);
        if (pageIndex === undefined && blocks.length) {
          pageIndex = firstPageIndex(blocks[0]);
        }
        // The heading itself opens the section, so its text is not repeated.
        const body = blocksToText(blocks.slice(1));
        charCount = body.length;

        const budget = Math.min(
          maxChars - used,
          perSectionMaxChars ?? Number.POSITIVE_INFINITY,
        );
        if (body.length > budget) {
          text = body.slice(0, Math.max(0, budget));
          sectionTruncated = true;
          truncated = true;
        } else {
          text = body;
        }
        used += text.length;
      } else {
        if (includeText && start <= end) {
          sectionTruncated = true;
          truncated = true;
        }
        // Outline entries do not always carry a page, but the block they point
        // at does, and a section without a page number is far less useful.
        if (pageIndex === undefined && start <= end) {
          const [first] = await reader.getBlocks(start, start);
          if (first) pageIndex = firstPageIndex(first);
        }
      }

      sections.push({
        title: entry.title,
        level: entry.level,
        ...(typeof pageIndex === "number" ? { startPage: pageIndex + 1 } : {}),
        ...(text === undefined ? {} : { text }),
        charCount,
        ...(sectionTruncated ? { truncated: true } : {}),
      });
    }

    return {
      sections,
      source,
      truncated,
      totalSections,
      ...(unmatched.length ? { unmatchedSelectors: unmatched } : {}),
      ...(selectors.length && !sections.length
        ? {
            note:
              "No section matched the selector. Call the same mode with " +
              "includeText false to list the document's sections.",
          }
        : {}),
    };
  }

  private async fallbackText(
    attachment: Zotero.Item,
    maxChars: number,
  ): Promise<TextResult> {
    if (this.isPdf(attachment)) {
      const extracted = await this.gateway.getPdfFullText(attachment.id);
      if (extracted?.text) {
        return {
          ...cap(extracted.text, maxChars, "pdf-worker"),
          note:
            "Structured text was unavailable, so this is raw extracted text " +
            "without section or page structure.",
        };
      }
    }

    const cachePath = this.gateway.fulltextCachePath(attachment);
    if (cachePath) {
      try {
        const cached = await this.gateway.readTextFile(
          cachePath,
          MAX_MAX_CHARS,
        );
        if (cached.trim()) {
          return {
            ...cap(cached, maxChars, "fulltext-cache"),
            note:
              "Read from Zotero's cached extracted text; section and page " +
              "structure is unavailable.",
          };
        }
      } catch {
        // Fall through to the error below: a missing cache is not a distinct
        // failure worth reporting separately.
      }
    }

    throw new NoTextLayerError(attachment.key);
  }
}

function cap(text: string, maxChars: number, source: TextSource): TextResult {
  const truncated = text.length > maxChars;
  return {
    text: truncated ? text.slice(0, maxChars) : text,
    source,
    truncated,
    totalChars: text.length,
  };
}
