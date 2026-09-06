import { expect } from "chai";
import { ItemResolver } from "../../src/services/itemResolver";
import {
  markdownToNoteHtml,
  NoteService,
} from "../../src/services/noteService";
import { FakeGateway } from "./fakeGateway";

describe("noteService", function () {
  let gateway: FakeGateway;
  let service: NoteService;

  beforeEach(function () {
    gateway = new FakeGateway();
    service = new NoteService(gateway, new ItemResolver(gateway));
  });

  describe("markdown conversion", function () {
    it("converts headings, emphasis and lists", function () {
      const html = markdownToNoteHtml(
        "# Title\n\n**bold** and *italic*\n\n- a\n- b",
      );
      expect(html).to.include("<h1>Title</h1>");
      expect(html).to.include("<strong>bold</strong>");
      expect(html).to.include("<li>a</li>");
    });

    it("keeps the content first so Zotero derives the right note title", function () {
      const html = markdownToNoteHtml("# Key idea\n\nbody");
      expect(html.startsWith("<h1>")).to.equal(true);
    });

    it("supports GitHub-flavoured tables", function () {
      const html = markdownToNoteHtml("| a | b |\n| - | - |\n| 1 | 2 |");
      expect(html).to.include("<table>");
    });
  });

  describe("create", function () {
    it("attaches a note to a regular item and reports non-undoability", async function () {
      gateway.addItem({ key: "ABCD1234" });

      const result = await service.create("# Key idea\n\nbody", "ABCD1234");

      expect(result.action).to.equal("create");
      expect(result.parentKey).to.equal("ABCD1234");
      expect(result.title).to.equal("Key idea");
      expect(result.note).to.include("not undoable");
      expect(gateway.createdNotes[0].parentKey).to.equal("ABCD1234");
    });

    it("creates a standalone note when no parent is given", async function () {
      const result = await service.create("standalone body");
      expect(result.parentKey).to.equal(undefined);
      expect(gateway.createdNotes[0].parentKey).to.equal(null);
    });

    it("refuses to attach a note to an attachment or another note", async function () {
      gateway.addItem({ key: "EFGH5678", itemType: "attachment" });
      gateway.addItem({ key: "NOTE0001", itemType: "note" });

      for (const key of ["EFGH5678", "NOTE0001"]) {
        let error: any;
        try {
          await service.create("body", key);
        } catch (e) {
          error = e;
        }
        expect(error?.code, key).to.equal("invalid_argument");
      }
    });

    it("requires non-empty content", async function () {
      for (const bad of ["", "   ", 42]) {
        let error: any;
        try {
          await service.create(bad as never);
        } catch (e) {
          error = e;
        }
        expect(error?.code, JSON.stringify(bad)).to.equal("invalid_argument");
      }
    });
  });

  describe("update and append", function () {
    beforeEach(function () {
      gateway.addItem({
        key: "NOTE0001",
        itemType: "note",
        note: "<p>original</p>",
      });
    });

    it("replaces content with an undo label", async function () {
      const result = await service.update("NOTE0001", "replacement");

      expect(result.action).to.equal("update");
      expect(gateway.savedItems[0].saveOptions.undoAction).to.equal(
        "zotmcp-undo-edit-note",
      );
    });

    it("appends after the existing content", async function () {
      const result = await service.append("NOTE0001", "added");

      expect(result.action).to.equal("append");
      expect(result.chars).to.be.greaterThan("<p>original</p>".length);
    });

    it("refuses a key that is not a note", async function () {
      gateway.addItem({ key: "ABCD1234", itemType: "journalArticle" });
      let error: any;
      try {
        await service.update("ABCD1234", "x");
      } catch (e) {
        error = e;
      }
      expect(error.message).to.include("not a note");
    });
  });
});
