/**
 * EPUB CFI generation, the same scheme Zotero's reader (built on epub.js) uses.
 *
 * A CFI locates a point or range inside an EPUB's spine document tree. The parts
 * this module produces, verified by round-tripping generated CFIs through
 * Zotero's reader:
 *   - Spine base: `/6/N` — `/6` is the `<spine>` element's step within
 *     `<package>` (element index +1, doubled), `/N` the `<itemref>`'s step in
 *     the spine (spine index +1, doubled). `/6` holds when metadata, manifest
 *     and spine are the package's first three elements, but the spine element's
 *     real index is used so an unusual package still resolves.
 *   - `!` steps into the content document; the path after it starts at the
 *     children of `<html>` (so `<html>` itself is implicit).
 *   - Element step: even, `(elementIndex + 1) * 2` among element siblings.
 *   - Text step: odd, `2 * textIndex + 1` among text-node siblings.
 *   - Terminal character offset: `:offset`. A range shares the element path and
 *     splits at the text node: `base!path,/textStep:start,/textStep:end`.
 *
 * The DOM walk is written against a minimal `CfiDomNode` view so it runs on both
 * Zotero's real DOM nodes and plain objects in unit tests — no DOM engine is
 * needed to test the arithmetic that matters.
 */

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const DOCUMENT_NODE = 9;

/**
 * The slice of a DOM node this module reads. Zotero's `Element`/`Text` satisfy
 * it structurally, and tests can build it from plain objects.
 */
export interface CfiDomNode {
  readonly nodeType: number;
  readonly parentNode: CfiDomNode | null;
  readonly childNodes: ArrayLike<CfiDomNode>;
  /** Element children only, like the DOM's `Element.children`. Optional so a
   *  test node can omit it; it is then derived from `childNodes`. */
  readonly children?: ArrayLike<CfiDomNode>;
  readonly nodeValue?: string | null;
  getAttribute?(name: string): string | null;
}

/** One spine document, parsed to its root element (`<html>`). */
export interface EpubSpineDocument {
  /** 0-based position of the `<itemref>` in the spine. */
  index: number;
  root: CfiDomNode;
}

/** What the gateway hands back for an EPUB, ready for CFI work. */
export interface EpubSpine {
  /** 0-based position of `<spine>` among `<package>`'s element children. */
  spineElementChildIndex: number;
  documents: EpubSpineDocument[];
}

/** A located occurrence of the target text within one spine document. */
export interface EpubTextMatch {
  spineIndex: number;
  /** Character offset from the start of the document's text, for sortIndex. */
  charOffset: number;
  pointCfi: string;
  rangeCfi: string;
  sortIndex: string;
  /** The exact substring matched, as it appears in the document. */
  matchedText: string;
}

function toArray(list: ArrayLike<CfiDomNode> | undefined): CfiDomNode[] {
  return list ? Array.prototype.slice.call(list) : [];
}

function elementChildren(node: CfiDomNode): CfiDomNode[] {
  if (node.children) return toArray(node.children);
  return toArray(node.childNodes).filter((n) => n.nodeType === ELEMENT_NODE);
}

function textChildren(node: CfiDomNode): CfiDomNode[] {
  return toArray(node.childNodes).filter((n) => n.nodeType === TEXT_NODE);
}

interface Step {
  type: "element" | "text";
  index: number;
}

/**
 * Steps from `node` up to (but excluding) the document element, top-first. Every
 * ancestor here is an element, so each step is positional among element
 * siblings.
 */
function elementStepsTo(node: CfiDomNode): Step[] {
  const steps: Step[] = [];
  let current: CfiDomNode = node;
  for (;;) {
    const parent: CfiDomNode | null = current.parentNode;
    if (!parent || parent.nodeType === DOCUMENT_NODE) break;
    const index = elementChildren(parent).indexOf(current);
    steps.unshift({ type: "element", index });
    current = parent;
  }
  return steps;
}

function serialize(steps: Step[]): string {
  return steps
    .map((step) =>
      step.type === "element"
        ? `/${(step.index + 1) * 2}`
        : `/${2 * step.index + 1}`,
    )
    .join("");
}

export function spineBase(
  spineElementChildIndex: number,
  itemrefIndex: number,
): string {
  return `/${(spineElementChildIndex + 1) * 2}/${(itemrefIndex + 1) * 2}`;
}

/**
 * Zotero orders EPUB annotations by a `spineIndex|charOffset` string, each part
 * zero-padded. Unlike a PDF's three-part index there is no page or top.
 */
export function epubSortIndex(
  itemrefIndex: number,
  charOffset: number,
): string {
  const spine = String(Math.max(0, itemrefIndex)).padStart(5, "0").slice(0, 5);
  const offset = String(Math.max(0, charOffset)).padStart(8, "0").slice(-8);
  return `${spine}|${offset}`;
}

/** Yields every text node under `root` in document order. */
function* textNodesInOrder(root: CfiDomNode): Generator<CfiDomNode> {
  for (const child of toArray(root.childNodes)) {
    if (child.nodeType === TEXT_NODE) yield child;
    else if (child.nodeType === ELEMENT_NODE) yield* textNodesInOrder(child);
  }
}

/**
 * Builds the point and range CFIs for a `length`-character match starting at
 * `offset` within a single `textNode`.
 */
export function buildMatchCfi(params: {
  spineElementChildIndex: number;
  itemrefIndex: number;
  textNode: CfiDomNode;
  offset: number;
  length: number;
  charOffset: number;
}): { pointCfi: string; rangeCfi: string; sortIndex: string } {
  const parent = params.textNode.parentNode;
  if (!parent) {
    throw new Error("A text node with no parent cannot be located by CFI.");
  }

  const base = spineBase(params.spineElementChildIndex, params.itemrefIndex);
  const elementPath = serialize(elementStepsTo(parent));
  const textIndex = textChildren(parent).indexOf(params.textNode);
  const textStep = `/${2 * textIndex + 1}`;

  const start = params.offset;
  const end = params.offset + params.length;

  return {
    pointCfi: `epubcfi(${base}!${elementPath}${textStep}:${start})`,
    rangeCfi: `epubcfi(${base}!${elementPath},${textStep}:${start},${textStep}:${end})`,
    sortIndex: epubSortIndex(params.itemrefIndex, params.charOffset),
  };
}

/**
 * Finds every occurrence of `target` across a spine, one per containing text
 * node, and builds a CFI for each. Order is document order across the spine.
 *
 * Matching is a plain substring test within a single text node: it is exact and
 * never guesses. A phrase split across inline elements will not match, which is
 * reported to the caller as "not found" rather than mislocated.
 */
export function locateTextInSpine(
  spine: EpubSpine,
  target: string,
): EpubTextMatch[] {
  const matches: EpubTextMatch[] = [];
  if (!target) return matches;

  for (const document of spine.documents) {
    let cumulative = 0;
    for (const node of textNodesInOrder(document.root)) {
      const value = node.nodeValue ?? "";
      const at = value.indexOf(target);
      if (at !== -1) {
        const built = buildMatchCfi({
          spineElementChildIndex: spine.spineElementChildIndex,
          itemrefIndex: document.index,
          textNode: node,
          offset: at,
          length: target.length,
          charOffset: cumulative + at,
        });
        matches.push({
          spineIndex: document.index,
          charOffset: cumulative + at,
          matchedText: value.slice(at, at + target.length),
          ...built,
        });
      }
      cumulative += value.length;
    }
  }

  return matches;
}
