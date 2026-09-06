import { expect } from "chai";
import { ReadService } from "../../src/services/readService";
import { htmlToText } from "../../src/services/readService";
import { FakeGateway } from "./fakeGateway";

/**
 * Zotero.Item stand-in. Only the surface ReadService touches is implemented, so
 * the tests exercise the shaping logic rather than Zotero.
 */
function fakeItem(overrides: Record<string, any> = {}): any {
  const fields: Record<string, string> = overrides.fields ?? {};
  return {
    key: overrides.key ?? "ABCD1234",
    id: overrides.id ?? 1,
    itemType: overrides.itemType ?? "journalArticle",
    libraryID: 1,
    attachmentContentType: overrides.attachmentContentType ?? null,
    attachmentFilename: overrides.attachmentFilename,
    attachmentLinkMode: overrides.attachmentLinkMode,
    isAttachment: () =>
      (overrides.itemType ?? "journalArticle") === "attachment",
    getField: (name: string) => {
      if (overrides.throwOnField === name) throw new Error("no such field");
      return fields[name] ?? "";
    },
    getCreators: () => overrides.creators ?? [],
    getTags: () => overrides.tags ?? [],
    getAttachments: () => overrides.attachmentIDs ?? [],
    getNotes: () => overrides.noteIDs ?? [],
    getAnnotations: () => overrides.annotations ?? [],
    getNote: () => overrides.note ?? "",
    toJSON: () => overrides.json ?? {},
  };
}

describe("readService", function () {
  let gateway: FakeGateway;
  let service: ReadService;

  beforeEach(function () {
    gateway = new FakeGateway();
    service = new ReadService(gateway);
  });

  describe("summaries", function () {
    it("shapes a title, creators, year and select URI", function () {
      const summary = service.summarize(
        fakeItem({
          fields: { title: "Attention Is All You Need", date: "2017-06-12" },
          creators: [{ lastName: "Vaswani" }, { lastName: "Shazeer" }],
        }),
      );

      expect(summary).to.deep.equal({
        key: "ABCD1234",
        itemType: "journalArticle",
        title: "Attention Is All You Need",
        creators: "Vaswani, Shazeer",
        year: "2017",
        uri: { select: "zotero://select/library/items/ABCD1234" },
      });
    });

    it("collapses four or more creators to et al.", function () {
      const summary = service.summarize(
        fakeItem({
          creators: [
            { lastName: "A" },
            { lastName: "B" },
            { lastName: "C" },
            { lastName: "D" },
          ],
        }),
      );
      expect(summary.creators).to.equal("A et al.");
    });

    it("falls back to (untitled) and survives a field a type lacks", function () {
      const summary = service.summarize(fakeItem({ throwOnField: "title" }));
      expect(summary.title).to.equal("(untitled)");
    });

    it("gives an attachment open and open-pdf URIs", function () {
      const summary = service.summarize(
        fakeItem({
          key: "EFGH5678",
          itemType: "attachment",
          attachmentContentType: "application/pdf",
        }),
      );
      expect(summary.uri.openPdf).to.equal(
        "zotero://open-pdf/library/items/EFGH5678",
      );
    });
  });

  describe("metadata", function () {
    it("uses Zotero's own JSON and drops internal or duplicated fields", function () {
      const metadata = service.metadata(
        fakeItem({
          json: {
            key: "ABCD1234",
            version: 12,
            itemType: "journalArticle",
            title: "A paper",
            DOI: "10.1000/x",
            abstractNote: "reported separately",
            tags: [{ tag: "x" }],
            collections: ["MT53KB66"],
            relations: {},
            extra: "",
          },
        }),
      );

      expect(metadata).to.deep.equal({ title: "A paper", DOI: "10.1000/x" });
    });
  });

  describe("sections", function () {
    it("returns only the requested sections", async function () {
      const result = await service.read(
        fakeItem({
          fields: { abstractNote: "An abstract." },
          tags: [{ tag: "ml" }, { tag: "nlp" }],
          json: { title: "A paper" },
        }),
        ["abstract", "tags"],
      );

      expect(result.abstract).to.equal("An abstract.");
      expect(result.tags).to.deep.equal(["ml", "nlp"]);
      expect(result.metadata).to.equal(undefined);
      expect(result.notes).to.equal(undefined);
    });

    it("reports a missing abstract as null rather than omitting it", async function () {
      const result = await service.read(fakeItem(), ["abstract"]);
      expect(result.abstract).to.equal(null);
    });

    it("always includes key, itemType and URI", async function () {
      const result = await service.read(fakeItem(), ["tags"]);
      expect(result.key).to.equal("ABCD1234");
      expect(result.uri.select).to.equal(
        "zotero://select/library/items/ABCD1234",
      );
    });
  });

  describe("attachments", function () {
    it("records content type, filename, link mode and on-disk path", async function () {
      gateway.attachmentPath = "/home/u/Zotero/storage/AAA/paper.pdf";
      const record = await service.attachmentRecord(
        fakeItem({
          key: "EFGH5678",
          itemType: "attachment",
          attachmentContentType: "application/pdf",
          attachmentFilename: "paper.pdf",
          attachmentLinkMode: 0,
          fields: { title: "Full Text PDF" },
        }),
      );

      expect(record).to.deep.equal({
        key: "EFGH5678",
        title: "Full Text PDF",
        contentType: "application/pdf",
        filename: "paper.pdf",
        path: "/home/u/Zotero/storage/AAA/paper.pdf",
        linkMode: "imported_file",
        uri: {
          select: "zotero://select/library/items/EFGH5678",
          open: "zotero://open/library/items/EFGH5678",
          openPdf: "zotero://open-pdf/library/items/EFGH5678",
        },
      });
    });

    it("reports a missing file as a null path, not an error", async function () {
      gateway.attachmentPath = null;
      const record = await service.attachmentRecord(
        fakeItem({ itemType: "attachment" }),
      );
      expect(record.path).to.equal(null);
    });
  });

  describe("notes", function () {
    it("converts note HTML to text and titles it from the first line", function () {
      const record = service.noteRecord(
        fakeItem({
          key: "NOTE0001",
          itemType: "note",
          note: "<div><h1>Key idea</h1><p>Attention scales.</p></div>",
        }),
        "ABCD1234",
      );

      expect(record.title).to.equal("Key idea");
      expect(record.text).to.equal("Key idea\nAttention scales.");
      expect(record.parentKey).to.equal("ABCD1234");
    });
  });

  describe("annotations", function () {
    it("links to the attachment at the annotation and converts the page", function () {
      const attachment = fakeItem({
        key: "EFGH5678",
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });
      const annotation = fakeItem({
        key: "ANNO0001",
        itemType: "annotation",
        tags: [{ tag: "important" }],
      });
      Object.assign(annotation, {
        annotationType: "highlight",
        annotationText: "a quoted sentence",
        annotationComment: "why it matters",
        annotationColor: "#ffd400",
        annotationPageLabel: "12",
        annotationPosition: JSON.stringify({ pageIndex: 11, rects: [] }),
      });

      const record = service.annotationRecord(annotation, attachment);

      expect(record.type).to.equal("highlight");
      expect(record.text).to.equal("a quoted sentence");
      expect(record.page).to.equal(12);
      expect(record.pageLabel).to.equal("12");
      expect(record.tags).to.deep.equal(["important"]);
      // The link must open the attachment, since an annotation is not openable.
      expect(record.uri.openPdf).to.equal(
        "zotero://open-pdf/library/items/EFGH5678?page=12&annotation=ANNO0001",
      );
    });

    it("omits the page when the stored position has none", function () {
      const attachment = fakeItem({ key: "EFGH5678", itemType: "attachment" });
      const annotation = fakeItem({ key: "ANNO0002" });
      Object.assign(annotation, {
        annotationType: "note",
        annotationPosition: "not json",
      });

      const record = service.annotationRecord(annotation, attachment);
      expect(record.page).to.equal(undefined);
    });
  });

  describe("htmlToText", function () {
    it("turns block tags into newlines and decodes entities", function () {
      expect(htmlToText("<p>a &amp; b</p><p>c<br>d</p>")).to.equal(
        "a & b\nc\nd",
      );
    });

    it("collapses runs of blank lines", function () {
      expect(htmlToText("<p>a</p><p></p><p></p><p>b</p>")).to.equal("a\n\nb");
    });
  });
});
