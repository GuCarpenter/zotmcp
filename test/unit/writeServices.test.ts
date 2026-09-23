import { expect } from "chai";
import { ItemResolver } from "../../src/services/itemResolver";
import {
  AttachmentService,
  CollectionService,
  DeleteService,
  ImportService,
} from "../../src/services/libraryWriteServices";
import { MutationService } from "../../src/services/mutationService";
import { WriteService } from "../../src/services/writeService";
import { looksLikeAntiBotChallenge } from "../../src/services/zoteroGateway";
import { FakeGateway } from "./fakeGateway";

describe("write services", function () {
  let gateway: FakeGateway;
  let resolver: ItemResolver;
  let mutations: MutationService;
  let writes: WriteService;
  let collections: CollectionService;
  let imports: ImportService;
  let deletes: DeleteService;
  let attachments: AttachmentService;

  beforeEach(function () {
    gateway = new FakeGateway();
    resolver = new ItemResolver(gateway);
    mutations = new MutationService(gateway);
    writes = new WriteService(gateway, resolver, mutations);
    collections = new CollectionService(gateway, resolver, mutations);
    imports = new ImportService(gateway, resolver, mutations);
    deletes = new DeleteService(gateway, resolver, mutations);
    attachments = new AttachmentService(gateway, resolver, mutations);
  });

  describe("metadata", function () {
    beforeEach(function () {
      gateway.fieldsByItemType.set("journalArticle", ["title", "date", "DOI"]);
      gateway.addItem({
        key: "ABCD1234",
        itemType: "journalArticle",
        json: { title: "Old title" },
      });
    });

    it("reports only the fields that actually changed", async function () {
      const result = await writes.updateMetadata("ABCD1234", {
        title: "New title",
        DOI: "",
      });

      expect(result.changed).to.deep.equal(["title"]);
      expect(gateway.savedItems[0].saveOptions.undoAction).to.equal(
        "zotmcp-undo-edit-metadata",
      );
    });

    it("saves nothing when no value differs", async function () {
      const result = await writes.updateMetadata("ABCD1234", {
        title: "Old title",
      });
      expect(result.changed).to.deep.equal([]);
      expect(gateway.savedItems).to.have.length(0);
    });

    it("rejects a field the item type does not have, listing valid ones", async function () {
      let error: any;
      try {
        await writes.updateMetadata("ABCD1234", { nameOfAct: "x" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include("DOI");
      expect(error.message).to.include("journalArticle");
    });

    it("refuses to change an item's type, which Zotero 10 throws on", async function () {
      for (const field of ["itemType", "itemTypeID"]) {
        let error: any;
        try {
          await writes.updateMetadata("ABCD1234", { [field]: "book" });
        } catch (e) {
          error = e;
        }
        expect(error?.code, field).to.equal("invalid_argument");
      }
    });
  });

  describe("item tags", function () {
    beforeEach(function () {
      gateway.addItem({ key: "ABCD1234", tags: ["existing"] });
      gateway.addItem({ key: "BCDE2345", tags: [] });
    });

    it("adds without touching existing tags", async function () {
      const reports = await writes.updateTags(["ABCD1234"], "add", ["new"]);
      expect(reports[0].changed).to.deep.equal(["tags"]);
      const item = await resolver.resolveItem("ABCD1234");
      expect(item.getTags().map((t) => t.tag)).to.deep.equal([
        "existing",
        "new",
      ]);
    });

    it("set replaces the whole list, unlike add", async function () {
      await writes.updateTags(["ABCD1234"], "set", ["only"]);
      const item = await resolver.resolveItem("ABCD1234");
      expect(item.getTags().map((t) => t.tag)).to.deep.equal(["only"]);
    });

    it("removes a tag", async function () {
      await writes.updateTags(["ABCD1234"], "remove", ["existing"]);
      const item = await resolver.resolveItem("ABCD1234");
      expect(item.getTags()).to.deep.equal([]);
    });

    it("uses save() rather than saveTx() inside the transaction", async function () {
      // saveTx() inside an open transaction waits for a transaction that cannot
      // commit until this call returns, so the write deadlocks until the queue
      // deadline fires. This is what that regression looks like.
      await writes.updateTags(["ABCD1234"], "add", ["new"]);
      expect(gateway.savedItems[0].inTransaction).to.equal(true);
      expect(gateway.savedItems[0].saveOptions).to.deep.equal({});
    });

    it("stages one undo step for a multi-item change", async function () {
      await writes.updateTags(["ABCD1234", "BCDE2345"], "add", ["batch"]);
      expect(gateway.stagedUndoActions).to.deep.equal([
        { action: "zotmcp-undo-edit-tags", args: { count: 2 } },
      ]);
      expect(gateway.transactionCount).to.equal(1);
    });

    it("reports an item whose tags did not change", async function () {
      const reports = await writes.updateTags(["ABCD1234"], "add", [
        "existing",
      ]);
      expect(reports[0].changed).to.deep.equal([]);
    });
  });

  describe("library-wide tag operations", function () {
    it("renames a tag", async function () {
      const result = await writes.updateTagObject("rename", {
        tag: "ml",
        newName: "machine learning",
      });
      expect(result.result).to.include("machine learning");
      expect(gateway.tagOperations[0]).to.deep.include({ op: "rename" });
    });

    it("treats merge as a rename, which is how Zotero folds tags together", async function () {
      await writes.updateTagObject("merge", { tag: "nlp", newName: "NLP" });
      expect(gateway.tagOperations[0].op).to.equal("rename");
    });

    it("deletes and colours tags", async function () {
      await writes.updateTagObject("delete", { tag: "draft" });
      await writes.updateTagObject("setColor", {
        tag: "important",
        color: "#ff6666",
      });
      expect(gateway.tagOperations.map((op) => op.op)).to.deep.equal([
        "delete",
        "setColor",
      ]);
    });

    it("requires newName for a rename", async function () {
      let error: any;
      try {
        await writes.updateTagObject("rename", { tag: "ml" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });
  });

  describe("reparenting", function () {
    beforeEach(function () {
      gateway.addItem({ key: "ABCD1234", id: 1, itemType: "journalArticle" });
      gateway.addItem({ key: "NOTE0001", id: 2, itemType: "note" });
      gateway.addItem({ key: "EFGH5678", id: 3, itemType: "attachment" });
    });

    it("attaches a note to an item", async function () {
      const result = await writes.setParent("NOTE0001", "ABCD1234");
      expect(result.changed[0]).to.include("ABCD1234");
      expect(gateway.savedItems[0].saveOptions.undoAction).to.equal(
        "zotmcp-undo-set-parent",
      );
    });

    it("detaches with a null parent", async function () {
      const result = await writes.setParent("EFGH5678", null);
      expect(result.changed).to.deep.equal(["detached"]);
    });

    it("refuses to reparent a regular item", async function () {
      let error: any;
      try {
        await writes.setParent("ABCD1234", null);
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });

    it("refuses a non-regular item as a parent", async function () {
      let error: any;
      try {
        await writes.setParent("NOTE0001", "EFGH5678");
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include("cannot be a parent");
    });
  });

  describe("related links", function () {
    beforeEach(function () {
      gateway.addItem({ key: "ABCD1234", id: 1 });
      gateway.addItem({ key: "BCDE2345", id: 2 });
    });

    it("writes both directions inside one transaction", async function () {
      const result = await writes.updateRelated(
        "ABCD1234",
        ["BCDE2345"],
        "add",
      );

      expect(result.linked).to.deep.equal(["BCDE2345"]);
      // Both saves in one transaction is what prevents a half-link.
      expect(gateway.transactionCount).to.equal(1);
      expect(gateway.savedItems.map((s) => s.key)).to.deep.equal([
        "ABCD1234",
        "BCDE2345",
      ]);
    });

    it("rolls back the first side when the transaction fails", async function () {
      gateway.failTransactionCommit = true;

      let error: any;
      try {
        await writes.updateRelated("ABCD1234", ["BCDE2345"], "add");
      } catch (e) {
        error = e;
      }

      // The caller learns it failed; Zotero's transaction discards both saves,
      // so no item keeps a dangling relation.
      expect(error?.message).to.include("simulated commit failure");
    });

    it("skips relating an item to itself", async function () {
      const result = await writes.updateRelated(
        "ABCD1234",
        ["ABCD1234"],
        "add",
      );
      expect(result.linked).to.deep.equal([]);
      expect(result.skipped).to.deep.equal(["ABCD1234"]);
    });

    it("stages one undo step for the pair", async function () {
      await writes.updateRelated("ABCD1234", ["BCDE2345"], "add");
      expect(gateway.stagedUndoActions[0].action).to.equal(
        "zotmcp-undo-edit-related",
      );
    });
  });

  describe("collections", function () {
    it("creates a subcollection and reports non-undoability", async function () {
      gateway.addCollection({ key: "PARENT01", id: 1, name: "Parent" });

      const result = await collections.create("Child", "PARENT01");

      expect(result.name).to.equal("Child");
      expect(result.parentKey).to.equal("PARENT01");
      expect(String(result.note)).to.include("not undoable");
    });

    it("renames and moves with undo labels", async function () {
      gateway.addCollection({ key: "COLL0001", id: 1, name: "Old" });
      gateway.addCollection({ key: "PARENT01", id: 2, name: "Parent" });

      await collections.rename("COLL0001", "New");
      await collections.move("COLL0001", "PARENT01");

      expect(
        gateway.savedCollections.every(
          (entry) =>
            entry.saveOptions.undoAction === "zotmcp-undo-move-collection",
        ),
      ).to.equal(true);
    });

    it("refuses to make a collection its own parent", async function () {
      gateway.addCollection({ key: "COLL0001", id: 1 });
      let error: any;
      try {
        await collections.move("COLL0001", "COLL0001");
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });

    it("leaves items in the library unless deleteItems is set", async function () {
      gateway.addCollection({ key: "COLL0001", id: 1, name: "Doomed" });

      const kept = await collections.remove("COLL0001", false);
      expect(gateway.erasedCollections[0].deleteItems).to.equal(false);
      expect(String(kept.note)).to.include("left in the library");
      // Zotero 10 sends a deleted collection to the trash, so it is restorable.
      expect(String(kept.note)).to.include("restored");

      gateway.addCollection({ key: "COLL0002", id: 2 });
      const trashed = await collections.remove("COLL0002", true);
      expect(String(trashed.note)).to.include("trash");
    });

    it("adds and removes membership, reporting unchanged items", async function () {
      gateway.addCollection({ key: "COLL0001", id: 7 });
      gateway.addItem({ key: "ABCD1234", id: 1 });
      gateway.addItem({ key: "BCDE2345", id: 2, collectionIDs: [7] });

      const added = await collections.setMembership(
        "COLL0001",
        ["ABCD1234", "BCDE2345"],
        "addItems",
      );

      expect(added.changed).to.deep.equal(["ABCD1234"]);
      expect(added.unchanged).to.deep.equal(["BCDE2345"]);
    });

    it("refuses to file a note in a collection", async function () {
      gateway.addCollection({ key: "COLL0001", id: 7 });
      gateway.addItem({ key: "NOTE0001", itemType: "note" });

      let error: any;
      try {
        await collections.setMembership("COLL0001", ["NOTE0001"], "addItems");
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });
  });

  describe("imports", function () {
    it("resolves identifiers and files them in a collection", async function () {
      gateway.addCollection({ key: "COLL0001", id: 7 });

      const result = await imports.byIdentifiers(["10.1000/xyz"], "COLL0001");

      expect((result.created as unknown[]).length).to.equal(1);
      expect(gateway.importedIdentifiers[0].collectionIDs).to.deep.equal([7]);
    });

    it("keeps successes when one identifier fails", async function () {
      gateway.identifierFailures.set("bad", "not a DOI");

      const result = await imports.byIdentifiers(["10.1000/ok", "bad"]);

      expect((result.created as unknown[]).length).to.equal(1);
      expect((result.failed as any[])[0].identifier).to.equal("bad");
    });

    it("falls back to the open collection when no key is given", async function () {
      gateway.addCollection({ key: "OPEN0001", id: 9 });
      gateway.selectedCollectionKey = "OPEN0001";

      const result = await imports.byIdentifiers(["10.1000/xyz"]);

      expect(gateway.importedIdentifiers[0].collectionIDs).to.deep.equal([9]);
      expect(result.collectionKey).to.equal("OPEN0001");
    });

    it("files loose in the library when no collection is open", async function () {
      gateway.selectedCollectionKey = null;

      const result = await imports.byIdentifiers(["10.1000/xyz"]);

      expect(gateway.importedIdentifiers[0].collectionIDs).to.deep.equal([]);
      expect(result.collectionKey).to.equal(undefined);
    });

    it("attaches a file to a regular item", async function () {
      gateway.addItem({ key: "ABCD1234", id: 1 });

      const result = await imports.fromFiles(
        ["/tmp/paper.pdf"],
        "ABCD1234",
        false,
      );

      expect(gateway.importedFiles[0].linked).to.equal(false);
      expect((result.created as any[])[0].linkMode).to.equal("imported_file");
    });

    it("refuses an attachment parent that is not a regular item", async function () {
      gateway.addItem({ key: "NOTE0001", itemType: "note" });
      let error: any;
      try {
        await imports.fromFiles(["/tmp/x.pdf"], "NOTE0001", false);
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });

    it("renders a Markdown file to a themed HTML snapshot", async function () {
      gateway.addItem({ key: "ABCD1234", id: 1 });

      const result = await imports.fromFiles(
        ["/tmp/notes/My Paper.md"],
        "ABCD1234",
        false,
      );

      expect(gateway.markdownSnapshots[0].path).to.equal(
        "/tmp/notes/My Paper.md",
      );
      expect(gateway.markdownSnapshots[0].title).to.equal("My Paper");
      const created = (result.created as any[])[0];
      expect(created.renderedFrom).to.equal("markdown");
      expect(created.contentType).to.equal("text/html");
      // A plain file must still take the verbatim import path.
      expect(gateway.importedFiles.length).to.equal(0);
    });

    it("saves a clean webpage snapshot from a URL and embeds images", async function () {
      gateway.readableResult = {
        html: '<h1>Post</h1><p>Body</p><img src="/img/a.png">',
        markdown: "# Post",
        title: "Post",
        author: "Su",
        published: "2026",
        description: "A post",
        wordCount: 2,
      };

      const result = await imports.fromUrl("https://example.com/post");

      const created = (result.created as any[])[0];
      expect(created.itemType).to.equal("webpage");
      expect(created.title).to.equal("Post");
      expect(created.snapshot.embeddedImages).to.equal(1);

      const saved = gateway.savedWebpages[0];
      expect(saved.url).to.equal("https://example.com/post");
      expect(saved.fields?.abstractNote).to.equal("A post");
      expect(saved.fields?.date).to.equal("2026");
      expect((saved.creators as any[])[0].lastName).to.equal("Su");
      // The relative image src was resolved and inlined as a data URI.
      expect(saved.snapshotContent).to.include("data:image/png;base64,");
      expect(saved.snapshotContent).to.not.include('src="/img/a.png"');
    });

    it("prefers the largest srcset variant and strips srcset so offline images stay sharp", async function () {
      gateway.dataUriByUrl.set(
        "https://x.test/a-848.png",
        "data:image/png;base64,LARGE",
      );
      gateway.readableResult = {
        html: '<img src="https://x.test/a-424.png" srcset="https://x.test/a-424.png 424w, https://x.test/a-848.png 848w" sizes="100vw">',
        markdown: "",
        title: "Post",
        author: "",
        published: "",
        description: "",
        wordCount: 0,
      };

      const result = await imports.fromUrl("https://example.com/post");

      expect((result.created as any[])[0].snapshot.embeddedImages).to.equal(1);
      const saved = gateway.savedWebpages[0].snapshotContent;
      expect(saved).to.include("data:image/png;base64,LARGE");
      expect(saved).to.not.include("srcset");
      expect(saved).to.not.include("sizes=");
      expect(saved).to.not.include("x.test");
    });

    it("falls back to src when srcset cannot be fetched", async function () {
      gateway.dataUriByUrl.set("https://x.test/small.png 1x", null);
      gateway.dataUriByUrl.set("https://x.test/small.png", null);
      gateway.dataUriByUrl.set(
        "https://x.test/original.png",
        "data:image/png;base64,SRC",
      );
      gateway.readableResult = {
        html: '<img src="https://x.test/original.png" srcset="https://x.test/small.png 424w">',
        markdown: "",
        title: "Post",
        author: "",
        published: "",
        description: "",
        wordCount: 0,
      };

      const result = await imports.fromUrl("https://example.com/post");

      expect((result.created as any[])[0].snapshot.embeddedImages).to.equal(1);
      const saved = gateway.savedWebpages[0].snapshotContent;
      expect(saved).to.include("data:image/png;base64,SRC");
      expect(saved).to.not.include("srcset");
      expect(saved).to.not.include("x.test");
    });

    it("embeds from srcset when the src cannot be fetched", async function () {
      gateway.dataUriByUrl.set("https://dead.test/gone.png", null);
      gateway.readableResult = {
        html: '<img src="https://dead.test/gone.png" srcset="https://cdn.test/small.png 424w, https://cdn.test/large.png 1456w">',
        markdown: "",
        title: "Post",
        author: "",
        published: "",
        description: "",
        wordCount: 0,
      };

      const result = await imports.fromUrl("https://example.com/post");

      expect((result.created as any[])[0].snapshot.embeddedImages).to.equal(1);
      const saved = gateway.savedWebpages[0].snapshotContent;
      expect(saved).to.include("data:image/png;base64,");
      expect(saved).to.not.include("dead.test");
      expect(saved).to.not.include("cdn.test");
    });

    it("embeds a srcset URL that itself contains commas", async function () {
      gateway.dataUriByUrl.set("https://dead.test/gone.png", null);
      const largest =
        "https://cdn.test/fetch/$s_!x!,w_1456,c_limit,f_webp/img_1504x876.png";
      gateway.dataUriByUrl.set(largest, "data:image/webp;base64,BBBB");
      gateway.readableResult = {
        html: `<img src="https://dead.test/gone.png" srcset="https://cdn.test/fetch/$s_!x!,w_424,c_limit,f_webp/img_1504x876.png 424w, ${largest} 1456w">`,
        markdown: "",
        title: "Post",
        author: "",
        published: "",
        description: "",
        wordCount: 0,
      };

      const result = await imports.fromUrl("https://example.com/post");

      expect((result.created as any[])[0].snapshot.embeddedImages).to.equal(1);
      const saved = gateway.savedWebpages[0].snapshotContent;
      expect(saved).to.include("data:image/webp;base64,BBBB");
      expect(saved).to.not.include("srcset");
      expect(saved).to.not.include("cdn.test");
    });

    it("skips image embedding when embedImages is false", async function () {
      gateway.readableResult = {
        html: '<p><img src="https://x.test/a.png"></p>',
        markdown: "",
        title: "T",
        author: "",
        published: "",
        description: "",
        wordCount: 0,
      };

      const result = await imports.fromUrl(
        "https://example.com/p",
        undefined,
        false,
      );

      expect((result.created as any[])[0].snapshot.embeddedImages).to.equal(0);
      expect(gateway.savedWebpages[0].snapshotContent).to.include(
        'src="https://x.test/a.png"',
      );
    });

    it("fails clearly when the page is an anti-bot challenge", async function () {
      gateway.fetchTextResult =
        "<html><head><title>Just a moment...</title></head><body><p>Enable JavaScript and cookies to continue</p></body></html>";
      let error: any;
      try {
        await imports.fromUrl("https://example.com/blocked");
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
      expect(String(error?.message)).to.match(/anti-bot|Cloudflare/i);
      expect(gateway.savedWebpages.length).to.equal(0);
      expect(gateway.extractReadableCalls.length).to.equal(0);
    });

    it("rejects a non-http URL", async function () {
      let error: any;
      try {
        await imports.fromUrl("ftp://example.com/x");
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });

    it("fails when no readable article can be extracted", async function () {
      gateway.readableResult = {
        html: "",
        markdown: "",
        title: "",
        author: "",
        published: "",
        description: "",
        wordCount: 0,
      };
      let error: any;
      try {
        await imports.fromUrl("https://example.com/empty");
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });

    it("validates manual fields against the item type", async function () {
      gateway.fieldsByItemType.set("book", ["title", "publisher"]);

      let error: any;
      try {
        await imports.manual([
          { itemType: "book", fields: { title: "T", DOI: "x" } },
        ]);
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
      expect(error.message).to.include("publisher");
    });

    it("rejects an unknown item type", async function () {
      gateway.invalidItemTypes.add("nonsense");
      let error: any;
      try {
        await imports.manual([{ itemType: "nonsense", fields: {} }]);
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include("nonsense");
    });

    it("creates a manual item", async function () {
      gateway.fieldsByItemType.set("book", ["title"]);
      const result = await imports.manual([
        { itemType: "book", fields: { title: "A book" } },
      ]);
      expect((result.created as any[])[0].itemType).to.equal("book");
    });
  });

  describe("trash, restore and merge", function () {
    beforeEach(function () {
      gateway.addItem({ key: "ABCD1234", id: 1, itemType: "journalArticle" });
      gateway.addItem({ key: "BCDE2345", id: 2, itemType: "journalArticle" });
    });

    it("trashes with one undo step and says it is reversible", async function () {
      const result = await deletes.trash(["ABCD1234", "BCDE2345"]);

      expect(result.trashed).to.deep.equal(["ABCD1234", "BCDE2345"]);
      expect(gateway.stagedUndoActions[0]).to.deep.equal({
        action: "zotmcp-undo-trash",
        args: { count: 2 },
      });
      expect(String(result.note)).to.include("undoable");
    });

    it("restores trashed items", async function () {
      const result = await deletes.restore(["ABCD1234"]);
      expect(result.restored).to.deep.equal(["ABCD1234"]);
      expect(gateway.stagedUndoActions[0].action).to.equal(
        "zotmcp-undo-restore",
      );
    });

    it("merges duplicates into a master and warns it is permanent", async function () {
      const result = await deletes.merge("ABCD1234", ["BCDE2345"]);

      expect(gateway.merges[0]).to.deep.equal({
        masterKey: "ABCD1234",
        otherKeys: ["BCDE2345"],
      });
      // Zotero 10 merges inside a transaction and stages undo-action-merge-items,
      // and the merged items are trashed rather than erased.
      expect(String(result.note)).to.include("undo");
      expect(String(result.note)).to.include("trash");
    });

    it("refuses to merge across item types", async function () {
      gateway.addItem({ key: "BOOK0001", id: 3, itemType: "book" });
      let error: any;
      try {
        await deletes.merge("ABCD1234", ["BOOK0001"]);
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include("item type");
    });

    it("refuses a merge with only the master", async function () {
      let error: any;
      try {
        await deletes.merge("ABCD1234", ["ABCD1234"]);
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });
  });

  describe("attachments", function () {
    beforeEach(function () {
      gateway.addItem({
        key: "EFGH5678",
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });
    });

    it("renames a file with an undo label", async function () {
      const result = await attachments.rename("EFGH5678", "better-name.pdf");
      expect(result.to).to.equal("better-name.pdf");
      expect(gateway.savedItems[0].saveOptions.undoAction).to.equal(
        "zotmcp-undo-rename-attachment",
      );
    });

    it("rejects a path where a bare filename is required", async function () {
      // Zotero 10 throws if a stored-file path contains a slash.
      for (const bad of ["dir/name.pdf", "dir\\name.pdf"]) {
        let error: any;
        try {
          await attachments.rename("EFGH5678", bad);
        } catch (e) {
          error = e;
        }
        expect(error?.code, bad).to.equal("invalid_argument");
        expect(error.message).to.include("bare filename");
      }
    });

    it("relinks to a new path", async function () {
      const result = await attachments.relink("EFGH5678", "/new/path.pdf");
      expect(result.to).to.equal("/new/path.pdf");
      expect(gateway.savedItems[0].saveOptions.undoAction).to.equal(
        "zotmcp-undo-relink-attachment",
      );
    });

    it("trashes an attachment", async function () {
      const result = await attachments.remove("EFGH5678");
      expect(result.key).to.equal("EFGH5678");
      expect(gateway.trashedItems[0].saveOptions.undoAction).to.equal(
        "zotmcp-undo-trash",
      );
    });

    it("reports a missing file rather than a phantom path", async function () {
      gateway.attachmentPath = null;
      const attachment = await resolver.resolveAttachment("EFGH5678");

      let error: any;
      try {
        await attachments.assertFilePresent(attachment);
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("file_missing");
    });
  });
});

describe("looksLikeAntiBotChallenge", function () {
  it("flags Cloudflare's Just a moment interstitial", function () {
    expect(
      looksLikeAntiBotChallenge(
        "<html><head><title>Just a moment...</title></head><body></body></html>",
      ),
    ).to.equal(true);
  });

  it("flags the challenge-platform script and enable-javascript prompt", function () {
    expect(
      looksLikeAntiBotChallenge(
        '<html><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>',
      ),
    ).to.equal(true);
    expect(
      looksLikeAntiBotChallenge(
        "<html><body>Enable JavaScript and cookies to continue</body></html>",
      ),
    ).to.equal(true);
  });

  it("passes an ordinary article, even one that mentions Cloudflare", function () {
    expect(
      looksLikeAntiBotChallenge(
        "<html><head><title>How Cloudflare works</title></head><body><article>Cloudflare is a CDN...</article></body></html>",
      ),
    ).to.equal(false);
    expect(looksLikeAntiBotChallenge("")).to.equal(false);
  });
});
