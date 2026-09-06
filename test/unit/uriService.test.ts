import { expect } from "chai";
import {
  buildCollectionSelectUri,
  buildItemUris,
  buildOpenPdfUri,
  buildOpenUri,
  buildSelectUri,
} from "../../src/services/uriService";

describe("uriService", function () {
  it("builds a My Library select URI", function () {
    expect(buildSelectUri("ABCD1234")).to.equal(
      "zotero://select/library/items/ABCD1234",
    );
  });

  it("builds a collection select URI", function () {
    expect(buildCollectionSelectUri("MT53KB66")).to.equal(
      "zotero://select/library/collections/MT53KB66",
    );
  });

  it("never emits a groups/ path segment", function () {
    const uris = [
      buildSelectUri("ABCD1234"),
      buildCollectionSelectUri("MT53KB66"),
      buildOpenUri("EFGH5678"),
      buildOpenPdfUri("EFGH5678", { page: 3 }),
    ];
    for (const uri of uris) {
      expect(uri).to.not.include("/groups/");
      expect(uri).to.include("/library/");
    }
  });

  it("converts Zotero's 0-based pageIndex to a 1-based page parameter", function () {
    expect(buildOpenPdfUri("EFGH5678", { pageIndex: 0 })).to.equal(
      "zotero://open-pdf/library/items/EFGH5678?page=1",
    );
    expect(buildOpenPdfUri("EFGH5678", { pageIndex: 11 })).to.equal(
      "zotero://open-pdf/library/items/EFGH5678?page=12",
    );
  });

  it("passes an explicit 1-based page through unchanged", function () {
    expect(buildOpenPdfUri("EFGH5678", { page: 12 })).to.equal(
      "zotero://open-pdf/library/items/EFGH5678?page=12",
    );
  });

  it("omits a page parameter for a non-positive or absent page", function () {
    expect(buildOpenPdfUri("EFGH5678", { page: 0 })).to.equal(
      "zotero://open-pdf/library/items/EFGH5678",
    );
    expect(buildOpenPdfUri("EFGH5678")).to.equal(
      "zotero://open-pdf/library/items/EFGH5678",
    );
  });

  it("combines page and annotation parameters", function () {
    expect(
      buildOpenPdfUri("EFGH5678", { page: 12, annotationKey: "ANNO0001" }),
    ).to.equal(
      "zotero://open-pdf/library/items/EFGH5678?page=12&annotation=ANNO0001",
    );
  });

  it("gives a regular item only a select URI", function () {
    const uris = buildItemUris({ key: "ABCD1234", isAttachment: false });
    expect(uris.select).to.equal("zotero://select/library/items/ABCD1234");
    expect(uris.open).to.equal(undefined);
    expect(uris.openPdf).to.equal(undefined);
  });

  it("gives a PDF attachment select, open and open-pdf URIs", function () {
    const uris = buildItemUris({
      key: "EFGH5678",
      isAttachment: true,
      contentType: "application/pdf",
    });
    expect(uris.select).to.equal("zotero://select/library/items/EFGH5678");
    expect(uris.open).to.equal("zotero://open/library/items/EFGH5678");
    expect(uris.openPdf).to.equal("zotero://open-pdf/library/items/EFGH5678");
  });

  it("omits open-pdf for a non-PDF attachment", function () {
    const uris = buildItemUris({
      key: "EPUB0001",
      isAttachment: true,
      contentType: "application/epub+zip",
    });
    expect(uris.open).to.equal("zotero://open/library/items/EPUB0001");
    expect(uris.openPdf).to.equal(undefined);
  });
});
