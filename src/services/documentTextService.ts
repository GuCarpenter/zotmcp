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
  FileMissingError,
  InvalidArgumentError,
  NoTextLayerError,
  UnsupportedAttachmentError,
} from "../errors";
import type {
  SdtCatalog,
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

export interface CleanResult {
  markdown: string;
  source: "defuddle";
  truncated: boolean;
  totalChars: number;
  title?: string;
  author?: string;
  published?: string;
  description?: string;
  wordCount?: number;
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
 * The source URL for a snapshot, needed to resolve relative links and images.
 * A snapshot attachment carries the page URL in its own `url` field; the parent
 * item's `url` is the fallback. Empty when neither is set.
 */
function snapshotUrl(attachment: Zotero.Item): string {
  const read = (item: Zotero.Item | null | undefined): string => {
    try {
      return item ? String(item.getField("url" as never) ?? "") : "";
    } catch {
      return "";
    }
  };
  return read(attachment) || read(attachment.parentItem) || "";
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

/**
 * Resolves a 0-based page index to the index of the first top-level block on
 * that page, so an outline entry that points at a page rather than a block can
 * still be placed in block order.
 */
export type PageBlockResolver = (pageIndex: number) => number | undefined;

/**
 * Flattens an SDT outline, keeping nesting depth as the section level.
 *
 * PDF outline entries do not all carry a block `ref` — sections like
 * "Fallacies and Pitfalls" are frequently anchored only by a page target. Such
 * an entry is kept when a `resolvePageBlock` mapping can turn its page into a
 * block index; without one it would silently vanish from the outline, which is
 * the reader's own left-panel behaviour that this mirrors. An entry with
 * neither a block ref nor a resolvable page is dropped.
 */
export function flattenOutline(
  items: SdtOutlineItem[] | undefined,
  resolvePageBlock?: PageBlockResolver,
  level = 1,
): {
  title: string;
  blockIndex: number;
  pageIndex?: number;
  level: number;
  source?: string;
}[] {
  const flat: {
    title: string;
    blockIndex: number;
    pageIndex?: number;
    level: number;
    source?: string;
  }[] = [];

  for (const item of items ?? []) {
    const pageIndex = item.target?.position?.pageIndex;
    let blockIndex = Array.isArray(item.ref) ? item.ref[0] : undefined;
    if (
      (typeof blockIndex !== "number" || !Number.isInteger(blockIndex)) &&
      typeof pageIndex === "number" &&
      resolvePageBlock
    ) {
      blockIndex = resolvePageBlock(pageIndex);
    }
    if (typeof blockIndex === "number" && Number.isInteger(blockIndex)) {
      flat.push({
        title: (item.title ?? "").trim() || "(untitled section)",
        blockIndex,
        pageIndex,
        level,
        ...(item.source ? { source: item.source } : {}),
      });
    }
    // PDF and EPUB packs nest under different keys, so both are accepted.
    const children = item.items ?? item.children;
    if (children?.length) {
      flat.push(...flattenOutline(children, resolvePageBlock, level + 1));
    }
  }

  return flat.sort((a, b) => a.blockIndex - b.blockIndex);
}

/**
 * Narrows a flattened outline to the document's authored ("native") entries —
 * the same set the reader's left panel shows.
 *
 * An SDT pack merges the authored outline with headings it detects
 * heuristically (`source: "detected"`), which pollutes the section list with
 * entries that are not part of the real table of contents. When any authored
 * entry is present those are the truth and the detected ones are dropped. A
 * pack with no authored outline at all (or an older pack that predates the
 * `source` field) is left untouched, so detection remains a useful fallback.
 */
export function preferAuthoredOutline<T extends { source?: string }>(
  entries: T[],
): T[] {
  const authored = entries.filter((entry) => entry.source === "native");
  return authored.length ? authored : entries;
}

/**
 * Builds a page→first-block resolver from an SDT catalogue's page list. Each
 * page carries a `contentRange` of `[[startBlock], [endBlock]]`, so the first
 * element's first entry is the page's opening top-level block.
 */
export function pageBlockResolver(catalog: SdtCatalog): PageBlockResolver {
  return (pageIndex: number): number | undefined => {
    const range = catalog.pages?.[pageIndex]?.contentRange;
    const start = Array.isArray(range) ? range[0] : undefined;
    const blockIndex = Array.isArray(start) ? start[0] : undefined;
    return typeof blockIndex === "number" && Number.isInteger(blockIndex)
      ? blockIndex
      : undefined;
  };
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

  /** True for a web snapshot: the only attachment Defuddle can extract. */
  public isSnapshot(attachment: Zotero.Item): boolean {
    return SNAPSHOT_CONTENT_TYPES.includes(
      attachment.attachmentContentType ?? "",
    );
  }

  /**
   * Extracts the readable article from a web snapshot and returns it as
   * Markdown (math converted to LaTeX), plus the article metadata. This is the
   * clean counterpart to fullText, whose SDT text keeps the page's navigation
   * and boilerplate.
   */
  public async clean(
    attachment: Zotero.Item,
    maxChars = DEFAULT_MAX_CHARS,
  ): Promise<CleanResult> {
    if (!this.isSnapshot(attachment)) {
      throw new UnsupportedAttachmentError(
        attachment.key,
        attachment.attachmentContentType ?? null,
        "a web snapshot (HTML) attachment",
      );
    }

    const path = await this.gateway.getAttachmentPath(attachment);
    if (!path) throw new FileMissingError(attachment.key, null);

    const html = await this.gateway.readTextFile(path);
    const readable = await this.gateway.extractReadable(
      html,
      snapshotUrl(attachment),
    );

    const markdown = readable.markdown;
    const truncated = markdown.length > maxChars;

    return {
      markdown: truncated ? markdown.slice(0, maxChars) : markdown,
      source: "defuddle",
      truncated,
      totalChars: markdown.length,
      ...(readable.title ? { title: readable.title } : {}),
      ...(readable.author ? { author: readable.author } : {}),
      ...(readable.published ? { published: readable.published } : {}),
      ...(readable.description ? { description: readable.description } : {}),
      ...(readable.wordCount ? { wordCount: readable.wordCount } : {}),
    };
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

    const outline = preferAuthoredOutline(
      flattenOutline(catalog.outline, pageBlockResolver(catalog)),
    );
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
