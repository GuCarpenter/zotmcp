import { expect } from "chai";
import { ItemResolver } from "../../src/services/itemResolver";
import {
  markdownToNoteHtml,
  noteHtmlToMarkdown,
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

  describe("noteHtmlToMarkdown", function () {
    it("round-trips headings, emphasis and lists", function () {
      const markdown = "# Title\n\n**bold** and *italic*\n\n- a\n- b";
      expect(noteHtmlToMarkdown(markdownToNoteHtml(markdown))).to.equal(
        markdown,
      );
    });

    it("strips Zotero's schema wrapper div", function () {
      const html =
        '<div data-schema-version="9"><h1>Key idea</h1><p>body</p></div>';
      expect(noteHtmlToMarkdown(html)).to.equal("# Key idea\n\nbody");
    });

    it("renders nested lists with indentation", function () {
      const html =
        "<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>";
      expect(noteHtmlToMarkdown(html)).to.equal("- a\n  - a1\n  - a2\n- b");
    });

    it("renders ordered lists, links and inline code", function () {
      const html =
        '<ol><li>see <a href="https://x.test">x</a></li><li>run <code>go</code></li></ol>';
      expect(noteHtmlToMarkdown(html)).to.equal(
        "1. see [x](https://x.test)\n2. run `go`",
      );
    });

    it("renders blockquotes and fenced code blocks", function () {
      expect(
        noteHtmlToMarkdown("<blockquote><p>quoted</p></blockquote>"),
      ).to.equal("> quoted");
      expect(
        noteHtmlToMarkdown("<pre><code>a = 1\nb = 2</code></pre>"),
      ).to.equal("```\na = 1\nb = 2\n```");
    });

    it("renders a GitHub-flavoured table", function () {
      const html =
        "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>";
      expect(noteHtmlToMarkdown(html)).to.equal(
        "| a | b |\n| --- | --- |\n| 1 | 2 |",
      );
    });

    it("returns an empty string for empty input", function () {
      expect(noteHtmlToMarkdown("")).to.equal("");
      expect(noteHtmlToMarkdown(undefined as never)).to.equal("");
    });

    it("links an embedded image by its attachment key", function () {
      const html =
        '<p><img alt="../_images/allreduce.png" data-attachment-key="DRZXJMJN" width="650" height="200"></p>';
      expect(noteHtmlToMarkdown(html)).to.equal(
        "![../_images/allreduce.png](zotero://select/library/items/DRZXJMJN)",
      );
    });

    it("keeps a plain image src when there is no attachment key", function () {
      const html = '<p><img src="https://x.test/a.png" alt="a"></p>';
      expect(noteHtmlToMarkdown(html)).to.equal("![a](https://x.test/a.png)");
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
