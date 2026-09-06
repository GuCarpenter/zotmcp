import { expect } from "chai";
import {
  blocksToText,
  blockText,
  DocumentTextService,
  flattenOutline,
  parsePageRange,
} from "../../src/services/documentTextService";
import type { SdtNode, SdtReader } from "../../src/services/zoteroGateway";
import { FakeGateway } from "./fakeGateway";

function heading(text: string, pageIndex = 0): SdtNode {
  return { type: "heading", anchor: { pageIndex }, content: [{ text }] };
}

function paragraph(text: string, pageIndex = 0): SdtNode {
  return { type: "paragraph", anchor: { pageIndex }, content: [{ text }] };
}

/** Minimal stand-in for Zotero's SDT pack reader. */
function fakeReader(
  blocks: SdtNode[],
  catalog: Record<string, unknown> = {},
): SdtReader {
  return {
    async getMetadata() {
      return {};
    },
    async getCatalog() {
      return catalog as never;
    },
    getTopLevelBlockCount() {
      return blocks.length;
    },
    async getBlocks(start, end) {
      return blocks.slice(start, end + 1);
    },
    async getPageBlocks(pageIndex) {
      return blocks.filter((b) => b.anchor?.pageIndex === pageIndex);
    },
  };
}

function attachment(
  gateway: FakeGateway,
  contentType = "application/pdf",
): Zotero.Item {
  return gateway.addItem({
    key: "EFGH5678",
    itemType: "attachment",
    attachmentContentType: contentType,
  }) as unknown as Zotero.Item;
}

describe("documentTextService", function () {
  let gateway: FakeGateway;
  let service: DocumentTextService;

  beforeEach(function () {
    gateway = new FakeGateway();
    service = new DocumentTextService(gateway);
  });

  describe("block text", function () {
    it("concatenates text leaves without separators", function () {
      expect(
        blockText({ content: [{ text: "Hello " }, { text: "world" }] }),
      ).to.equal("Hello world");
    });

    it("joins nested blocks with newlines", function () {
      expect(
        blockText({
          content: [
            { content: [{ text: "one" }] },
            { content: [{ text: "two" }] },
          ],
        }),
      ).to.equal("one\ntwo");
    });

    it("separates top-level blocks with a blank line", function () {
      expect(blocksToText([paragraph("a"), paragraph("b")])).to.equal("a\n\nb");
    });
  });

  describe("outline flattening", function () {
    it("keeps nesting depth as the section level and sorts by block order", function () {
      const flat = flattenOutline([
        {
          title: "Introduction",
          ref: [0],
          target: { position: { pageIndex: 0 } },
          items: [{ title: "Background", ref: [2] }],
        },
        { title: "Method", ref: [8] },
      ]);

      expect(flat.map((f) => [f.title, f.level, f.blockIndex])).to.deep.equal([
        ["Introduction", 1, 0],
        ["Background", 2, 2],
        ["Method", 1, 8],
      ]);
      expect(flat[0].pageIndex).to.equal(0);
    });

    it("accepts children as well as items, since PDF and EPUB packs differ", function () {
      const flat = flattenOutline([
        { title: "Chapter", ref: [0], children: [{ title: "Part", ref: [1] }] },
      ]);
      expect(flat.map((f) => f.title)).to.deep.equal(["Chapter", "Part"]);
    });

    it("drops entries with no block reference", function () {
      expect(flattenOutline([{ title: "Dangling" }])).to.deep.equal([]);
    });
  });

  describe("page ranges", function () {
    it("defaults to every page", function () {
      expect(parsePageRange(undefined, 3)).to.deep.equal([1, 2, 3]);
    });

    it("parses single pages, ranges and lists", function () {
      expect(parsePageRange("2", 10)).to.deep.equal([2]);
      expect(parsePageRange("3-5", 10)).to.deep.equal([3, 4, 5]);
      expect(parsePageRange("1,4-5,9", 10)).to.deep.equal([1, 4, 5, 9]);
    });

    it("clips to the document length", function () {
      expect(parsePageRange("8-20", 10)).to.deep.equal([8, 9, 10]);
    });

    it("rejects a 0-based or descending range naming the input", function () {
      for (const bad of ["0", "5-2", "abc"]) {
        let error: any;
        try {
          parsePageRange(bad, 10);
        } catch (e) {
          error = e;
        }
        expect(error?.code, bad).to.equal("invalid_argument");
        expect(error.message).to.include(bad);
      }
    });

    it("errors when no requested page exists", function () {
      let error: any;
      try {
        parsePageRange("50", 10);
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include("10");
    });
  });

  describe("fulltext", function () {
    it("reads from the SDT pack when available", async function () {
      gateway.sdtReader = fakeReader([heading("Title"), paragraph("Body")]);
      const result = await service.fullText(attachment(gateway));

      expect(result.source).to.equal("sdt");
      expect(result.text).to.equal("Title\n\nBody");
      expect(result.truncated).to.equal(false);
    });

    it("works the same for an EPUB", async function () {
      gateway.sdtReader = fakeReader([paragraph("Chapter one")]);
      const result = await service.fullText(
        attachment(gateway, "application/epub+zip"),
      );
      expect(result.source).to.equal("sdt");
      expect(result.text).to.equal("Chapter one");
    });

    it("caps output and reports truncation", async function () {
      gateway.sdtReader = fakeReader([paragraph("x".repeat(500))]);
      const result = await service.fullText(attachment(gateway), 100);

      expect(result.text).to.have.length(100);
      expect(result.truncated).to.equal(true);
      expect(result.totalChars).to.equal(500);
    });

    it("falls back to raw PDF extraction and says structure is missing", async function () {
      gateway.sdtReader = null;
      gateway.pdfText = { text: "raw pdf text" };

      const result = await service.fullText(attachment(gateway));

      expect(result.source).to.equal("pdf-worker");
      expect(result.note).to.include("without section or page structure");
    });

    it("falls back to Zotero's cached text when the worker yields nothing", async function () {
      gateway.sdtReader = null;
      gateway.pdfText = null;
      gateway.cacheText = "cached text";

      const result = await service.fullText(attachment(gateway));

      expect(result.source).to.equal("fulltext-cache");
      expect(result.text).to.equal("cached text");
    });

    it("names a scanned PDF as the cause when nothing can be extracted", async function () {
      gateway.sdtReader = null;
      gateway.pdfText = null;
      gateway.cachePath = null;

      let error: any;
      try {
        await service.fullText(attachment(gateway));
      } catch (e) {
        error = e;
      }

      expect(error?.code).to.equal("no_text_layer");
      expect(error.message).to.include("scanned");
      expect(error.message).to.include("EFGH5678");
    });

    it("refuses an attachment that is not a document", async function () {
      let error: any;
      try {
        await service.fullText(attachment(gateway, "image/png"));
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("unsupported_attachment");
      expect(error.message).to.include("image/png");
    });
  });

  describe("pages", function () {
    beforeEach(function () {
      gateway.sdtReader = fakeReader(
        [
          paragraph("page one", 0),
          paragraph("page two", 1),
          paragraph("page three", 2),
        ],
        { pages: [{ label: "i" }, { label: "ii" }, {}] },
      );
    });

    it("returns 1-based pages with the document's own labels", async function () {
      const result = await service.pages(attachment(gateway), "1-2");

      expect(result.pages).to.deep.equal([
        { pageNumber: 1, label: "i", text: "page one" },
        { pageNumber: 2, label: "ii", text: "page two" },
      ]);
      expect(result.totalPages).to.equal(3);
    });

    it("omits a label the document does not provide", async function () {
      const result = await service.pages(attachment(gateway), "3");
      expect(result.pages[0].label).to.equal(undefined);
    });

    it("warns when pages are reading locations rather than physical pages", async function () {
      gateway.sdtReader = fakeReader([paragraph("loc", 0)], {
        pages: [{}],
        pageMappingType: "locations",
      });
      const result = await service.pages(attachment(gateway), "1");
      expect(result.note).to.include("no physical pages");
    });

    it("errors when the document has no page structure", async function () {
      gateway.sdtReader = fakeReader([paragraph("x")], { pages: [] });
      let error: any;
      try {
        await service.pages(attachment(gateway), "1");
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include("sections");
    });

    it("reports no text layer when no pack can be built", async function () {
      gateway.sdtReader = null;
      let error: any;
      try {
        await service.pages(attachment(gateway), "1");
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("no_text_layer");
    });
  });

  describe("sections", function () {
    let blocks: SdtNode[];

    beforeEach(function () {
      blocks = [
        heading("Introduction", 0),
        paragraph("intro body", 0),
        heading("Method", 1),
        paragraph("method body", 1),
      ];
    });

    it("prefers the pack outline and reports the start page", async function () {
      gateway.sdtReader = fakeReader(blocks, {
        pages: [{}, {}],
        outline: [
          {
            title: "Introduction",
            ref: [0],
            target: { position: { pageIndex: 0 } },
          },
          { title: "Method", ref: [2], target: { position: { pageIndex: 1 } } },
        ],
      });

      const result = await service.sections(attachment(gateway));

      expect(result.source).to.equal("sdt-outline");
      expect(result.sections.map((s) => s.title)).to.deep.equal([
        "Introduction",
        "Method",
      ]);
      expect(result.sections[0].startPage).to.equal(1);
      expect(result.sections[0].text).to.equal("intro body");
      expect(result.sections[1].text).to.equal("method body");
    });

    it("derives sections from heading blocks when there is no outline", async function () {
      gateway.sdtReader = fakeReader(blocks, { pages: [{}, {}] });

      const result = await service.sections(attachment(gateway));

      expect(result.source).to.equal("sdt-headings");
      expect(result.sections.map((s) => s.title)).to.deep.equal([
        "Introduction",
        "Method",
      ]);
      expect(result.sections[0].text).to.equal("intro body");
    });

    it("works for an EPUB, whose outline comes from its navigation document", async function () {
      gateway.sdtReader = fakeReader(
        [heading("Chapter 1"), paragraph("once upon a time")],
        { outline: [{ title: "Chapter 1", ref: [0] }] },
      );

      const result = await service.sections(
        attachment(gateway, "application/epub+zip"),
      );

      expect(result.sections).to.have.length(1);
      expect(result.sections[0].text).to.equal("once upon a time");
    });

    it("acts as a table of contents when text is not requested", async function () {
      gateway.sdtReader = fakeReader(blocks, {
        outline: [
          { title: "Introduction", ref: [0] },
          { title: "Method", ref: [2] },
        ],
      });

      const result = await service.sections(attachment(gateway), {
        includeText: false,
      });

      expect(result.sections.map((s) => s.text)).to.deep.equal([
        undefined,
        undefined,
      ]);
      expect(result.sections.map((s) => s.title)).to.deep.equal([
        "Introduction",
        "Method",
      ]);
    });

    it("does not repeat the heading inside its own section text", async function () {
      gateway.sdtReader = fakeReader(blocks, {
        outline: [{ title: "Introduction", ref: [0] }],
      });
      const result = await service.sections(attachment(gateway));
      expect(result.sections[0].text).to.not.include("Introduction");
    });

    it("reports honestly when a document has no sections at all", async function () {
      gateway.sdtReader = fakeReader([paragraph("just text")], {});
      const result = await service.sections(attachment(gateway));

      expect(result.sections).to.deep.equal([]);
      expect(result.note).to.include("no outline and no detected headings");
    });

    it("stops adding text at the character cap", async function () {
      gateway.sdtReader = fakeReader(
        [
          heading("A"),
          paragraph("x".repeat(200)),
          heading("B"),
          paragraph("y".repeat(200)),
        ],
        {
          outline: [
            { title: "A", ref: [0] },
            { title: "B", ref: [2] },
          ],
        },
      );

      const result = await service.sections(attachment(gateway), {
        maxChars: 50,
      });

      expect(result.truncated).to.equal(true);
      expect((result.sections[0].text ?? "").length).to.equal(50);
      expect(result.sections[1].text).to.equal(undefined);
    });
  });
});
