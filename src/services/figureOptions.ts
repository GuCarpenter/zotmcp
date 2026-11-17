/**
 * Shared argument normalisation for the two callers of the figure locator: the
 * image reader (`image_read`, source 'figure') and the figure inventory
 * (`paper_read`, mode 'figures'). Both must accept the same `padding` and page
 * arguments with the same defaults, or a rect listed by one would not reproduce
 * the crop drawn by the other.
 */

import { InvalidArgumentError } from "../errors";
import { DEFAULT_FIGURE_PADDING, MAX_FIGURE_PADDING } from "./figureLocator";

/** Default number of figures a single `figures` listing returns. */
export const DEFAULT_FIGURE_LIST_LIMIT = 200;

/** Ceiling on one listing, so a whole-book inventory cannot flood a client. */
export const MAX_FIGURE_LIST_LIMIT = 1000;

/**
 * A 1-based page number from a tool argument, as a 0-based page index.
 */
export function normalizePageIndex(page: unknown): number {
  const num = Number(page);
  if (!Number.isInteger(num) || num < 1) {
    throw new InvalidArgumentError(
      `"page" must be a 1-based integer page number, got ${JSON.stringify(page)}.`,
    );
  }
  return num - 1;
}

/**
 * The margin in PDF points to add around a located figure. Absent means the
 * default breathing room; 0 keeps the ink-tight union, which is what a caller
 * wants when it is fitting the image to something else itself.
 */
export function normalizeFigurePadding(
  padding: unknown,
  fallback = DEFAULT_FIGURE_PADDING,
): number {
  if (padding === undefined || padding === null) return fallback;
  const num = Number(padding);
  if (!Number.isFinite(num) || num < 0 || num > MAX_FIGURE_PADDING) {
    throw new InvalidArgumentError(
      `"padding" must be a number of PDF points between 0 and ` +
        `${MAX_FIGURE_PADDING}, got ${JSON.stringify(padding)}.`,
    );
  }
  return num;
}

/** How many entries a figure listing may return. */
export function normalizeFigureLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_FIGURE_LIST_LIMIT;
  const num = Number(limit);
  if (!Number.isInteger(num) || num < 1 || num > MAX_FIGURE_LIST_LIMIT) {
    throw new InvalidArgumentError(
      `"limit" must be an integer between 1 and ${MAX_FIGURE_LIST_LIMIT}, ` +
        `got ${JSON.stringify(limit)}.`,
    );
  }
  return num;
}
