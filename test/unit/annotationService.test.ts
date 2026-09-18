import { expect } from "chai";
import {
  AnnotationService,
  buildSortIndex,
} from "../../src/services/annotationService";
import { ItemResolver } from "../../src/services/itemResolver";
import type { SdtNode, SdtReader } from "../../src/services/zoteroGateway";
import {
  ELEMENT_NODE,
  TEXT_NODE,
  type CfiDomNode,
  type EpubSpine,
} from "../../src/services/epubCfi";
import { FakeGateway } from "./fakeGateway";

function block(text: string, pageIndex: number, type = "paragraph"): SdtNode {
  return {
    type,
    anchor: { pageRects: [[pageIndex, 10, 20, 300, 40]] },
    content: [{ text }],
  };
}

function reader(blocks: SdtNode[]): SdtReader {
  return {
    async getMetadata() {
      return {};
    },
    async getCatalog() {
      return {};
    },
    getTopLevelBlockCount() {
      return blocks.length;
    },
    async getBlocks(start, end) {
      return blocks.slice(start, end + 1);
    },
    async getPageBlocks() {
      return blocks;
    },
  };
}

/** Builds an EPUB spine of one `html>body>p` document per paragraph string. */
function epubSpine(paragraphs: string[]): EpubSpine {
  const wrap = (nodeType: number, children: CfiDomNode[]): CfiDomNode => {
    const node: CfiDomNode = {
      nodeType,
      parentNode: null,
      childNodes: children,
      children: children.filter((c) => c.nodeType === ELEMENT_NODE),
      nodeValue: null,
      getAttribute: () => null,
    };
    for (const child of children)
      (child as { parentNode: CfiDomNode | null }).parentNode = node;
    return node;
  };
  const documents = paragraphs.map((value, index) => {
    const textNode: CfiDomNode = {
      nodeType: TEXT_NODE,
      parentNode: null,
      childNodes: [],
      nodeValue: value,
      getAttribute: () => null,
    };
    const p = wrap(ELEMENT_NODE, [textNode]);
    const body = wrap(ELEMENT_NODE, [p]);
    const html = wrap(ELEMENT_NODE, [wrap(ELEMENT_NODE, []), body]);
    return { index, root: html };
  });
  return { spineElementChildIndex: 2, documents };
}

describe("annotationService", function () {
  let gateway: FakeGateway;
  let service: AnnotationService;
  let pdf: Zotero.Item;

  beforeEach(function () {
    gateway = new FakeGateway();
    service = new AnnotationService(gateway, new ItemResolver(gateway));
    pdf = gateway.addItem({
      key: "EFGH5678",
      id: 5,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
    }) as unknown as Zotero.Item;
  });

  describe("highlight from text", function () {
    beforeEach(function () {
      gateway.sdtReader = reader([
        block("Attention is computed with a softmax over scores.", 0),
        block("We evaluate on eight A100 GPUs.", 3),
      ]);
    });

    it("highlights the block containing the quote and says the granularity", async function () {
      const created = await service.highlightText(pdf, {
        text: "softmax over scores",
        comment: "key step",
      });

      expect(created.type).to.equal("highlight");
      expect(created.page).to.equal(1);
      expect(created.granularity).to.equal("block");
      expect(created.note).to.include("paragraph containing");

      const saved = gateway.savedAnnotations[0].json;
      expect(saved.type).to.equal("highlight");
      expect((saved.position as any).pageIndex).to.equal(0);
      // Rects come from the block anchor, with the page index stripped.
      expect((saved.position as any).rects).to.deep.equal([[10, 20, 300, 40]]);
      expect(saved.comment).to.equal("key step");
    });

    it("links to the attachment at the annotation", async function () {
      const created = await service.highlightText(pdf, {
        text: "eight A100",
      });
      expect(created.uri.openPdf).to.equal(
        `zotero://open-pdf/library/items/EFGH5678?page=4&annotation=${created.key}`,
      );
    });

    it("matches across differing whitespace", async function () {
      const created = await service.highlightText(pdf, {
        text: "softmax   over\nscores",
      });
      expect(created.page).to.equal(1);
    });

    it("refuses text that appears more than once rather than guessing", async function () {
      gateway.sdtReader = reader([
        block("the same sentence here", 0),
        block("and the same sentence here too", 1),
      ]);

      let error: any;
      try {
        await service.highlightText(pdf, { text: "the same sentence here" });
      } catch (e) {
        error = e;
      }

      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include("2 places");
      expect(gateway.savedAnnotations).to.have.length(0);
    });

    it("refuses text it cannot find, phrased for a passage rather than a key", async function () {
      let error: any;
      try {
        await service.highlightText(pdf, { text: "not in the document" });
      } catch (e) {
        error = e;
      }

      expect(error?.code).to.equal("not_found");
      expect(error.message).to.include(
        'No text matching "not in the document"',
      );
      expect(error.message).to.include("EFGH5678");
      // The generic not-found template talks about keys, which reads as nonsense
      // when the thing being looked for is a quoted passage.
      expect(error.message).to.not.include("found for key");
      expect(gateway.savedAnnotations).to.have.length(0);
    });

    it("truncates a long quote in the error", async function () {
      let error: any;
      try {
        await service.highlightText(pdf, { text: "z".repeat(200) });
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include("…");
      expect(error.message.length).to.be.lessThan(240);
    });

    it("refuses a quote too short to place", async function () {
      let error: any;
      try {
        await service.highlightText(pdf, { text: "the" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include("four characters");
    });

    it("says to pass rects when no structured text exists", async function () {
      gateway.sdtReader = null;
      let error: any;
      try {
        await service.highlightText(pdf, { text: "anything at all" });
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include("rects");
    });

    it("keeps only the rects on the page the block starts on", async function () {
      gateway.sdtReader = reader([
        {
          type: "paragraph",
          anchor: {
            pageRects: [
              [0, 10, 20, 300, 40],
              [1, 10, 700, 300, 720],
            ],
          },
          content: [{ text: "a paragraph spanning two pages" }],
        },
      ]);

      await service.highlightText(pdf, { text: "spanning two pages" });

      const position = gateway.savedAnnotations[0].json.position as any;
      expect(position.pageIndex).to.equal(0);
      expect(position.rects).to.deep.equal([[10, 20, 300, 40]]);
    });
  });

  describe("highlight from text on an EPUB", function () {
    let epub: Zotero.Item;

    beforeEach(function () {
      epub = gateway.addItem({
        key: "EPUB0001",
        id: 6,
        itemType: "attachment",
        attachmentContentType: "application/epub+zip",
      }) as unknown as Zotero.Item;
    });

    it("places a character-exact CFI highlight and links to the annotation", async function () {
      gateway.epubSpine = epubSpine([
        "This book is the successor edition of FPGA prototyping.",
      ]);

      const created = await service.highlightText(epub, {
        text: "successor edition",
        comment: "note",
      });

      expect(created.type).to.equal("highlight");
      expect(created.granularity).to.equal("exact");
      expect(created.page).to.equal(undefined);

      const saved = gateway.savedAnnotations[0].json;
      const position = saved.position as any;
      expect(position.type).to.equal("FragmentSelector");
      expect(position.value).to.match(/^epubcfi\(.*,.*,.*\)$/);
      expect(String(saved.sortIndex)).to.match(/^\d{5}\|\d{8}$/);
      expect(saved.comment).to.equal("note");

      // EPUB annotations open via the annotation deep link, which works on the
      // plain open scheme.
      expect(created.uri.open).to.equal(
        `zotero://open/library/items/EPUB0001?annotation=${created.key}`,
      );
    });

    it("refuses text that appears more than once", async function () {
      gateway.epubSpine = epubSpine([
        "the same passage here",
        "and the same passage here again",
      ]);

      let error: any;
      try {
        await service.highlightText(epub, { text: "the same passage" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include("2 places");
      expect(gateway.savedAnnotations).to.have.length(0);
    });

    it("refuses text it cannot find", async function () {
      gateway.epubSpine = epubSpine(["nothing relevant here"]);

      let error: any;
      try {
        await service.highlightText(epub, { text: "absent passage" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("not_found");
      expect(gateway.savedAnnotations).to.have.length(0);
    });

    it("reports not found when the EPUB file cannot be read", async function () {
      gateway.epubSpine = null;

      let error: any;
      try {
        await service.highlightText(epub, { text: "any passage" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("not_found");
    });
  });

  describe("explicit rects", function () {
    it("creates an exact highlight", async function () {
      const created = await service.highlightRects(pdf, {
        page: 3,
        rects: [[10, 20, 30, 40]],
        text: "quoted",
      });

      expect(created.granularity).to.equal("exact");
      expect(created.note).to.equal(undefined);
      expect(
        (gateway.savedAnnotations[0].json.position as any).pageIndex,
      ).to.equal(2);
    });

    it("creates an area annotation as an image type", async function () {
      const created = await service.area(pdf, {
        page: 1,
        rects: [[0, 0, 100, 100]],
      });
      expect(created.type).to.equal("image");
      expect(gateway.savedAnnotations[0].json.type).to.equal("image");
    });

    it("requires exactly one rectangle for an area", async function () {
      let error: any;
      try {
        await service.area(pdf, {
          page: 1,
          rects: [
            [0, 0, 1, 1],
            [2, 2, 3, 3],
          ],
        });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include("exactly one");
    });

    it("rejects a 0-based page and malformed rects", async function () {
      for (const bad of [
        { page: 0, rects: [[0, 0, 1, 1]] },
        { page: 1, rects: [] },
        { page: 1, rects: [[0, 0, 1]] },
        { page: 1, rects: [["a", 0, 1, 1] as never] },
      ]) {
        let error: any;
        try {
          await service.highlightRects(pdf, bad as never);
        } catch (e) {
          error = e;
        }
        expect(error?.code, JSON.stringify(bad)).to.equal("invalid_argument");
      }
    });

    it("refuses a non-PDF attachment for an area annotation", async function () {
      const epub = gateway.addItem({
        key: "EPUB0001",
        itemType: "attachment",
        attachmentContentType: "application/epub+zip",
      }) as unknown as Zotero.Item;

      let error: any;
      try {
        await service.area(epub, { page: 1, rects: [[0, 0, 1, 1]] });
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include("epub");
    });

    it("refuses to highlight a non-document attachment", async function () {
      const png = gateway.addItem({
        key: "IMGX0001",
        itemType: "attachment",
        attachmentContentType: "image/png",
      }) as unknown as Zotero.Item;

      let error: any;
      try {
        await service.highlightRects(png, { page: 1, rects: [[0, 0, 1, 1]] });
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include("image/png");
    });
  });

  describe("update and delete", function () {
    let annotation: any;

    beforeEach(function () {
      annotation = gateway.addItem({
        key: "ANNO0001",
        id: 9,
        itemType: "annotation",
      });
    });

    it("updates comment, colour and tags with an undo label", async function () {
      const result = await service.update("ANNO0001", {
        comment: "new comment",
        color: "#a28ae5",
        tags: ["important"],
      });

      expect(result.changed).to.deep.equal(["comment", "color", "tags"]);
      expect(gateway.savedItems[0].saveOptions.undoAction).to.equal(
        "zotmcp-undo-edit-annotation",
      );
    });

    it("refuses an empty update", async function () {
      let error: any;
      try {
        await service.update("ANNO0001", {});
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });

    it("trashes an annotation with an undo label", async function () {
      const result = await service.remove("ANNO0001");
      expect(result.key).to.equal("ANNO0001");
      expect(gateway.trashedItems[0].saveOptions.undoAction).to.equal(
        "zotmcp-undo-trash",
      );
    });

    it("refuses a key that is not an annotation", async function () {
      gateway.addItem({ key: "ABCD1234", itemType: "journalArticle" });
      let error: any;
      try {
        await service.remove("ABCD1234");
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include("not an annotation");
      expect(annotation.key).to.equal("ANNO0001");
    });
  });

  describe("sort index", function () {
    it("formats pageIndex|offset|top zero-padded, as Zotero's reader does", function () {
      expect(buildSortIndex(11, [[10, 20, 300, 456.7]])).to.equal(
        "00011|000000|00456",
      );
    });

    it("handles a missing rect", function () {
      expect(buildSortIndex(0, [])).to.equal("00000|000000|00000");
    });
  });
});
