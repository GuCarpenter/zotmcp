import { expect } from "chai";
import { createToolRegistry } from "../../src/tools";
import { createToolContext } from "../../src/services/toolContext";
import type { ToolContext } from "../../src/tools/registry";
import type { SdtNode, SdtReader } from "../../src/services/zoteroGateway";
import { FakeGateway } from "./fakeGateway";

function parse(result: { content: { text: string }[] }): any {
  return JSON.parse(result.content[0].text);
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
      return blocks.filter((b) => b.anchor?.pageIndex === pageIndex);
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
            anchor: { pageIndex: 0 },
            content: [{ text: "one" }],
          },
          {
            type: "paragraph",
            anchor: { pageIndex: 1 },
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
      expect(error.message).to.include("fulltext, pages or sections");
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
});
