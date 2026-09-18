import { expect } from "chai";
import { ImageService } from "../../src/services/imageService";
import { FigureLocator } from "../../src/services/figureLocator";
import { ItemResolver } from "../../src/services/itemResolver";
import type { SdtNode, SdtReader } from "../../src/services/zoteroGateway";
import { FakeGateway } from "./fakeGateway";

/** Marks an item as an image/ink annotation the way Zotero exposes it. */
function asAnnotation(item: { key: string }, annotationType: string): void {
  (item as Record<string, unknown>).annotationType = annotationType;
}

/** A top-level SDT block with one page rect. */
function block(
  type: string,
  text: string,
  rect: [number, number, number, number, number],
): SdtNode {
  return { type, content: [{ text }], anchor: { pageRects: [rect] } };
}

/** Minimal SDT reader over a flat list of top-level blocks. */
function sdtReader(blocks: SdtNode[]): SdtReader {
  return {
    async getMetadata() {
      return {};
    },
    async getCatalog() {
      return {};
    },
    getTopLevelBlockCount() {
      return blocks.length;
    },
    async getBlocks(start, end) {
      return blocks.slice(start, end + 1);
    },
    async getPageBlocks() {
      return blocks;
    },
  };
}

describe("imageService", function () {
  let gateway: FakeGateway;
  let service: ImageService;

  beforeEach(function () {
    gateway = new FakeGateway();
    service = new ImageService(
      gateway,
      new ItemResolver(gateway),
      new FigureLocator(gateway),
    );
  });

  describe("annotation source", function () {
    it("returns the rendered image of an image annotation", async function () {
      const annotation = gateway.addItem({
        key: "ANNO0001",
        id: 9,
        itemType: "annotation",
      });
      asAnnotation(annotation, "image");
      gateway.annotationImage = "PNGBYTES";

      const result = await service.read({
        source: "annotation",
        annotationKey: "ANNO0001",
      });

      expect(result.source).to.equal("annotation");
      expect(result.annotationKey).to.equal("ANNO0001");
      expect(result.mimeType).to.equal("image/png");
      expect(result.base64).to.equal("PNGBYTES");
      expect(gateway.annotationRenders).to.deep.equal(["ANNO0001"]);
    });

    it("renders an ink annotation too", async function () {
      const annotation = gateway.addItem({
        key: "ANNO0002",
        id: 10,
        itemType: "annotation",
      });
      asAnnotation(annotation, "ink");
      gateway.annotationImage = "INKBYTES";

      const result = await service.read({
        source: "annotation",
        annotationKey: "ANNO0002",
      });
      expect(result.base64).to.equal("INKBYTES");
    });

    it("refuses a highlight annotation, which has no image", async function () {
      const annotation = gateway.addItem({
        key: "ANNO0003",
        id: 11,
        itemType: "annotation",
      });
      asAnnotation(annotation, "highlight");

      let error: Error | undefined;
      try {
        await service.read({ source: "annotation", annotationKey: "ANNO0003" });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).to.include("has no image");
      expect(gateway.annotationRenders).to.be.empty;
    });

    it("refuses an item that is not an annotation", async function () {
      gateway.addItem({ key: "ITEM0001", id: 12, itemType: "journalArticle" });

      let error: Error | undefined;
      try {
        await service.read({ source: "annotation", annotationKey: "ITEM0001" });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).to.include("is not an annotation");
    });

    it("reports a missing image when nothing could be rendered", async function () {
      const annotation = gateway.addItem({
        key: "ANNO0004",
        id: 13,
        itemType: "annotation",
      });
      asAnnotation(annotation, "image");
      gateway.annotationImage = null;

      let error: Error | undefined;
      try {
        await service.read({ source: "annotation", annotationKey: "ANNO0004" });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).to.match(/no file|does not exist/i);
    });
  });

  describe("attachment source", function () {
    it("returns an image attachment's bytes with its content type", async function () {
      gateway.addItem({
        key: "IMGA0001",
        id: 20,
        itemType: "attachment",
        attachmentContentType: "image/png",
      });
      gateway.attachmentPath = "/tmp/figure.png";
      gateway.binaryFile = { base64: "FILEBYTES", bytes: 1234 };

      const result = await service.read({
        source: "attachment",
        attachmentKey: "IMGA0001",
      });

      expect(result.source).to.equal("attachment");
      expect(result.mimeType).to.equal("image/png");
      expect(result.base64).to.equal("FILEBYTES");
      expect(result.bytes).to.equal(1234);
      expect(gateway.binaryReads[0].path).to.equal("/tmp/figure.png");
      expect(gateway.binaryReads[0].maxBytes).to.be.a("number");
    });

    it("refuses a non-image attachment", async function () {
      gateway.addItem({
        key: "PDFA0001",
        id: 21,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });

      let error: Error | undefined;
      try {
        await service.read({ source: "attachment", attachmentKey: "PDFA0001" });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).to.include("image attachment");
    });
  });

  describe("page source", function () {
    beforeEach(function () {
      gateway.addItem({
        key: "PDFP0001",
        id: 30,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });
      gateway.pageImage = {
        base64: "PAGEBYTES",
        mimeType: "image/png",
        width: 800,
        height: 1000,
      };
    });

    it("renders a 1-based page, opening a reader if needed", async function () {
      const result = await service.read({
        source: "page",
        attachmentKey: "PDFP0001",
        page: 3,
      });

      expect(result.source).to.equal("page");
      expect(result.page).to.equal(3);
      expect(result.width).to.equal(800);
      expect(result.height).to.equal(1000);
      expect(result.base64).to.equal("PAGEBYTES");
      expect(gateway.pageRenders).to.deep.equal([
        { itemID: 30, pageIndex: 2, openIfNeeded: true },
      ]);
    });

    it("refuses a non-PDF attachment", async function () {
      gateway.addItem({
        key: "IMGP0001",
        id: 31,
        itemType: "attachment",
        attachmentContentType: "image/png",
      });

      let error: Error | undefined;
      try {
        await service.read({
          source: "page",
          attachmentKey: "IMGP0001",
          page: 1,
        });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).to.include("PDF attachment");
    });

    it("refuses a non-positive page number", async function () {
      let error: Error | undefined;
      try {
        await service.read({
          source: "page",
          attachmentKey: "PDFP0001",
          page: 0,
        });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).to.include("1-based");
    });
  });

  describe("reader source", function () {
    it("captures the current viewport of the active reader", async function () {
      gateway.addItem({
        key: "PDFR0001",
        id: 40,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });
      gateway.activeReader = {
        itemID: 40,
        type: "pdf",
        title: "Doc",
        state: { pageIndex: 4 },
      } as never;
      gateway.viewportImage = {
        base64: "READERBYTES",
        mimeType: "image/png",
        width: 1448,
        height: 926,
      };

      const result = await service.read({ source: "reader" });

      expect(result.source).to.equal("reader");
      expect(result.attachmentKey).to.equal("PDFR0001");
      expect(result.page).to.equal(5);
      expect(result.width).to.equal(1448);
      expect(result.base64).to.equal("READERBYTES");
      expect(gateway.viewportCaptures).to.deep.equal([40]);
    });

    it("captures an EPUB reader viewport too", async function () {
      gateway.addItem({
        key: "EPUBR001",
        id: 41,
        itemType: "attachment",
        attachmentContentType: "application/epub+zip",
      });
      gateway.activeReader = {
        itemID: 41,
        type: "epub",
        title: "Book",
        state: {},
      } as never;
      gateway.viewportImage = {
        base64: "EPUBVIEW",
        mimeType: "image/png",
        width: 800,
        height: 1000,
      };

      const result = await service.read({ source: "reader" });
      expect(result.source).to.equal("reader");
      expect(result.attachmentKey).to.equal("EPUBR001");
      expect(result.base64).to.equal("EPUBVIEW");
      expect(gateway.viewportCaptures).to.deep.equal([41]);
    });

    it("errors when no reader is open", async function () {
      let error: Error | undefined;
      try {
        await service.read({ source: "reader" });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).to.include("No reader");
    });
  });

  describe("region source", function () {
    beforeEach(function () {
      gateway.addItem({
        key: "PDFRG001",
        id: 50,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });
      gateway.regionImage = {
        base64: "REGIONBYTES",
        mimeType: "image/png",
        width: 400,
        height: 190,
      };
    });

    it("crops an explicit page rectangle", async function () {
      const result = await service.read({
        source: "region",
        attachmentKey: "PDFRG001",
        page: 2,
        rect: [100, 560, 500, 750],
      });

      expect(result.source).to.equal("region");
      expect(result.page).to.equal(2);
      expect(result.rect).to.deep.equal([100, 560, 500, 750]);
      expect(result.base64).to.equal("REGIONBYTES");
      expect(gateway.regionRenders).to.deep.equal([
        {
          itemID: 50,
          pageIndex: 1,
          rect: [100, 560, 500, 750],
          openIfNeeded: true,
        },
      ]);
    });

    it("normalizes a rect given with swapped corners", async function () {
      const result = await service.read({
        source: "region",
        attachmentKey: "PDFRG001",
        page: 1,
        rect: [500, 750, 100, 560],
      });
      expect(result.rect).to.deep.equal([100, 560, 500, 750]);
    });

    it("refuses a rect that is not four numbers", async function () {
      let error: Error | undefined;
      try {
        await service.read({
          source: "region",
          attachmentKey: "PDFRG001",
          page: 1,
          rect: [1, 2, 3],
        });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).to.include("four finite numbers");
    });

    it("refuses a zero-area rect", async function () {
      let error: Error | undefined;
      try {
        await service.read({
          source: "region",
          attachmentKey: "PDFRG001",
          page: 1,
          rect: [10, 10, 10, 50],
        });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).to.include("zero area");
    });
  });

  describe("figure source", function () {
    beforeEach(function () {
      gateway.addItem({
        key: "PDFFG001",
        id: 60,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });
      gateway.regionImage = {
        base64: "FIGUREBYTES",
        mimeType: "image/png",
        width: 400,
        height: 200,
      };
    });

    it("locates a figure by label and crops the image plus caption", async function () {
      gateway.sdtReader = sdtReader([
        block("paragraph", "Some body text.", [1, 50, 50, 550, 120]),
        block("image", "", [1, 100, 600, 500, 750]),
        block(
          "caption",
          "Figure 1: The GFS architecture",
          [1, 100, 560, 500, 595],
        ),
      ]);

      const result = await service.read({
        source: "figure",
        attachmentKey: "PDFFG001",
        figure: "Figure 1",
      });

      expect(result.source).to.equal("figure");
      expect(result.page).to.equal(2);
      expect(result.label).to.include("Figure 1");
      expect(result.rect).to.deep.equal([100, 560, 500, 750]);
      expect(result.base64).to.equal("FIGUREBYTES");
      expect(gateway.regionRenders[0]).to.deep.include({
        itemID: 60,
        pageIndex: 1,
        openIfNeeded: true,
      });
      expect(gateway.regionRenders[0].rect).to.deep.equal([100, 560, 500, 750]);
    });

    it("matches abbreviated labels like 'Fig. 2'", async function () {
      gateway.sdtReader = sdtReader([
        block("image", "", [0, 40, 400, 560, 700]),
        block(
          "caption",
          "Fig. 2 Chunk replica placement",
          [0, 40, 360, 560, 395],
        ),
      ]);

      const result = await service.read({
        source: "figure",
        attachmentKey: "PDFFG001",
        figure: "Figure 2",
      });
      expect(result.page).to.equal(1);
      expect(result.rect).to.deep.equal([40, 360, 560, 700]);
    });

    it("locates a table by label", async function () {
      gateway.sdtReader = sdtReader([
        block(
          "caption",
          "Table 1: Workload characteristics",
          [2, 60, 700, 540, 730],
        ),
        block("table", "", [2, 60, 500, 540, 695]),
      ]);

      const result = await service.read({
        source: "figure",
        attachmentKey: "PDFFG001",
        figure: "Table 1",
      });
      expect(result.page).to.equal(3);
      expect(result.rect).to.deep.equal([60, 500, 540, 730]);
    });

    it("locates a vector chart tagged as a paragraph, not an image", async function () {
      gateway.sdtReader = sdtReader([
        block(
          "paragraph",
          "To calculate a single number to compare efficiency.",
          [4, 262, 640, 843, 680],
        ),
        block(
          "paragraph",
          "0 100 200 300 400 500 600 700 5000 10000 15000 Intel perf/Watt AMD perf/Watt 100% 90% 80%",
          [4, 123, 190, 791, 573],
        ),
        block(
          "caption",
          "Figure 5 Power-performance of two servers.",
          [4, 68, 107, 846, 161],
        ),
      ]);

      const result = await service.read({
        source: "figure",
        attachmentKey: "PDFFG001",
        figure: "Figure 5",
      });

      expect(result.page).to.equal(5);
      expect(result.rect).to.deep.equal([68, 107, 846, 573]);
      expect(gateway.regionRenders[0].rect).to.deep.equal([68, 107, 846, 573]);
    });

    it("does not sweep in a prose paragraph as figure media", async function () {
      gateway.sdtReader = sdtReader([
        block(
          "paragraph",
          "This paragraph is ordinary prose that should be ignored entirely.",
          [0, 60, 400, 560, 500],
        ),
        block(
          "caption",
          "Figure 9 Something with no adjacent graphic.",
          [0, 60, 360, 560, 395],
        ),
      ]);

      const result = await service.read({
        source: "figure",
        attachmentKey: "PDFFG001",
        figure: "Figure 9",
      });
      expect(result.rect).to.deep.equal([60, 360, 560, 395]);
    });

    it("errors when no layout model is available", async function () {
      gateway.sdtReader = null;

      let error: Error | undefined;
      try {
        await service.read({
          source: "figure",
          attachmentKey: "PDFFG001",
          figure: "Figure 1",
        });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).to.include("Could not locate");
    });

    it("extracts an embedded image from an EPUB figure", async function () {
      gateway.addItem({
        key: "EPUBFG01",
        id: 70,
        itemType: "attachment",
        attachmentContentType: "application/epub+zip",
      });
      gateway.epubFigureImage = {
        base64: "EPUBIMG",
        mimeType: "image/jpeg",
        entry: "OEBPS/Images/image00453.jpeg",
        label: "Figure 3.5",
      };

      const result = await service.read({
        source: "figure",
        attachmentKey: "EPUBFG01",
        figure: "Figure 3.5",
      });

      expect(result.source).to.equal("figure");
      expect(result.attachmentKey).to.equal("EPUBFG01");
      expect(result.mimeType).to.equal("image/jpeg");
      expect(result.base64).to.equal("EPUBIMG");
      expect(result.label).to.equal("Figure 3.5");
      expect(gateway.epubFigureRequests).to.deep.equal([
        { key: "EPUBFG01", label: "Figure 3.5" },
      ]);
    });

    it("errors when an EPUB figure label cannot be located", async function () {
      gateway.addItem({
        key: "EPUBFG02",
        id: 71,
        itemType: "attachment",
        attachmentContentType: "application/epub+zip",
      });
      gateway.epubFigureImage = null;

      let error: Error | undefined;
      try {
        await service.read({
          source: "figure",
          attachmentKey: "EPUBFG02",
          figure: "Figure 9.9",
        });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).to.include("Could not locate");
    });

    it("errors when the label is missing", async function () {
      let error: Error | undefined;
      try {
        await service.read({
          source: "figure",
          attachmentKey: "PDFFG001",
        });
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).to.include("label");
    });
  });

  it("refuses an unknown source", async function () {
    let error: Error | undefined;
    try {
      await service.read({ source: "bogus" as never });
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).to.include("Unknown source");
  });
});
