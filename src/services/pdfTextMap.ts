/**
 * PDF character geometry from Zotero 10's Structured Document Text (SDT) packs.
 *
 * Each text leaf in an SDT pack carries an `anchor.textMap`: a JSON string of
 * per-line "runs" encoding glyph advances, from which the exact rectangle of
 * every non-whitespace character can be reconstructed. This is a faithful port
 * of Zotero's own reader decoder (`reconstructCharPositions` / `buildRunData` /
 * `mergeLineRects` in `structured-document-text`), so the rectangles match what
 * Zotero would compute for a selection — verified by round-tripping a generated
 * highlight through the reader.
 *
 * Coordinates are PDF user space (origin bottom-left, points), the same space
 * `annotation_write` rects use.
 */

/** Bit 0 of a run header: the run's last glyph is a soft hyphen, dropped. */
const HEADER_LAST_IS_SOFT_HYPHEN = 1 << 0;
/** Axis direction occupies two bits above bit 0. */
const HEADER_AXIS_DIR_SHIFT = 1;
/** Fraction of shared vertical extent for two rects to count as one line. */
const SAME_LINE_RATIO = 0.6;

/** A text leaf: its text plus the packed geometry Zotero stored for it. */
export interface TextLeaf {
  text: string;
  anchor?: {
    textMap?: string;
    pageRects?: number[][];
  };
}

export interface PagePosition {
  pageIndex: number;
  /** Merged per-line rectangles, each `[x1, y1, x2, y2]` in PDF user space. */
  rects: number[][];
}

interface CharRun {
  rect: number[];
  pageIndex: number;
}

function isVertical(axisDir: number): boolean {
  return axisDir === 1 || axisDir === 3;
}

export function isWhitespaceChar(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t";
}

function parseTextMap(textMap: string | undefined): number[][] {
  if (typeof textMap !== "string") return [];
  try {
    const parsed = JSON.parse(textMap);
    return Array.isArray(parsed) ? (parsed as number[][]) : [];
  } catch {
    return [];
  }
}

/**
 * Reconstructs each glyph's start/end along the run's main axis. Widths are
 * either a bare advance or a `[delta, width]` pair (a kerning gap then the
 * glyph box); a single-glyph run carries no widths and spans the whole bbox.
 */
function reconstructCharPositions(run: number[]): { x1: number; x2: number }[] {
  if (!run || run.length < 6) return [];
  const header = run[0] as number;
  const minX = run[2] as number;
  const minY = run[3] as number;
  const maxX = run[4] as number;
  const maxY = run[5] as number;
  const widths = run.slice(6) as (number | number[])[];
  const vertical = isVertical((header >> HEADER_AXIS_DIR_SHIFT) & 0b11);
  const start = vertical ? minY : minX;
  const end = vertical ? maxY : maxX;

  if (widths.length === 0) return [{ x1: start, x2: end }];

  const positions: { x1: number; x2: number }[] = [];
  let pos = start;
  for (const w of widths) {
    if (Array.isArray(w)) {
      const [delta, width] = w;
      pos += delta;
      positions.push({ x1: pos, x2: pos + width });
      pos += width;
    } else {
      positions.push({ x1: pos, x2: pos + w });
      pos += w;
    }
  }
  return positions;
}

/** One rectangle per non-whitespace glyph, in reading order across the leaf. */
function buildRunData(runs: number[][]): CharRun[] {
  const data: CharRun[] = [];
  for (const run of runs) {
    if (!Array.isArray(run) || run.length < 6) continue;
    const header = run[0] as number;
    const pageIndex = run[1] as number;
    const minX = run[2] as number;
    const minY = run[3] as number;
    const maxX = run[4] as number;
    const maxY = run[5] as number;
    const vertical = isVertical((header >> HEADER_AXIS_DIR_SHIFT) & 0b11);
    const positions = reconstructCharPositions(run);
    if (header & HEADER_LAST_IS_SOFT_HYPHEN) positions.pop();
    for (const pos of positions) {
      if (!Number.isFinite(pos.x1) || !Number.isFinite(pos.x2)) continue;
      const rect = vertical
        ? [minX, pos.x1, maxX, pos.x2]
        : [pos.x1, minY, pos.x2, maxY];
      data.push({ rect, pageIndex });
    }
  }
  return data;
}

function sameLine(a: number[], b: number[]): boolean {
  const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const minHeight = Math.max(0.001, Math.min(a[3] - a[1], b[3] - b[1]));
  return overlap / minHeight >= SAME_LINE_RATIO;
}

/** Collapses adjacent same-line glyph rects into one rect per line. */
export function mergeLineRects(rects: number[][]): number[][] {
  const merged: number[][] = [];
  let current: number[] | null = null;
  for (const rect of rects) {
    if (current && sameLine(current, rect)) {
      current[0] = Math.min(current[0], rect[0]);
      current[1] = Math.min(current[1], rect[1]);
      current[2] = Math.max(current[2], rect[2]);
      current[3] = Math.max(current[3], rect[3]);
    } else {
      current = [...rect];
      merged.push(current);
    }
  }
  return merged;
}

/**
 * Glyph rectangles for a leaf, aligned to the character indices of `leaf.text`.
 * Whitespace characters have no glyph and are skipped, exactly as Zotero maps
 * runs to characters.
 */
function leafCharBoxes(
  leaf: TextLeaf,
): { index: number; pageIndex: number; rect: number[] }[] {
  const runData = buildRunData(parseTextMap(leaf.anchor?.textMap));
  if (!runData.length) return [];

  const boxes: { index: number; pageIndex: number; rect: number[] }[] = [];
  let runIndex = 0;
  for (let ci = 0; ci < leaf.text.length && runIndex < runData.length; ci++) {
    if (isWhitespaceChar(leaf.text[ci])) continue;
    const run = runData[runIndex++];
    boxes.push({ index: ci, pageIndex: run.pageIndex, rect: run.rect });
  }
  return boxes;
}

/**
 * The character-exact position of the first occurrence of `needle` across a
 * paragraph's leaves. Returns null when the text is absent verbatim or the
 * glyph geometry is unavailable, so the caller can fall back to a coarser
 * block-level rectangle. A match spanning a page break also returns null, since
 * a single highlight position addresses one page.
 */
export function rectsForText(
  leaves: TextLeaf[],
  needle: string,
): PagePosition | null {
  if (!needle) return null;

  const rawText = leaves.map((leaf) => leaf.text).join("");
  const at = rawText.indexOf(needle);
  if (at === -1) return null;
  const end = at + needle.length;

  const byPage = new Map<number, number[][]>();
  let offset = 0;
  for (const leaf of leaves) {
    for (const box of leafCharBoxes(leaf)) {
      const global = offset + box.index;
      if (global >= at && global < end) {
        const rects = byPage.get(box.pageIndex) ?? [];
        rects.push(box.rect);
        byPage.set(box.pageIndex, rects);
      }
    }
    offset += leaf.text.length;
  }

  if (!byPage.size) return null;
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  // A cross-page match cannot be one highlight position; let the caller decide.
  if (pages.length > 1) return null;

  return {
    pageIndex: pages[0],
    rects: mergeLineRects(byPage.get(pages[0]) as number[][]),
  };
}

/**
 * The text covered by `rects` on a page, reconstructed from the leaves' glyph
 * geometry. This is the inverse of {@link rectsForText}: it collects every
 * glyph whose centre falls inside a rect, so a caller can confirm a highlight
 * covers the intended words. Whitespace is not represented, matching Zotero.
 */
export function textUnderRects(
  leaves: TextLeaf[],
  pageIndex: number,
  rects: number[][],
): string {
  const inside = (rect: number[]): boolean => {
    const cx = (rect[0] + rect[2]) / 2;
    const cy = (rect[1] + rect[3]) / 2;
    return rects.some(
      (r) =>
        cx >= r[0] - 0.5 &&
        cx <= r[2] + 0.5 &&
        cy >= r[1] - 0.5 &&
        cy <= r[3] + 0.5,
    );
  };

  let out = "";
  for (const leaf of leaves) {
    for (const box of leafCharBoxes(leaf)) {
      if (box.pageIndex === pageIndex && inside(box.rect)) {
        out += leaf.text[box.index];
      }
    }
  }
  return out;
}
