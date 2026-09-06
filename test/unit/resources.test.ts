import { expect } from "chai";
import {
  buildCollectionTree,
  createResourceProvider,
} from "../../src/resources";
import { createToolContext } from "../../src/services/toolContext";
import { FakeGateway } from "./fakeGateway";

describe("resources", function () {
  let gateway: FakeGateway;

  beforeEach(function () {
    gateway = new FakeGateway();
  });

  describe("collection tree", function () {
    it("nests children under parents and sorts by name", function () {
      const tree = buildCollectionTree([
        { key: "PARENT01", name: "B parent" },
        { key: "CHILD001", name: "Z child", parentKey: "PARENT01" },
        { key: "CHILD002", name: "A child", parentKey: "PARENT01" },
        { key: "PARENT02", name: "A parent" },
      ]);

      expect(tree.map((node) => node.name)).to.deep.equal([
        "A parent",
        "B parent",
      ]);
      const parent = tree.find((node) => node.key === "PARENT01")!;
      expect(parent.children.map((node) => node.name)).to.deep.equal([
        "A child",
        "Z child",
      ]);
    });

    it("treats a collection whose parent is absent as a root", function () {
      const tree = buildCollectionTree([
        { key: "ORPHAN01", name: "Orphan", parentKey: "MISSING1" },
      ]);
      expect(tree).to.have.length(1);
    });

    it("attaches a select URI to every node", function () {
      const tree = buildCollectionTree([{ key: "COLL0001", name: "One" }]);
      expect(tree[0].uri).to.equal(
        "zotero://select/library/collections/COLL0001",
      );
    });
  });

  describe("read", function () {
    it("lists the three resource templates", async function () {
      const provider = createResourceProvider(createToolContext(gateway));
      const list = await provider.list();
      expect(list.map((entry: any) => entry.uri)).to.deep.equal([
        "zotero://collections",
        "zotero://items/{itemKey}",
        "zotero://collections/{collectionKey}/items",
      ]);
    });

    it("returns the collection tree", async function () {
      gateway.addCollection({ key: "COLL0001", name: "Papers" });
      const provider = createResourceProvider(createToolContext(gateway));

      const [content] = (await provider.read("zotero://collections")) as any[];
      const payload = JSON.parse(content.text);

      expect(content.mimeType).to.equal("application/json");
      expect(payload.collections[0].name).to.equal("Papers");
    });

    it("returns one item's metadata", async function () {
      gateway.addItem({ key: "ABCD1234", json: { title: "A paper" } });
      const provider = createResourceProvider(createToolContext(gateway));

      const [content] = (await provider.read(
        "zotero://items/ABCD1234",
      )) as any[];

      expect(JSON.parse(content.text).metadata.title).to.equal("A paper");
    });

    it("rejects an unknown URI, listing what is available", async function () {
      const provider = createResourceProvider(createToolContext(gateway));

      let error: any;
      try {
        await provider.read("zotero://nonsense");
      } catch (e) {
        error = e;
      }

      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include("zotero://collections");
    });

    it("refuses a group-library item behind a resource URI", async function () {
      gateway.addItem({ key: "GRUP0001", libraryID: 7 });
      const provider = createResourceProvider(createToolContext(gateway));

      let error: any;
      try {
        await provider.read("zotero://items/GRUP0001");
      } catch (e) {
        error = e;
      }

      expect(error?.code).to.equal("group_library_unsupported");
    });
  });
});
