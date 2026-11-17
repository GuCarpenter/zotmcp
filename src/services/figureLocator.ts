/**
 * Figure and table location from Zotero 10's Structured Document Text layout.
 *
 * SDT tags each top-level block with a semantic `type` (`caption`, `image`,
 * `table`, …) and anchors it with page rects. A caption whose text starts with
 * a label ("Figure 1", "Table 2") pins the page, and the adjacent image or
 * table block supplies the graphic. The located rect is the union of the
 * caption and its media block, in PDF user-space coordinates.
 *
 * That union is ink-tight, and SDT's own rects are coarse: one rect per block,
 * often covering a single line of a multi-line caption, and a few points short
 * of the glyphs' true extent. A caller that renders the rect as an image can
 * therefore ask for `padding` (PDF points on every side) so nothing is clipped
 * at the border; the padded rect is clamped to the page's crop box.
 *
 * Shared by the image reader (to crop a figure) and the annotation writer (to
 * place an area annotation on one), so the two never drift.
 */

import type { SdtNode, ZoteroGateway } from "./zoteroGateway";

export interface LocatedFigure {
  /** Caption text, trimmed and whitespace-collapsed, cut to 120 characters. */
  label: string;
  /** The full caption text. */
  caption: string;
  kind: FigureKind;
  /** The figure or table number as the caption writes it, e.g. "2.34" or "1-1". */
  number: string;
  pageIndex: number;
  rect: [number, number, number, number];
  /**
   * True when a graphic block was found beside the caption. False for a caption
   * whose figure is an image-less float elsewhere — the rect is then the
   * caption alone.
   */
  hasGraphic: boolean;
}

export interface FigureListOptions {
  /** Only captions on this 0-based page. */
  restrictPage?: number;
  /** Margin in PDF points around each rect, clamped to the page crop box. */
  padding?: number;
  /** Return only figures or only tables. */
  kind?: FigureKind;
  /** Stop after this many entries; the result reports what was left out. */
  limit?: number;
}

export interface FigureListResult {
  figures: LocatedFigure[];
  /** Figures found before `limit` was applied. */
  total: number;
  truncated: boolean;
  /** Pages that were scanned, i.e. the whole document unless restricted. */
  pagesScanned: number;
}

/** One table found in a PDF, captioned or merely present. */
export interface LocatedTable {
  /** "Table 2.1 ..." caption text, or null when the table carries no caption. */
  label: string | null;
  caption: string | null;
  /** The number the caption writes, e.g. "2.1", or null without a caption. */
  number: string | null;
  pageIndex: number;
  rect: [number, number, number, number];
  /** False when the layout model found a table with no caption of its own. */
  captioned: boolean;
  /** Opening words of the table's own text, so a caller can tell what it is. */
  preview: string;
}

export interface TableListOptions {
  /** Only tables on this 0-based page. */
  restrictPage?: number;
  /** Margin in PDF points around each rect, clamped to the page crop box. */
  padding?: number;
  /**
   * Also list tables the layout model tagged as `table` but that carry no
   * caption. Off by default: some books mis-tag index entries and two-column
   * prose as tables, so this is a superset to be read with `captioned` in mind.
   */
  includeUncaptioned?: boolean;
  /** Shortest text an uncaptioned table needs to be reported. Default 24 chars. */
  minPreviewChars?: number;
  /** Stop after this many entries; the result reports what was left out. */
  limit?: number;
}

export interface TableListResult {
  tables: LocatedTable[];
  /** Tables found before `limit` was applied. */
  total: number;
  truncated: boolean;
  /** How many of the returned tables came from a "Table N" caption. */
  captioned: number;
  pagesScanned: number;
}

/**
 * Breathing room added around a located figure by default, in PDF points, when
 * the caller does not ask for a specific amount. Comfortably clears the few
 * points by which an SDT caption rect can fall short of its glyphs.
 */
export const DEFAULT_FIGURE_PADDING = 6;

/** Ceiling on a requested padding, so a typo cannot ask for the whole page. */
export const MAX_FIGURE_PADDING = 72;

/**
 * Furthest gap, in PDF points, tolerated between a figure's parts. A figure's
 * pieces sit flush or a few lines apart — including the gap a textbook leaves
 * between stacked panels and their "(a)"/"(b)" labels — while a stray short
 * label across the page (a page footer, a floating "Send Feedback" button) is
 * much further away, and including it would drag the crop over unrelated prose
 * that happens to fall inside the enlarged bounding box.
 */
const FIGURE_MEDIA_GAP = 60;

export type FigureKind = "figure" | "table";

export class FigureLocator {
  public constructor(private readonly gateway: ZoteroGateway) {}

  /**
   * Finds the caption block for `label` and returns the page-coordinate rect
   * covering the caption plus its graphic. `padding` widens that rect by the
   * given number of PDF points on each side, clamped to the page crop box;
   * 0 returns the raw union.
   */
  public async locate(
    attachmentItemID: number,
    label: string,
    restrictPage?: number,
    padding = 0,
  ): Promise<LocatedFigure | null> {
    const parsedLabel = this.parseLabel(label);
    if (!parsedLabel) return null;

    const blocks = await this.topLevelBlocks(attachmentItemID);
    if (!blocks) return null;

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type !== "caption") continue;
      if (!this.captionMatches(this.nodeText(block), parsedLabel)) continue;

      const figure = await this.figureAt(
        attachmentItemID,
        blocks,
        i,
        block,
        parsedLabel,
        { restrictPage, padding },
      );
      if (figure) return figure;
    }

    return null;
  }

  /**
   * Every labelled figure and table the layout model knows about, in document
   * order, each with its caption and the rect a crop would use. Captions that
   * carry no recognisable label are skipped, as are exact repeats (same label on
   * the same page). This is the inventory behind `paper_read` mode 'figures'.
   */
  public async list(
    attachmentItemID: number,
    options: FigureListOptions = {},
  ): Promise<FigureListResult> {
    const blocks = await this.topLevelBlocks(attachmentItemID);
    if (!blocks) {
      return { figures: [], total: 0, truncated: false, pagesScanned: 0 };
    }

    const limit = Math.max(1, Math.trunc(options.limit ?? 200));
    const found: LocatedFigure[] = [];
    const seen = new Set<string>();
    const pages = new Set<number>();

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type !== "caption") continue;

      const parsed = this.parseLabel(this.nodeText(block));
      if (!parsed) continue;
      if (options.kind !== undefined && parsed.kind !== options.kind) continue;

      const figure = await this.figureAt(
        attachmentItemID,
        blocks,
        i,
        block,
        parsed,
        {
          restrictPage: options.restrictPage,
          padding: options.padding ?? 0,
        },
      );
      if (!figure) continue;

      // SDT occasionally repeats a caption block verbatim; a second caption with
      // the same label on another page is genuine and kept.
      const key = `${figure.kind}:${figure.number}:${figure.pageIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);

      pages.add(figure.pageIndex);
      found.push(figure);
    }

    return {
      figures: found.slice(0, limit),
      total: found.length,
      truncated: found.length > limit,
      pagesScanned: pages.size,
    };
  }

  /**
   * Every table in the document, in document order. Captioned tables ("Table
   * 2.1 ...") come from the same caption walk the figure inventory uses; with
   * `includeUncaptioned` the layout model's own `table` blocks are added too, so
   * a book that labels its tables as figures — or not at all — still reports
   * them. An uncaptioned block that overlaps a captioned table, or that is too
   * terse to be a table (an index entry, a stray number), is left out.
   */
  public async listTables(
    attachmentItemID: number,
    options: TableListOptions = {},
  ): Promise<TableListResult> {
    const blocks = await this.topLevelBlocks(attachmentItemID);
    if (!blocks) {
      return {
        tables: [],
        total: 0,
        truncated: false,
        captioned: 0,
        pagesScanned: 0,
      };
    }

    const limit = Math.max(1, Math.trunc(options.limit ?? 200));
    const found: LocatedTable[] = [];
    const pages = new Set<number>();
    const covered: {
      pageIndex: number;
      rect: [number, number, number, number];
    }[] = [];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type !== "caption") continue;

      const parsed = this.parseLabel(this.nodeText(block));
      if (!parsed || parsed.kind !== "table") continue;

      const figure = await this.figureAt(
        attachmentItemID,
        blocks,
        i,
        block,
        parsed,
        { restrictPage: options.restrictPage, padding: options.padding ?? 0 },
      );
      if (!figure) continue;

      pages.add(figure.pageIndex);
      covered.push({ pageIndex: figure.pageIndex, rect: figure.rect });
      found.push({
        label: figure.label,
        caption: figure.caption,
        number: figure.number,
        pageIndex: figure.pageIndex,
        rect: figure.rect,
        captioned: true,
        preview: figure.caption.slice(0, 120),
      });
    }

    const captioned = found.length;

    if (options.includeUncaptioned) {
      const minChars = Math.max(0, options.minPreviewChars ?? 24);
      for (const block of blocks) {
        if (block.type !== "table") continue;
        const pageIndex = this.blockPageIndex(block);
        if (pageIndex === undefined) continue;
        if (
          options.restrictPage !== undefined &&
          pageIndex !== options.restrictPage
        ) {
          continue;
        }

        const rects = this.pageRectsOnPage(block, pageIndex);
        if (!rects.length) continue;
        const rect = this.unionRect(rects);
        if (
          covered.some(
            (c) =>
              c.pageIndex === pageIndex && this.gapBetween(c.rect, rect) === 0,
          )
        ) {
          continue;
        }

        const text = this.nodeText(block);
        if (text.length < minChars) continue;

        covered.push({ pageIndex, rect });
        pages.add(pageIndex);
        found.push({
          label: null,
          caption: null,
          number: null,
          pageIndex,
          rect: await this.padded(
            rect,
            attachmentItemID,
            pageIndex,
            options.padding ?? 0,
          ),
          captioned: false,
          preview: text.slice(0, 120),
        });
      }
    }

    // Page, then top of the page first: SDT y grows upward, so a table nearer
    // the top of the page has the larger y.
    found.sort((a, b) => a.pageIndex - b.pageIndex || b.rect[1] - a.rect[1]);

    return {
      tables: found.slice(0, limit),
      total: found.length,
      truncated: found.length > limit,
      captioned,
      pagesScanned: pages.size,
    };
  }

  /**
   * Builds one located figure from a caption block: its graphic, the page they
   * share, and the padded union of their rects. Null when the caption has no
   * geometry or is not on `restrictPage`.
   */
  private async figureAt(
    attachmentItemID: number,
    blocks: SdtNode[],
    index: number,
    block: SdtNode,
    parsed: { kind: FigureKind; num: string },
    options: { restrictPage?: number; padding: number },
  ): Promise<LocatedFigure | null> {
    const captionPage = this.blockPageIndex(block);
    if (
      options.restrictPage !== undefined &&
      captionPage !== undefined &&
      captionPage !== options.restrictPage
    ) {
      return null;
    }

    // The figure's graphic sits next to its caption — usually just above it,
    // occasionally below. Collect the run of media blocks on that side: raster
    // images and tables, but also vector charts, which SDT tags as ordinary
    // paragraphs/math rather than images.
    const media = this.collectFigureMedia(blocks, index, block, captionPage);

    const pageIndex = captionPage ?? this.blockPageIndex(media[0] ?? block);
    if (pageIndex === undefined) return null;

    const rects = [...this.pageRectsOnPage(block, pageIndex)];
    for (const m of media) rects.push(...this.pageRectsOnPage(m, pageIndex));
    if (!rects.length) return null;

    const caption = this.nodeText(block);
    return {
      label: caption.slice(0, 120),
      caption,
      kind: parsed.kind,
      number: parsed.num,
      pageIndex,
      rect: await this.padded(
        this.unionRect(rects),
        attachmentItemID,
        pageIndex,
        options.padding,
      ),
      hasGraphic: media.length > 0,
    };
  }

  /** Every top-level block, or null when the document has no layout model. */
  private async topLevelBlocks(
    attachmentItemID: number,
  ): Promise<SdtNode[] | null> {
    const sdt = await this.gateway.getSdtReader(attachmentItemID);
    if (!sdt) return null;
    const count = sdt.getTopLevelBlockCount();
    if (!count) return null;
    return sdt.getBlocks(0, count - 1);
  }

  public parseLabel(label: string): { kind: FigureKind; num: string } | null {
    const match = label
      .toLowerCase()
      .match(/^\s*(figure|fig\.?|table|tbl\.?)\s*([0-9]+(?:[.-][0-9]+)*)/);
    if (!match) return null;
    const kind: FigureKind = match[1].startsWith("t") ? "table" : "figure";
    return { kind, num: match[2] };
  }

  /**
   * Gathers the contiguous run of figure-graphic blocks adjacent to a caption:
   * backwards first (a caption below its figure, the common case), then forwards
   * (a caption above, common for tables). The run stops at the first block that
   * is not figure media — prose, a heading or another caption — and also once a
   * block sits more than `FIGURE_MEDIA_GAP` away from what has been collected so
   * far, so a short footer label cannot extend the box over body text.
   */
  private collectFigureMedia(
    blocks: SdtNode[],
    captionIndex: number,
    captionBlock: SdtNode,
    captionPage: number | undefined,
  ): SdtNode[] {
    // The caption is the anchor the graphic must touch; starting from its own
    // box means the gap test below measures from the caption outwards.
    const seed =
      captionPage === undefined
        ? []
        : this.pageRectsOnPage(captionBlock, captionPage);

    const backward = this.collectRun(
      blocks,
      captionIndex,
      -1,
      seed,
      captionPage,
    );
    if (backward.length) return backward;
    return this.collectRun(blocks, captionIndex, 1, seed, captionPage);
  }

  /**
   * Walks outward from the caption in one direction, accepting media blocks
   * while they stay within `FIGURE_MEDIA_GAP` of the growing bounding box.
   * `step` is -1 for the blocks before the caption, +1 for those after it.
   */
  private collectRun(
    blocks: SdtNode[],
    captionIndex: number,
    step: -1 | 1,
    seed: [number, number, number, number][],
    captionPage: number | undefined,
  ): SdtNode[] {
    const MAX_RUN = 8;
    const run: SdtNode[] = [];
    let box = seed.length ? this.unionRect(seed) : null;

    for (
      let j = captionIndex + step;
      j >= 0 && j < blocks.length && run.length < MAX_RUN;
      j += step
    ) {
      const block = blocks[j];
      if (!block) break;
      // A caption-typed block that carries no figure/table label is a panel
      // label ("(a) Lines meet at x = 2") or a continuation note, so it belongs
      // to the figure rather than ending it. One that does carry a label is
      // another figure's caption, and the run stops there.
      const panelLabel =
        block.type === "caption" &&
        this.parseLabel(this.nodeText(block)) === null;
      if (!panelLabel && !this.isFigureMedia(block)) break;
      if (captionPage !== undefined) {
        const page = this.blockPageIndex(block);
        if (page !== undefined && page !== captionPage) break;
      }

      const page = captionPage ?? this.blockPageIndex(block);
      const rects = page === undefined ? [] : this.pageRectsOnPage(block, page);
      if (rects.length) {
        const rect = this.unionRect(rects);
        if (box && this.gapBetween(box, rect) > FIGURE_MEDIA_GAP) break;
        box = box ? this.unionRect([box, rect]) : rect;
      }

      if (step < 0) run.unshift(block);
      else run.push(block);
    }

    return run;
  }

  /** Shortest distance between two rects; 0 when they overlap or touch. */
  private gapBetween(
    a: [number, number, number, number],
    b: [number, number, number, number],
  ): number {
    const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
    const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
    return Math.max(dx, dy);
  }

  /**
   * Whether a block belongs to a figure's graphic. Raster images and tables
   * always qualify; a caption, heading, note or list never does. Otherwise the
   * block only qualifies if its text reads like chart furniture (axis ticks,
   * a legend, a short label) rather than prose — which is how SDT records a
   * vector chart or plotted figure.
   */
  private isFigureMedia(block: SdtNode): boolean {
    const type = block.type;
    if (type === "image" || type === "table") return true;
    if (
      type === "caption" ||
      type === "heading" ||
      type === "note" ||
      type === "list" ||
      type === "listitem"
    ) {
      return false;
    }
    return this.looksLikeChartText(this.nodeText(block));
  }

  /**
   * A heuristic for "this text is chart furniture, not prose": empty text (a
   * bare image), number-dominated content (axis ticks and legends), or a short
   * non-sentence label. Prose paragraphs — many words, sentence punctuation —
   * fail all three and are excluded.
   */
  private looksLikeChartText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return true;
    const tokens = trimmed.split(/\s+/);
    const words = tokens.filter(
      (tok) => (tok.match(/[A-Za-z]/g) ?? []).length >= 3,
    ).length;
    const numbers = tokens.filter((tok) =>
      /^[-+(]?[\d][\d.,%:/)\u2013-]*$/.test(tok),
    ).length;
    if (numbers >= Math.max(3, words)) return true;
    if (trimmed.length <= 24 && !/[.!?]$/.test(trimmed)) return true;
    return false;
  }

  private captionMatches(
    text: string,
    parsed: { kind: FigureKind; num: string },
  ): boolean {
    const other = this.parseLabel(text);
    if (!other) return false;
    return other.kind === parsed.kind && other.num === parsed.num;
  }

  private nodeText(node: SdtNode): string {
    const parts: string[] = [];
    const walk = (n: SdtNode): void => {
      if (typeof n.text === "string" && n.text) parts.push(n.text);
      if (Array.isArray(n.content)) for (const child of n.content) walk(child);
    };
    walk(node);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  private blockPageIndex(node: SdtNode | undefined): number | undefined {
    const first = node?.anchor?.pageRects?.[0];
    if (first && typeof first[0] === "number") return first[0];
    if (typeof node?.anchor?.pageIndex === "number") {
      return node.anchor.pageIndex;
    }
    return undefined;
  }

  /** Collects a block's rects on one page, dropping the leading page index. */
  private pageRectsOnPage(
    node: SdtNode,
    pageIndex: number,
  ): [number, number, number, number][] {
    const rects: [number, number, number, number][] = [];
    for (const entry of node.anchor?.pageRects ?? []) {
      if (entry.length >= 5 && entry[0] === pageIndex) {
        rects.push([entry[1], entry[2], entry[3], entry[4]]);
      }
    }
    return rects;
  }

  /**
   * Grows `rect` by `padding` points a side and clips the result to the page's
   * crop box, so a crop never runs off the edge of the page (where the renderer
   * would paint blank space or nothing at all). When the page box is unknown
   * the rect is still padded — the renderer clips to the page anyway — but a
   * padding that would collapse the rect is discarded.
   */
  private async padded(
    rect: [number, number, number, number],
    attachmentItemID: number,
    pageIndex: number,
    padding: number,
  ): Promise<[number, number, number, number]> {
    if (!padding) return rect;

    const view = await this.gateway.getPdfPageView(
      attachmentItemID,
      pageIndex,
      {
        openIfNeeded: true,
      },
    );

    let [x1, y1, x2, y2] = rect;
    x1 -= padding;
    y1 -= padding;
    x2 += padding;
    y2 += padding;

    if (view) {
      const page = [
        Math.min(view[0], view[2]),
        Math.min(view[1], view[3]),
        Math.max(view[0], view[2]),
        Math.max(view[1], view[3]),
      ];
      x1 = Math.max(x1, page[0]);
      y1 = Math.max(y1, page[1]);
      x2 = Math.min(x2, page[2]);
      y2 = Math.min(y2, page[3]);
    }

    if (!(x2 > x1) || !(y2 > y1)) return rect;
    return [x1, y1, x2, y2];
  }

  private unionRect(
    rects: [number, number, number, number][],
  ): [number, number, number, number] {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const r of rects) {
      x1 = Math.min(x1, r[0], r[2]);
      y1 = Math.min(y1, r[1], r[3]);
      x2 = Math.max(x2, r[0], r[2]);
      y2 = Math.max(y2, r[1], r[3]);
    }
    return [x1, y1, x2, y2];
  }
}
