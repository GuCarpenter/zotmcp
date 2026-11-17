import { expect } from "chai";
import { createToolRegistry } from "../../src/tools";
import { createToolContext } from "../../src/services/toolContext";
import type { ToolContext } from "../../src/tools/registry";
import type { SdtNode, SdtReader } from "../../src/services/zoteroGateway";
import {
  ELEMENT_NODE,
  TEXT_NODE,
  type CfiDomNode,
  type EpubSpine,
} from "../../src/services/epubCfi";
import { FakeGateway } from "./fakeGateway";

function parse(result: { content: { type: string; text?: string }[] }): any {
  return JSON.parse(result.content[0].text ?? "");
}

/** Minimal EPUB spine (html > body > p > text) containing `phrase`. */
function epubSpineWith(phrase: string, spineIndex: number): EpubSpine {
  const textNode: CfiDomNode = {
    nodeType: TEXT_NODE,
    parentNode: null,
    childNodes: [],
    nodeValue: `intro ${phrase} outro`,
    getAttribute: () => null,
  };
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
  const p = wrap(ELEMENT_NODE, [textNode]);
  const body = wrap(ELEMENT_NODE, [p]);
  const head = wrap(ELEMENT_NODE, []);
  const html = wrap(ELEMENT_NODE, [head, body]);
  return {
    spineElementChildIndex: 2,
    documents: [{ index: spineIndex, root: html }],
  };
}

function reader(
  blocks: SdtNode[],
  catalog: Record<string, unknown>,
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

describe("read tools", function () {
  let gateway: FakeGateway;
  let ctx: ToolContext;
  let registry: ReturnType<typeof createToolRegistry>;

  beforeEach(function () {
    gateway = new FakeGateway();
    ctx = createToolContext(gateway);
    registry = createToolRegistry();
  });

  async function call(name: string, args: Record<string, unknown>) {
    return registry.get(name)!.handler(args, ctx);
  }

  describe("library_search", function () {
    it("returns item summaries with URIs and pagination metadata", async function () {
      gateway.addItem({ key: "ABCD1234", id: 1 });
      gateway.searchResults = [1];

      const payload = parse(
        await call("library_search", { query: "attention" }),
      );

      expect(payload.total).to.equal(1);
      expect(payload.returned).to.equal(1);
      expect(payload.limit).to.equal(25);
      expect(payload.items[0].uri.select).to.equal(
        "zotero://select/library/items/ABCD1234",
      );
    });

    it("attaches a snippet for a full-text hit", async function () {
      gateway.addItem({ key: "ABCD1234", id: 1, attachmentIDs: [2] });
      gateway.addItem({ key: "EFGH5678", id: 2, itemType: "attachment" });
      gateway.searchResults = [1];
      gateway.cacheText = "many words about gradient descent and more words";

      const payload = parse(
        await call("library_search", {
          mode: "fulltext",
          query: "gradient descent",
        }),
      );

      expect(payload.items[0].snippet).to.include("gradient descent");
      expect(payload.items[0].snippetFrom).to.equal("EFGH5678");
    });

    it("adds a CFI open link for a full-text hit in an EPUB", async function () {
      gateway.addItem({ key: "ABCD1234", id: 1, attachmentIDs: [2] });
      gateway.addItem({
        key: "EPUB0001",
        id: 2,
        itemType: "attachment",
        attachmentContentType: "application/epub+zip",
      });
      gateway.searchResults = [1];
      gateway.cacheText = "chapter text about gradient descent here";
      gateway.epubSpine = epubSpineWith("gradient descent", 3);

      const payload = parse(
        await call("library_search", {
          mode: "fulltext",
          query: "gradient descent",
        }),
      );

      expect(payload.items[0].snippetFrom).to.equal("EPUB0001");
      expect(payload.items[0].cfiUri).to.match(
        /^zotero:\/\/open\/library\/items\/EPUB0001\?cfi=epubcfi\(/,
      );
    });

    it("adds a page open link for a full-text hit in a PDF", async function () {
      gateway.addItem({ key: "ABCD1234", id: 1, attachmentIDs: [2] });
      gateway.addItem({
        key: "PDFX0001",
        id: 2,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });
      gateway.searchResults = [1];
      gateway.cacheText = "page three talks about gradient descent in depth";
      gateway.sdtReader = reader(
        [
          {
            type: "paragraph",
            anchor: { pageRects: [[2, 10, 20, 300, 40]] },
            content: [{ text: "a paragraph about gradient descent here" }],
          } as never,
        ],
        {},
      );

      const payload = parse(
        await call("library_search", {
          mode: "fulltext",
          query: "gradient descent",
        }),
      );

      expect(payload.items[0].snippetFrom).to.equal("PDFX0001");
      // pageRects page index 2 -> 1-based page 3.
      expect(payload.items[0].pageUri).to.equal(
        "zotero://open-pdf/library/items/PDFX0001?page=3",
      );
    });

    it("omits the item title for an annotation hit, whose text is the label", async function () {
      const annotation = gateway.addItem({
        key: "ANNO0001",
        id: 3,
        itemType: "annotation",
      });
      Object.assign(annotation, { annotationType: "highlight" });
      gateway.searchResults = [3];

      const payload = parse(
        await call("library_search", { mode: "annotation", query: "x" }),
      );

      expect(payload.items[0].key).to.equal("ANNO0001");
      expect(payload.items[0].title).to.equal(undefined);
    });

    it("lists collections with select URIs", async function () {
      gateway.addCollection({ key: "MT53KB66", name: "Transformers" });

      const payload = parse(
        await call("library_search", { entity: "collections" }),
      );

      expect(payload.collections[0].name).to.equal("Transformers");
      expect(payload.collections[0].uri.select).to.equal(
        "zotero://select/library/collections/MT53KB66",
      );
    });

    it("filters collections by name", async function () {
      gateway.addCollection({ key: "MT53KB66", name: "Transformers" });
      gateway.addCollection({ key: "AB53KB99", name: "Optimisers" });

      const payload = parse(
        await call("library_search", { entity: "collections", query: "trans" }),
      );

      expect(payload.collections.map((c: any) => c.name)).to.deep.equal([
        "Transformers",
      ]);
    });

    it("lists tags alphabetically", async function () {
      gateway.tags = [
        { tag: "nlp", type: 0 },
        { tag: "attention", type: 0 },
      ];

      const payload = parse(await call("library_search", { entity: "tags" }));

      expect(payload.tags).to.deep.equal(["attention", "nlp"]);
    });

    it("deduplicates a tag stored under both manual and automatic types", async function () {
      // Zotero keeps one row per tag type, so the same name comes back twice.
      gateway.tags = [
        { tag: "No DOI found", type: 0 },
        { tag: "No DOI found", type: 1 },
      ];

      const payload = parse(await call("library_search", { entity: "tags" }));

      expect(payload.tags).to.deep.equal(["No DOI found"]);
      expect(payload.total).to.equal(1);
    });

    it("rejects an unknown entity naming the value", async function () {
      let error: any;
      try {
        await call("library_search", { entity: "planets" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include("planets");
    });
  });

  describe("library_read", function () {
    it("defaults to metadata only", async function () {
      gateway.addItem({ key: "ABCD1234", json: { title: "A paper" } });

      const payload = parse(
        await call("library_read", { itemKey: "ABCD1234" }),
      );

      expect(payload.metadata.title).to.equal("A paper");
      expect(payload.tags).to.equal(undefined);
    });

    it("rejects an unknown section listing the valid ones", async function () {
      gateway.addItem({ key: "ABCD1234" });
      let error: any;
      try {
        await call("library_read", {
          itemKey: "ABCD1234",
          sections: ["nonsense"],
        });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include("annotations");
    });

    it("refuses a group-library item", async function () {
      gateway.addItem({ key: "GRUP0001", libraryID: 7 });
      let error: any;
      try {
        await call("library_read", { itemKey: "GRUP0001" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("group_library_unsupported");
    });
  });

  describe("paper_read", function () {
    beforeEach(function () {
      gateway.addItem({
        key: "EFGH5678",
        id: 5,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });
    });

    it("reads full text by default", async function () {
      gateway.sdtReader = reader(
        [{ type: "paragraph", content: [{ text: "body text" }] }],
        {},
      );

      const payload = parse(
        await call("paper_read", { attachmentKey: "EFGH5678" }),
      );

      expect(payload.mode).to.equal("fulltext");
      expect(payload.text).to.equal("body text");
      expect(payload.source).to.equal("sdt");
    });

    it("reads a page range", async function () {
      gateway.sdtReader = reader(
        [
          {
            type: "paragraph",
            anchor: { pageRects: [[0, 0, 0, 100, 10]] },
            content: [{ text: "one" }],
          },
          {
            type: "paragraph",
            anchor: { pageRects: [[1, 0, 0, 100, 10]] },
            content: [{ text: "two" }],
          },
        ],
        { pages: [{}, {}] },
      );

      const payload = parse(
        await call("paper_read", {
          attachmentKey: "EFGH5678",
          mode: "pages",
          pages: "2",
        }),
      );

      expect(payload.pages).to.deep.equal([{ pageNumber: 2, text: "two" }]);
      expect(payload.totalPages).to.equal(2);
    });

    it("returns a table of contents when includeText is false", async function () {
      gateway.sdtReader = reader(
        [
          { type: "heading", content: [{ text: "Intro" }] },
          { type: "paragraph", content: [{ text: "body" }] },
        ],
        { outline: [{ title: "Intro", ref: [0] }] },
      );

      const payload = parse(
        await call("paper_read", {
          attachmentKey: "EFGH5678",
          mode: "sections",
          includeText: false,
        }),
      );

      expect(payload.sections[0].title).to.equal("Intro");
      expect(payload.sections[0].text).to.equal(undefined);
    });

    it("passes a section selector and per-section cap through", async function () {
      gateway.sdtReader = reader(
        [
          { type: "heading", content: [{ text: "Intro" }] },
          { type: "paragraph", content: [{ text: "a".repeat(80) }] },
          { type: "heading", content: [{ text: "Method" }] },
          { type: "paragraph", content: [{ text: "b".repeat(80) }] },
        ],
        {
          outline: [
            { title: "Intro", ref: [0] },
            { title: "Method", ref: [2] },
          ],
        },
      );

      const payload = parse(
        await call("paper_read", {
          attachmentKey: "EFGH5678",
          mode: "sections",
          select: ["method"],
          perSectionMaxChars: 20,
        }),
      );

      expect(payload.sections).to.have.length(1);
      expect(payload.sections[0].title).to.equal("Method");
      expect(payload.sections[0].text).to.have.length(20);
      expect(payload.totalSections).to.equal(2);
    });

    it("rejects an unknown mode", async function () {
      let error: any;
      try {
        await call("paper_read", {
          attachmentKey: "EFGH5678",
          mode: "outline",
        });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include(
        "fulltext, pages, sections, clean, figures or tables",
      );
    });

    it("inventories figures with captions, pages and rects", async function () {
      gateway.sdtReader = reader(
        [
          {
            type: "image",
            anchor: { pageRects: [[3, 100, 600, 500, 750]] },
            content: [{ text: "chart furniture 0 1 2 3" }],
          },
          {
            type: "caption",
            anchor: { pageRects: [[3, 100, 560, 500, 595]] },
            content: [{ text: "Figure 2.1 The GFS architecture" }],
          },
          {
            type: "caption",
            anchor: { pageRects: [[4, 60, 700, 540, 730]] },
            content: [{ text: "Table 2.2 Workloads" }],
          },
          {
            type: "table",
            anchor: { pageRects: [[4, 60, 500, 540, 695]] },
            content: [{ text: "" }],
          },
          {
            type: "caption",
            anchor: { pageRects: [[5, 60, 100, 540, 130]] },
            content: [{ text: "Listing 5 A snippet, not a figure" }],
          },
        ],
        { pages: [{}, {}, {}, {}, {}, {}] },
      );

      const payload = parse(
        await call("paper_read", {
          attachmentKey: "EFGH5678",
          mode: "figures",
          padding: 0,
        }),
      );

      expect(payload.mode).to.equal("figures");
      expect(payload.total).to.equal(2);
      expect(payload.truncated).to.equal(false);
      expect(payload.figures).to.deep.equal([
        {
          label: "Figure 2.1 The GFS architecture",
          kind: "figure",
          number: "2.1",
          page: 4,
          rect: [100, 560, 500, 750],
          hasGraphic: true,
        },
        {
          label: "Table 2.2 Workloads",
          kind: "table",
          number: "2.2",
          page: 5,
          rect: [60, 500, 540, 730],
          hasGraphic: true,
        },
      ]);
    });

    it("defaults the figure inventory to a padded rect", async function () {
      gateway.sdtReader = reader(
        [
          {
            type: "image",
            anchor: { pageRects: [[3, 100, 600, 500, 750]] },
            content: [{ text: "" }],
          },
          {
            type: "caption",
            anchor: { pageRects: [[3, 100, 560, 500, 595]] },
            content: [{ text: "Figure 2.1 The GFS architecture" }],
          },
        ],
        { pages: [{}, {}, {}, {}] },
      );

      const payload = parse(
        await call("paper_read", {
          attachmentKey: "EFGH5678",
          mode: "figures",
        }),
      );

      expect(payload.figures[0].rect).to.deep.equal([94, 554, 506, 756]);
    });

    it("filters the inventory by page, kind and limit", async function () {
      const captions = [
        { page: 0, text: "Figure 1 One" },
        { page: 1, text: "Figure 2 Two" },
        { page: 2, text: "Table 3 Three" },
      ];
      const blocks: SdtNode[] = [];
      for (const c of captions) {
        blocks.push({
          type: "caption",
          anchor: { pageRects: [[c.page, 60, 360, 560, 395]] },
          content: [{ text: c.text }],
        });
      }
      gateway.sdtReader = reader(blocks, {
        pages: [{}, {}, {}, {}],
      });

      const onPage = parse(
        await call("paper_read", {
          attachmentKey: "EFGH5678",
          mode: "figures",
          page: 2,
        }),
      );
      expect(
        onPage.figures.map((f: { number: string }) => f.number),
      ).to.deep.equal(["2"]);

      const tables = parse(
        await call("paper_read", {
          attachmentKey: "EFGH5678",
          mode: "figures",
          only: "tables",
        }),
      );
      expect(
        tables.figures.map((f: { number: string }) => f.number),
      ).to.deep.equal(["3"]);

      const cut = parse(
        await call("paper_read", {
          attachmentKey: "EFGH5678",
          mode: "figures",
          limit: 2,
        }),
      );
      expect(cut.figures).to.have.length(2);
      expect(cut.total).to.equal(3);
      expect(cut.truncated).to.equal(true);
    });

    it("rejects a bad filter value for the figure inventory", async function () {
      gateway.sdtReader = reader([], { pages: [{}] });

      for (const args of [{ only: "charts" }, { limit: 0 }, { page: 0 }]) {
        let error: any;
        try {
          await call("paper_read", {
            attachmentKey: "EFGH5678",
            mode: "figures",
            ...args,
          });
        } catch (e) {
          error = e;
        }
        expect(error?.code).to.equal("invalid_argument");
      }
    });

    it("inventories an EPUB's figures by spine document and image entry", async function () {
      gateway.addItem({
        key: "EPUBFIG1",
        id: 9,
        itemType: "attachment",
        attachmentContentType: "application/epub+zip",
      });
      gateway.epubFigures = [
        {
          label: "Figure 1.1 The pipeline",
          caption: "Figure 1.1 The pipeline",
          kind: "figure",
          number: "1.1",
          spineIndex: 4,
          href: "OEBPS/ch01.xhtml",
          imageEntry: "OEBPS/images/fig1-1.png",
        },
        {
          label: "Table 2.3 Results",
          caption: "Table 2.3 Results",
          kind: "table",
          number: "2.3",
          spineIndex: 9,
          href: "OEBPS/ch02.xhtml",
          imageEntry: null,
        },
      ];

      const payload = parse(
        await call("paper_read", {
          attachmentKey: "EPUBFIG1",
          mode: "figures",
        }),
      );

      expect(gateway.epubFigureListRequests).to.deep.equal(["EPUBFIG1"]);
      expect(payload.total).to.equal(2);
      expect(payload.figures[0]).to.deep.equal({
        label: "Figure 1.1 The pipeline",
        kind: "figure",
        number: "1.1",
        page: null,
        rect: null,
        hasGraphic: true,
        location: { spine: 4, href: "OEBPS/ch01.xhtml" },
        image: "OEBPS/images/fig1-1.png",
      });
      expect(payload.figures[1].hasGraphic).to.equal(false);
      expect(payload.note).to.equal(undefined);
    });

    it("filters and caps an EPUB figure list, and explains an empty one", async function () {
      gateway.addItem({
        key: "EPUBFIG1",
        id: 9,
        itemType: "attachment",
        attachmentContentType: "application/epub+zip",
      });
      gateway.epubFigures = [
        {
          label: "Figure 1",
          caption: "Figure 1",
          kind: "figure",
          number: "1",
          spineIndex: 1,
          href: "a.xhtml",
          imageEntry: null,
        },
        {
          label: "Figure 2",
          caption: "Figure 2",
          kind: "figure",
          number: "2",
          spineIndex: 2,
          href: "b.xhtml",
          imageEntry: null,
        },
      ];

      const tables = parse(
        await call("paper_read", {
          attachmentKey: "EPUBFIG1",
          mode: "figures",
          only: "tables",
        }),
      );
      expect(tables.total).to.equal(0);
      expect(tables.note).to.be.a("string");

      gateway.epubFigures = [];
      const empty = parse(
        await call("paper_read", {
          attachmentKey: "EPUBFIG1",
          mode: "figures",
        }),
      );
      expect(empty.total).to.equal(0);
      expect(empty.note).to.include("image_read");
    });

    it("inventories captioned tables and, on request, uncaptioned ones", async function () {
      gateway.sdtReader = reader(
        [
          {
            type: "caption",
            anchor: { pageRects: [[2, 60, 700, 540, 730]] },
            content: [{ text: "Table 2.1 Workload characteristics" }],
          },
          {
            type: "table",
            anchor: { pageRects: [[2, 60, 500, 540, 695]] },
            content: [{ text: "row load hit-rate" }],
          },
          {
            type: "caption",
            anchor: { pageRects: [[2, 60, 400, 540, 430]] },
            content: [{ text: "Figure 2.2 Not a table" }],
          },
          // An uncaptioned table further down the same page.
          {
            type: "table",
            anchor: { pageRects: [[3, 62, 300, 538, 420]] },
            content: [{ text: "col a col b 10 20 30 40 hit rate" }],
          },
          // Index-like terse block: too short to be a table.
          {
            type: "table",
            anchor: { pageRects: [[3, 62, 120, 200, 130]] },
            content: [{ text: "242" }],
          },
        ],
        { pages: [{}, {}, {}, {}] },
      );

      const labelled = parse(
        await call("paper_read", {
          attachmentKey: "EFGH5678",
          mode: "tables",
          padding: 0,
        }),
      );
      expect(labelled.total).to.equal(1);
      expect(labelled.captioned).to.equal(1);
      expect(labelled.tables[0]).to.deep.equal({
        label: "Table 2.1 Workload characteristics",
        number: "2.1",
        page: 3,
        rect: [60, 500, 540, 730],
        captioned: true,
        preview: "Table 2.1 Workload characteristics",
      });

      const full = parse(
        await call("paper_read", {
          attachmentKey: "EFGH5678",
          mode: "tables",
          padding: 0,
          includeUncaptioned: true,
        }),
      );
      expect(full.total).to.equal(2);
      expect(full.captioned).to.equal(1);
      expect(
        full.tables.map((t: { captioned: boolean }) => t.captioned),
      ).to.deep.equal([true, false]);
      expect(full.tables[1]).to.deep.equal({
        label: null,
        number: null,
        page: 4,
        rect: [62, 300, 538, 420],
        captioned: false,
        preview: "col a col b 10 20 30 40 hit rate",
      });
    });

    it("lists EPUB tables from the book's own captions", async function () {
      gateway.addItem({
        key: "EPUBTAB1",
        id: 11,
        itemType: "attachment",
        attachmentContentType: "application/epub+zip",
      });
      gateway.epubFigures = [
        {
          label: "Figure 1.1 A picture",
          caption: "Figure 1.1 A picture",
          kind: "figure",
          number: "1.1",
          spineIndex: 2,
          href: "a.xhtml",
          imageEntry: "a.png",
        },
        {
          label: "Table 2.1 Results",
          caption: "Table 2.1 Results",
          kind: "table",
          number: "2.1",
          spineIndex: 5,
          href: "b.xhtml",
          imageEntry: null,
        },
      ];

      const payload = parse(
        await call("paper_read", { attachmentKey: "EPUBTAB1", mode: "tables" }),
      );

      expect(payload.total).to.equal(1);
      expect(payload.tables[0]).to.deep.equal({
        label: "Table 2.1 Results",
        number: "2.1",
        page: null,
        rect: null,
        captioned: true,
        preview: "Table 2.1 Results",
        location: { spine: 5, href: "b.xhtml" },
        image: null,
      });
    });

    it("requires an attachment, not a regular item", async function () {
      gateway.addItem({ key: "ABCD1234", itemType: "journalArticle" });
      let error: any;
      try {
        await call("paper_read", { attachmentKey: "ABCD1234" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include("journalArticle");
    });
  });

  describe("reader_read", function () {
    it("returns closed status when no reader is active", async function () {
      const payload = parse(await call("reader_read", {}));
      expect(payload.open).to.equal(false);
      expect(payload.message).to.include("No reader is currently open");
    });

    it("returns reader details, location and selection for active reader", async function () {
      const item = gateway.addItem({
        key: "ATTC1234",
        id: 100,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });

      gateway.activeReader = {
        itemID: item.id,
        title: "Test PDF Document",
        type: "pdf",
        state: { pageIndex: 2, scale: "auto" },
        pageLabel: "3",
        totalPages: 25,
        selection: {
          type: "text",
          text: "gradient descent optimization",
          pageIndex: 2,
          pageLabel: "3",
        },
      };

      const payload = parse(await call("reader_read", {}));
      expect(payload.open).to.equal(true);
      expect(payload.reader.attachmentKey).to.equal("ATTC1234");
      expect(payload.reader.type).to.equal("pdf");
      expect(payload.location.pageIndex).to.equal(2);
      expect(payload.location.pageNumber).to.equal(3);
      expect(payload.location.pageLabel).to.equal("3");
      expect(payload.location.totalPages).to.equal(25);
      expect(payload.selection.text).to.equal("gradient descent optimization");
    });

    it("accepts attachmentKey parameter", async function () {
      const item = gateway.addItem({
        key: "ATTC5678",
        id: 200,
        itemType: "attachment",
      });

      gateway.openReaders = [
        {
          itemID: item.id,
          title: "Requested Document",
          type: "pdf",
          state: { pageIndex: 0 },
        },
      ];

      const payload = parse(
        await call("reader_read", { attachmentKey: "ATTC5678" }),
      );
      expect(payload.open).to.equal(true);
      expect(payload.reader.attachmentKey).to.equal("ATTC5678");
    });
  });
});
