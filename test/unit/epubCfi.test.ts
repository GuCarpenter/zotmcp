import { expect } from "chai";
import {
  buildMatchCfi,
  epubSortIndex,
  locateTextInSpine,
  spineBase,
  TEXT_NODE,
  ELEMENT_NODE,
  type CfiDomNode,
  type EpubSpine,
} from "../../src/services/epubCfi";

/**
 * A tiny DOM builder so the CFI arithmetic can be tested without a DOM engine.
 * `el(tag, ...children)` and `text(value)` mirror the two node kinds the walker
 * looks at; parents are wired up on construction.
 */
interface TestNode extends CfiDomNode {
  nodeType: number;
  parentNode: TestNode | null;
  childNodes: TestNode[];
  children: TestNode[];
  nodeValue: string | null;
  getAttribute(name: string): string | null;
}

function text(value: string): TestNode {
  return {
    nodeType: TEXT_NODE,
    parentNode: null,
    childNodes: [],
    children: [],
    nodeValue: value,
    getAttribute: () => null,
  };
}

function el(tag: string, ...children: TestNode[]): TestNode {
  const node: TestNode = {
    nodeType: ELEMENT_NODE,
    parentNode: null,
    childNodes: children,
    children: children.filter((c) => c.nodeType === ELEMENT_NODE),
    nodeValue: null,
    getAttribute: () => null,
  };
  for (const child of children) child.parentNode = node;
  return node;
}

describe("epubCfi", function () {
  describe("spineBase and epubSortIndex", function () {
    it("doubles element and itemref indices, one-based", function () {
      // Package: metadata(0) manifest(1) spine(2) -> /6; itemref 5 -> /12.
      expect(spineBase(2, 5)).to.equal("/6/12");
      expect(spineBase(2, 0)).to.equal("/6/2");
    });

    it("zero-pads the two-part EPUB sort index", function () {
      expect(epubSortIndex(5, 17)).to.equal("00005|00000017");
      expect(epubSortIndex(0, 0)).to.equal("00000|00000000");
    });
  });

  describe("buildMatchCfi", function () {
    it("matches the CFI verified against Zotero's reader", function () {
      // <html><head/><body><section><p>This book is the successor edition…</p>
      // Body is element child 1 of html -> /4. section is /2. p is /26 when it
      // is the 13th element child; emulate with padding elements.
      const pad = () => el("span");
      const paragraph = el(
        "p",
        text("This book is the successor edition of FPGA"),
      );
      const before = Array.from({ length: 12 }, pad);
      const section = el("section", ...before, paragraph);
      const body = el("body", section);
      const head = el("head");
      el("html", head, body); // wires parents; html is implicit in the CFI

      const built = buildMatchCfi({
        spineElementChildIndex: 2,
        itemrefIndex: 5,
        textNode: paragraph.childNodes[0],
        offset: 17,
        length: "successor edition".length,
        charOffset: 17,
      });

      expect(built.pointCfi).to.equal("epubcfi(/6/12!/4/2/26/1:17)");
      expect(built.rangeCfi).to.equal("epubcfi(/6/12!/4/2/26,/1:17,/1:34)");
      expect(built.sortIndex).to.equal("00005|00000017");
    });

    it("counts whitespace text nodes when numbering the text step", function () {
      const target = text("beta");
      // Two text-node siblings before the target: it is the third text child,
      // index 2 -> step 2*2+1 = 5.
      const p = el("p", text("alpha"), el("b"), text(" "), target);
      const body = el("body", p);
      el("html", el("head"), body);

      const built = buildMatchCfi({
        spineElementChildIndex: 2,
        itemrefIndex: 0,
        textNode: target,
        offset: 0,
        length: 4,
        charOffset: 6,
      });

      // body /4, p /2, then text step /7 (index 3 among 4 text children: alpha,
      // "", " ", beta -> the empty ones come from filtering only text nodes).
      expect(built.pointCfi).to.match(/^epubcfi\(\/6\/2!\/4\/2\/\d+:0\)$/);
    });
  });

  describe("locateTextInSpine", function () {
    function spine(): EpubSpine {
      const p1 = el("p", text("the quick brown fox"));
      el("html", el("head"), el("body", p1));

      const p2 = el("p", text("a second document mentions the fox again"));
      el("html", el("head"), el("body", p2));

      return {
        spineElementChildIndex: 2,
        documents: [
          { index: 3, root: findHtml(p1) },
          { index: 4, root: findHtml(p2) },
        ],
      };
    }

    function findHtml(node: TestNode): TestNode {
      let current: TestNode = node;
      while (current.parentNode) current = current.parentNode;
      return current;
    }

    it("finds a unique match and builds its CFIs", function () {
      const matches = locateTextInSpine(spine(), "quick brown");
      expect(matches).to.have.length(1);
      expect(matches[0].spineIndex).to.equal(3);
      expect(matches[0].matchedText).to.equal("quick brown");
      expect(matches[0].pointCfi).to.match(/^epubcfi\(\/6\/8!/);
    });

    it("returns one match per containing text node for an ambiguous phrase", function () {
      const matches = locateTextInSpine(spine(), "fox");
      expect(matches.map((m) => m.spineIndex)).to.deep.equal([3, 4]);
    });

    it("returns nothing when the phrase is absent", function () {
      expect(locateTextInSpine(spine(), "not present")).to.have.length(0);
    });

    it("returns nothing for an empty target", function () {
      expect(locateTextInSpine(spine(), "")).to.have.length(0);
    });
  });
});
