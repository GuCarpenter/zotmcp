/**
 * Figure and table location from Zotero 10's Structured Document Text layout.
 *
 * SDT tags each top-level block with a semantic `type` (`caption`, `image`,
 * `table`, …) and anchors it with page rects. A caption whose text starts with
 * a label ("Figure 1", "Table 2") pins the page, and the adjacent image or
 * table block supplies the graphic. The located rect is the union of the
 * caption and its media block, in PDF user-space coordinates.
 *
 * Shared by the image reader (to crop a figure) and the annotation writer (to
 * place an area annotation on one), so the two never drift.
 */

import type { SdtNode, ZoteroGateway } from "./zoteroGateway";

export interface LocatedFigure {
  label: string;
  pageIndex: number;
  rect: [number, number, number, number];
}

export type FigureKind = "figure" | "table";

export class FigureLocator {
  public constructor(private readonly gateway: ZoteroGateway) {}

  public async locate(
    attachmentItemID: number,
    label: string,
    restrictPage?: number,
  ): Promise<LocatedFigure | null> {
    const sdt = await this.gateway.getSdtReader(attachmentItemID);
    if (!sdt) return null;

    const parsedLabel = this.parseLabel(label);
    if (!parsedLabel) return null;

    const count = sdt.getTopLevelBlockCount();
    if (!count) return null;
    const blocks = await sdt.getBlocks(0, count - 1);

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type !== "caption") continue;
      if (!this.captionMatches(this.nodeText(block), parsedLabel)) continue;

      const captionPage = this.blockPageIndex(block);
      if (
        restrictPage !== undefined &&
        captionPage !== undefined &&
        captionPage !== restrictPage
      ) {
        continue;
      }

      // The figure's graphic sits next to its caption — usually just above it,
      // occasionally below. Collect the contiguous run of media blocks on that
      // side: raster images and tables, but also vector charts, which SDT tags
      // as ordinary paragraphs/math rather than images.
      const media = this.collectFigureMedia(blocks, i, captionPage);

      const pageIndex = captionPage ?? this.blockPageIndex(media[0] ?? block);
      if (pageIndex === undefined) continue;

      const rects = [...this.pageRectsOnPage(block, pageIndex)];
      for (const m of media) rects.push(...this.pageRectsOnPage(m, pageIndex));
      if (!rects.length) continue;

      return {
        label: this.nodeText(block).trim().slice(0, 120),
        pageIndex,
        rect: this.unionRect(rects),
      };
    }

    return null;
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
   * is not figure media — prose, a heading or another caption — so unrelated
   * body text is never swept in.
   */
  private collectFigureMedia(
    blocks: SdtNode[],
    captionIndex: number,
    captionPage: number | undefined,
  ): SdtNode[] {
    const MAX_RUN = 8;
    const samePage = (block: SdtNode): boolean => {
      const page = this.blockPageIndex(block);
      return captionPage === undefined || page === undefined
        ? true
        : page === captionPage;
    };

    const backward: SdtNode[] = [];
    for (let j = captionIndex - 1; j >= 0 && backward.length < MAX_RUN; j--) {
      const block = blocks[j];
      if (!block || !samePage(block) || !this.isFigureMedia(block)) break;
      backward.unshift(block);
    }
    if (backward.length) return backward;

    const forward: SdtNode[] = [];
    for (
      let j = captionIndex + 1;
      j < blocks.length && forward.length < MAX_RUN;
      j++
    ) {
      const block = blocks[j];
      if (!block || !samePage(block) || !this.isFigureMedia(block)) break;
      forward.push(block);
    }
    return forward;
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
