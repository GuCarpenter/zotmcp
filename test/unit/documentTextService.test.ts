import { expect } from "chai";
import {
  blocksToText,
  blockText,
  DocumentTextService,
  firstPageIndex,
  flattenOutline,
  matchesSelector,
  pageBlockResolver,
  parsePageRange,
  preferAuthoredOutline,
} from "../../src/services/documentTextService";
import type { SdtNode, SdtReader } from "../../src/services/zoteroGateway";
import { FakeGateway } from "./fakeGateway";

function heading(text: string, pageIndex = 0): SdtNode {
  return {
    type: "heading",
    anchor: { pageRects: [[pageIndex, 0, 0, 100, 10]] },
    content: [{ text }],
  };
}

function paragraph(text: string, pageIndex = 0): SdtNode {
  return {
    type: "paragraph",
    anchor: { pageRects: [[pageIndex, 0, 0, 100, 10]] },
    content: [{ text }],
  };
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
      return blocks.filter((b) => b.anchor?.pageRects?.[0]?.[0] === pageIndex);
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

  describe("section selectors", function () {
    it("matches a section number and its subsections", function () {
      expect(matchesSelector("3.1 Algorithm", "3.1")).to.equal(true);
      expect(matchesSelector("3.1.1 Forward pass", "3.1")).to.equal(true);
      expect(matchesSelector("3 Method", "3")).to.equal(true);
      expect(matchesSelector("3.2 Other", "3.1")).to.equal(false);
    });

    it("does not let a numeric selector match a different section that contains it", function () {
      // Substring matching made "3.1" match "2.3.1 Forward pass", a section from
      // a different chapter. Numeric selectors align with the leading number.
      expect(matchesSelector("2.3.1 Forward pass", "3.1")).to.equal(false);
      expect(matchesSelector("12.1 Later", "2.1")).to.equal(false);
    });

    it("matches words anywhere in a title, case-insensitively", function () {
      expect(matchesSelector("2 Background", "background")).to.equal(true);
      expect(matchesSelector("Related Work", "related")).to.equal(true);
      expect(matchesSelector("Conclusion", "background")).to.equal(false);
    });

    it("ignores an empty selector", function () {
      expect(matchesSelector("Anything", "   ")).to.equal(false);
    });
  });

  describe("page anchors", function () {
    it("reads the page index from the first page rect, Zotero's real shape", function () {
      expect(
        firstPageIndex({ anchor: { pageRects: [[4, 10, 20, 30, 40]] } }),
      ).to.equal(4);
    });

    it("inherits a page from a child block when the parent has no anchor", function () {
      expect(
        firstPageIndex({
          content: [{ anchor: { pageRects: [[2, 0, 0, 1, 1]] }, content: [] }],
        }),
      ).to.equal(2);
    });

    it("tolerates a bare pageIndex, should a producer emit one", function () {
      expect(firstPageIndex({ anchor: { pageIndex: 7 } })).to.equal(7);
    });

    it("returns undefined when nothing is anchored", function () {
      expect(firstPageIndex({ content: [{ text: "x" }] })).to.equal(undefined);
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

    it("drops entries with no block reference and no resolvable page", function () {
      expect(flattenOutline([{ title: "Dangling" }])).to.deep.equal([]);
    });

    it("keeps a page-anchored entry that has no block ref by resolving its page", function () {
      // PDF outline entries such as "Fallacies and Pitfalls" carry only a page
      // target. Without resolving the page they vanish from the outline.
      const flat = flattenOutline(
        [
          { title: "Putting It All Together", ref: [10] },
          {
            title: "Fallacies and Pitfalls",
            target: { position: { pageIndex: 5 } },
          },
          { title: "Concluding Remarks", ref: [30] },
        ],
        (pageIndex) => (pageIndex === 5 ? 20 : undefined),
      );

      expect(flat.map((f) => [f.title, f.blockIndex])).to.deep.equal([
        ["Putting It All Together", 10],
        ["Fallacies and Pitfalls", 20],
        ["Concluding Remarks", 30],
      ]);
      expect(flat[1].pageIndex).to.equal(5);
    });

    it("still drops a page-anchored entry the resolver cannot place", function () {
      expect(
        flattenOutline(
          [{ title: "Orphan", target: { position: { pageIndex: 9 } } }],
          () => undefined,
        ),
      ).to.deep.equal([]);
    });

    it("builds a page resolver from the catalogue's contentRange", function () {
      const resolve = pageBlockResolver({
        pages: [
          { contentRange: [[0], [4]] },
          { contentRange: [[5], [9]] },
          { contentRange: [[10], [14]] },
        ],
      });
      expect(resolve(0)).to.equal(0);
      expect(resolve(2)).to.equal(10);
      expect(resolve(7)).to.equal(undefined);
    });

    it("carries the entry's source through the flattened outline", function () {
      const flat = flattenOutline([
        { title: "Chapter", ref: [0], source: "native" },
        { title: "Stray heading", ref: [1], source: "detected" },
      ]);
      expect(flat.map((f) => [f.title, f.source])).to.deep.equal([
        ["Chapter", "native"],
        ["Stray heading", "detected"],
      ]);
    });
  });

  describe("preferring the authored outline", function () {
    it("keeps only native entries when any authored entry exists", function () {
      const kept = preferAuthoredOutline([
        { title: "Real", source: "native" },
        { title: "Guessed", source: "detected" },
        { title: "Also real", source: "native" },
      ]);
      expect(kept.map((e) => e.title)).to.deep.equal(["Real", "Also real"]);
    });

    it("leaves a purely detected outline untouched as a fallback", function () {
      const entries = [
        { title: "Guessed 1", source: "detected" },
        { title: "Guessed 2", source: "detected" },
      ];
      expect(preferAuthoredOutline(entries)).to.deep.equal(entries);
    });

    it("leaves an older sourceless outline untouched", function () {
      const entries: { title: string; source?: string }[] = [
        { title: "A" },
        { title: "B" },
      ];
      expect(preferAuthoredOutline(entries)).to.deep.equal(entries);
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

  describe("clean", function () {
    it("extracts a snapshot as Markdown with metadata", async function () {
      gateway.attachmentPath = "/home/u/Zotero/storage/AAA/page.html";
      gateway.cacheText = "<html><body><article>hi</article></body></html>";
      gateway.readableResult = {
        html: "<h1>Clean Title</h1><p>Body</p>",
        markdown: "# Clean Title\n\nBody",
        title: "Clean Title",
        author: "Jane",
        published: "2026",
        description: "desc",
        wordCount: 2,
      };

      const result = await service.clean(attachment(gateway, "text/html"));

      expect(result.source).to.equal("defuddle");
      expect(result.markdown).to.equal("# Clean Title\n\nBody");
      expect(result.title).to.equal("Clean Title");
      expect(result.author).to.equal("Jane");
      expect(result.truncated).to.equal(false);
      expect(gateway.extractReadableCalls[0].html).to.equal(gateway.cacheText);
    });

    it("caps the Markdown and reports truncation", async function () {
      gateway.readableResult = {
        html: "",
        markdown: "y".repeat(500),
        title: "",
        author: "",
        published: "",
        description: "",
        wordCount: 0,
      };

      const result = await service.clean(attachment(gateway, "text/html"), 100);

      expect(result.markdown).to.have.length(100);
      expect(result.truncated).to.equal(true);
      expect(result.totalChars).to.equal(500);
    });

    it("refuses a PDF, since Defuddle extracts web snapshots", async function () {
      let error: any;
      try {
        await service.clean(attachment(gateway, "application/pdf"));
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("unsupported_attachment");
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

    it("keeps an outline entry that is page-anchored with no block ref", async function () {
      // Mirrors a PDF like "2.7 Fallacies and Pitfalls" that the pack anchors by
      // page only. The page catalogue's contentRange places it in block order.
      const pagedBlocks = [
        heading("Putting It All Together", 0),
        paragraph("together body", 0),
        heading("Fallacies and Pitfalls", 1),
        paragraph("fallacies body", 1),
        heading("Concluding Remarks", 2),
        paragraph("remarks body", 2),
      ];
      gateway.sdtReader = fakeReader(pagedBlocks, {
        pages: [
          { contentRange: [[0], [1]] },
          { contentRange: [[2], [3]] },
          { contentRange: [[4], [5]] },
        ],
        outline: [
          { title: "Putting It All Together", ref: [0] },
          {
            title: "Fallacies and Pitfalls",
            target: { position: { pageIndex: 1 } },
          },
          { title: "Concluding Remarks", ref: [4] },
        ],
      });

      const result = await service.sections(attachment(gateway));

      expect(result.source).to.equal("sdt-outline");
      expect(result.sections.map((s) => s.title)).to.deep.equal([
        "Putting It All Together",
        "Fallacies and Pitfalls",
        "Concluding Remarks",
      ]);
      expect(result.sections[1].startPage).to.equal(2);
      expect(result.sections[1].text).to.equal("fallacies body");
    });

    it("drops heuristically detected entries when the outline is authored", async function () {
      // A pack merges the authored outline with detected headings. Only the
      // authored ones are the real table of contents.
      gateway.sdtReader = fakeReader(blocks, {
        pages: [{}, {}],
        outline: [
          { title: "Introduction", ref: [0], source: "native" },
          {
            title: "A bold line mistaken for a heading",
            ref: [1],
            source: "detected",
          },
          { title: "Method", ref: [2], source: "native" },
        ],
      });

      const result = await service.sections(attachment(gateway));

      expect(result.source).to.equal("sdt-outline");
      expect(result.sections.map((s) => s.title)).to.deep.equal([
        "Introduction",
        "Method",
      ]);
    });

    it("keeps detected entries when the pack has no authored outline", async function () {
      gateway.sdtReader = fakeReader(blocks, {
        pages: [{}, {}],
        outline: [
          { title: "Introduction", ref: [0], source: "detected" },
          { title: "Method", ref: [2], source: "detected" },
        ],
      });

      const result = await service.sections(attachment(gateway));

      expect(result.source).to.equal("sdt-outline");
      expect(result.sections.map((s) => s.title)).to.deep.equal([
        "Introduction",
        "Method",
      ]);
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

    it("derives a start page from the section's first block when the outline omits it", async function () {
      gateway.sdtReader = fakeReader(blocks, {
        pages: [{}, {}],
        // A PDF outline entry often carries no target position.
        outline: [{ title: "Method", ref: [2] }],
      });

      const result = await service.sections(attachment(gateway));

      expect(result.sections[0].startPage).to.equal(2);
    });

    it("still reports a start page when text is not requested", async function () {
      gateway.sdtReader = fakeReader(blocks, {
        pages: [{}, {}],
        outline: [{ title: "Method", ref: [2] }],
      });

      const result = await service.sections(attachment(gateway), {
        includeText: false,
      });

      expect(result.sections[0].startPage).to.equal(2);
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

    it("selects only matching sections, so earlier ones cost nothing", async function () {
      gateway.sdtReader = fakeReader(blocks, {
        pages: [{}, {}],
        outline: [
          { title: "Introduction", ref: [0] },
          { title: "Method", ref: [2] },
        ],
      });

      const result = await service.sections(attachment(gateway), {
        select: ["method"],
      });

      expect(result.sections.map((s) => s.title)).to.deep.equal(["Method"]);
      expect(result.sections[0].text).to.equal("method body");
      // The document still reports how many sections it has.
      expect(result.totalSections).to.equal(2);
    });

    it("matches a numeric selector including its subsections", async function () {
      gateway.sdtReader = fakeReader(
        [
          heading("3.1 Algorithm", 0),
          paragraph("algo", 0),
          heading("3.1.1 Forward pass", 0),
          paragraph("forward", 0),
          heading("3.2 Other", 1),
          paragraph("other", 1),
        ],
        {
          pages: [{}, {}],
          outline: [
            { title: "3.1 Algorithm", ref: [0] },
            { title: "3.1.1 Forward pass", ref: [2] },
            { title: "3.2 Other", ref: [4] },
          ],
        },
      );

      const result = await service.sections(attachment(gateway), {
        select: ["3.1"],
      });

      expect(result.sections.map((s) => s.title)).to.deep.equal([
        "3.1 Algorithm",
        "3.1.1 Forward pass",
      ]);
    });

    it("ends a selected section where the next one begins, selected or not", async function () {
      gateway.sdtReader = fakeReader(blocks, {
        outline: [
          { title: "Introduction", ref: [0] },
          { title: "Method", ref: [2] },
        ],
      });

      const result = await service.sections(attachment(gateway), {
        select: ["introduction"],
      });

      // Without the full span list, Introduction would swallow Method's text.
      expect(result.sections[0].text).to.equal("intro body");
    });

    it("reports a selector that matched nothing", async function () {
      gateway.sdtReader = fakeReader(blocks, {
        outline: [{ title: "Introduction", ref: [0] }],
      });

      const result = await service.sections(attachment(gateway), {
        select: ["conclusion"],
      });

      expect(result.unmatchedSelectors).to.deep.equal(["conclusion"]);
      expect(result.sections).to.deep.equal([]);
      expect(result.note).to.include("includeText false");
    });

    it("caps each section separately with perSectionMaxChars", async function () {
      gateway.sdtReader = fakeReader(
        [
          heading("A"),
          paragraph("x".repeat(300)),
          heading("B"),
          paragraph("y".repeat(300)),
        ],
        {
          outline: [
            { title: "A", ref: [0] },
            { title: "B", ref: [2] },
          ],
        },
      );

      const result = await service.sections(attachment(gateway), {
        perSectionMaxChars: 50,
      });

      // A long first section no longer starves the ones after it.
      expect((result.sections[0].text ?? "").length).to.equal(50);
      expect((result.sections[1].text ?? "").length).to.equal(50);
      expect(result.sections[0].truncated).to.equal(true);
      expect(result.sections[0].charCount).to.equal(300);
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
