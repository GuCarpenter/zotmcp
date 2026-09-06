import { expect } from "chai";
import { ItemResolver } from "../../src/services/itemResolver";
import {
  cutSnippet,
  MAX_LIMIT,
  SearchService,
} from "../../src/services/searchService";
import { FakeGateway, type RecordedCondition } from "./fakeGateway";

function names(conditions: RecordedCondition[]): string[] {
  return conditions.map((c) => c.condition);
}

function find(
  conditions: RecordedCondition[],
  condition: string,
): RecordedCondition | undefined {
  return conditions.find((c) => c.condition === condition);
}

describe("searchService", function () {
  let gateway: FakeGateway;
  let service: SearchService;

  beforeEach(function () {
    gateway = new FakeGateway();
    service = new SearchService(gateway, new ItemResolver(gateway));
  });

  describe("keyword mode", function () {
    it("uses the ranked metadata quicksearch", async function () {
      gateway.searchResults = [10, 11];
      const result = await service.run({ mode: "keyword", query: "attention" });

      expect(
        find(gateway.lastSearch, "quicksearch-titleCreatorYear"),
      ).to.deep.equal({
        condition: "quicksearch-titleCreatorYear",
        operator: "contains",
        value: "attention",
      });
      expect(result.itemIDs).to.deep.equal([10, 11]);
      expect(result.total).to.equal(2);
    });

    it("requires a query", async function () {
      let error: any;
      try {
        await service.run({ mode: "keyword" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });

    it("defaults to keyword mode", async function () {
      await service.run({ query: "x" });
      expect(names(gateway.lastSearch)).to.include(
        "quicksearch-titleCreatorYear",
      );
    });
  });

  describe("pagination", function () {
    beforeEach(function () {
      gateway.searchResults = Array.from({ length: 60 }, (_, i) => i + 1);
    });

    it("defaults to 25 results and reports the true total", async function () {
      const result = await service.run({ query: "x" });
      expect(result.itemIDs).to.have.length(25);
      expect(result.total).to.equal(60);
      expect(result.offset).to.equal(0);
    });

    it("caps the limit at 100", async function () {
      const result = await service.run({ query: "x", limit: 5000 });
      expect(result.limit).to.equal(MAX_LIMIT);
    });

    it("applies an offset", async function () {
      const result = await service.run({ query: "x", limit: 3, offset: 10 });
      expect(result.itemIDs).to.deep.equal([11, 12, 13]);
    });

    it("rejects a nonsense limit or offset naming the value", async function () {
      for (const bad of [{ limit: 0 }, { limit: -1 }, { offset: -5 }]) {
        let error: any;
        try {
          await service.run({ query: "x", ...bad });
        } catch (e) {
          error = e;
        }
        expect(error?.code, JSON.stringify(bad)).to.equal("invalid_argument");
      }
    });
  });

  describe("conditions mode", function () {
    it("wraps caller conditions in a group with the requested joinMode", async function () {
      await service.run({
        mode: "conditions",
        joinMode: "any",
        conditions: [
          { condition: "title", operator: "contains", value: "transformer" },
          { condition: "year", operator: "is", value: "2017" },
        ],
      });

      expect(names(gateway.lastSearch)).to.deep.equal([
        "groupStart",
        "joinMode",
        "title",
        "year",
        "groupEnd",
      ]);
      expect(find(gateway.lastSearch, "joinMode")!.operator).to.equal("any");
    });

    it("defaults joinMode to all", async function () {
      await service.run({
        mode: "conditions",
        conditions: [{ condition: "title", operator: "contains", value: "x" }],
      });
      expect(find(gateway.lastSearch, "joinMode")!.operator).to.equal("all");
    });

    it("never passes Zotero's legacy required argument", async function () {
      await service.run({
        mode: "conditions",
        conditions: [{ condition: "title", operator: "contains", value: "x" }],
      });
      // A fourth argument would throw in Zotero 10; the handle only accepts three.
      for (const recorded of gateway.lastSearch) {
        expect(Object.keys(recorded)).to.have.length.at.most(3);
      }
    });

    it("rejects an empty or malformed condition list", async function () {
      for (const bad of [
        { conditions: [] },
        { conditions: [{ operator: "is" } as any] },
        { conditions: [{ condition: "title" } as any] },
      ]) {
        let error: any;
        try {
          await service.run({ mode: "conditions", ...bad });
        } catch (e) {
          error = e;
        }
        expect(error?.code, JSON.stringify(bad)).to.equal("invalid_argument");
      }
    });
  });

  describe("tag mode", function () {
    it("ANDs plain terms", async function () {
      await service.run({ mode: "tag", query: "ml AND nlp" });
      const tags = gateway.lastSearch.filter((c) => c.condition === "tag");
      expect(tags.map((t) => [t.operator, t.value])).to.deep.equal([
        ["is", "ml"],
        ["is", "nlp"],
      ]);
      expect(find(gateway.lastSearch, "joinMode")!.operator).to.equal("all");
    });

    it("switches to joinMode any for an OR expression", async function () {
      await service.run({ mode: "tag", query: "ml OR nlp" });
      expect(find(gateway.lastSearch, "joinMode")!.operator).to.equal("any");
    });

    it("treats a leading - or NOT as isNot", async function () {
      await service.run({ mode: "tag", query: "-draft" });
      expect(find(gateway.lastSearch, "tag")!.operator).to.equal("isNot");

      await service.run({ mode: "tag", query: "NOT draft" });
      expect(find(gateway.lastSearch, "tag")).to.deep.equal({
        condition: "tag",
        operator: "isNot",
        value: "draft",
      });
    });
  });

  describe("citationKey mode", function () {
    it("uses Zotero's citationKey condition when available", async function () {
      const result = await service.run({
        mode: "citationKey",
        query: "vaswani2017",
      });
      expect(find(gateway.lastSearch, "citationKey")!.value).to.equal(
        "vaswani2017",
      );
      expect(result.note).to.equal(undefined);
    });

    it("falls back to Extra and says so when the condition is unavailable", async function () {
      gateway.rejectConditions.add("citationKey");

      const result = await service.run({
        mode: "citationKey",
        query: "vaswani2017",
      });

      expect(find(gateway.lastSearch, "extra")).to.deep.equal({
        condition: "extra",
        operator: "contains",
        value: "vaswani2017",
      });
      expect(result.note).to.include("Better BibTeX");
    });
  });

  describe("fulltext mode", function () {
    it("rolls attachment matches up to their item with resultLevel", async function () {
      await service.run({ mode: "fulltext", query: "gradient descent" });

      // Without resultLevel the matches would be attachments, and an item-level
      // caller would see nothing.
      expect(find(gateway.lastSearch, "resultLevel")!.operator).to.equal(
        "item",
      );
      expect(find(gateway.lastSearch, "fulltextContent")).to.deep.equal({
        condition: "fulltextContent",
        operator: "contains",
        value: "gradient descent",
      });
    });

    it("never uses the removed fulltextWord condition", async function () {
      await service.run({ mode: "fulltext", query: "x" });
      expect(names(gateway.lastSearch)).to.not.include("fulltextWord");
    });
  });

  describe("annotation mode", function () {
    it("returns annotations so page and colour survive", async function () {
      await service.run({ mode: "annotation", query: "important" });
      expect(find(gateway.lastSearch, "resultLevel")!.operator).to.equal(
        "annotation",
      );
      expect(find(gateway.lastSearch, "annotationText")!.value).to.equal(
        "important",
      );
    });

    it("accepts colour and comment filters as conditions", async function () {
      await service.run({
        mode: "annotation",
        conditions: [
          { condition: "annotationColor", operator: "is", value: "#ffd400" },
        ],
      });
      expect(find(gateway.lastSearch, "annotationColor")!.value).to.equal(
        "#ffd400",
      );
    });

    it("requires at least one filter", async function () {
      let error: any;
      try {
        await service.run({ mode: "annotation" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });
  });

  describe("scoping", function () {
    it("lists the trash only when asked", async function () {
      await service.run({ query: "x" });
      expect(names(gateway.lastSearch)).to.not.include("deleted");

      await service.run({ query: "x", deleted: true });
      expect(find(gateway.lastSearch, "deleted")).to.deep.equal({
        condition: "deleted",
        operator: "true",
        value: undefined,
      });
    });

    it("filters by item type", async function () {
      await service.run({ query: "x", itemType: "journalArticle" });
      expect(find(gateway.lastSearch, "itemType")!.value).to.equal(
        "journalArticle",
      );
    });

    it("scopes to a collection recursively", async function () {
      gateway.addCollection({ key: "MT53KB66" });
      await service.run({ query: "x", collectionKey: "MT53KB66" });
      expect(find(gateway.lastSearch, "collection")!.value).to.equal(
        "MT53KB66",
      );
      expect(find(gateway.lastSearch, "recursive")!.operator).to.equal("true");
    });

    it("refuses a collection from a group library", async function () {
      gateway.addCollection({ key: "GRUPCOLL", libraryID: 7 });
      let error: any;
      try {
        await service.run({ query: "x", collectionKey: "GRUPCOLL" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("group_library_unsupported");
    });

    it("rejects an unknown mode", async function () {
      let error: any;
      try {
        await service.run({ mode: "nonsense" as any, query: "x" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });
  });

  describe("snippets", function () {
    it("cuts context around the match with ellipses", function () {
      const text = `${"a".repeat(400)} gradient descent ${"b".repeat(400)}`;
      const snippet = cutSnippet(text, "gradient descent")!;
      expect(snippet).to.include("gradient descent");
      expect(snippet.startsWith("…")).to.equal(true);
      expect(snippet.endsWith("…")).to.equal(true);
      expect(snippet.length).to.be.lessThan(320);
    });

    it("collapses whitespace so a snippet stays one line", function () {
      expect(cutSnippet("alpha\n\n  beta   gamma", "beta")).to.equal(
        "alpha beta gamma",
      );
    });

    it("falls back to the longest word of a phrase", function () {
      expect(
        cutSnippet("about reproducibility here", "missing reproducibility"),
      ).to.include("reproducibility");
    });

    it("returns null when the text does not contain the query", function () {
      expect(cutSnippet("nothing relevant", "absent")).to.equal(null);
    });

    it("returns null rather than failing when no cache exists", async function () {
      gateway.cachePath = null;
      const attachment = gateway.addItem({
        key: "EFGH5678",
        itemType: "attachment",
      });
      const snippet = await service.snippetFor(
        attachment as unknown as Zotero.Item,
        "x",
      );
      expect(snippet).to.equal(null);
    });

    it("reads the cache file when one exists", async function () {
      gateway.cacheText = "some text about gradient descent in practice";
      const attachment = gateway.addItem({
        key: "EFGH5678",
        itemType: "attachment",
      });
      const snippet = await service.snippetFor(
        attachment as unknown as Zotero.Item,
        "gradient descent",
      );
      expect(snippet).to.include("gradient descent");
    });
  });
});
