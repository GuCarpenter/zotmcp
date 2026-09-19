import { expect } from "chai";
import { ItemResolver } from "../../src/services/itemResolver";
import { ReaderService } from "../../src/services/readerService";
import type { SdtNode, SdtReader } from "../../src/services/zoteroGateway";
import { FakeGateway, GROUP_LIBRARY_ID } from "./fakeGateway";

function makeSdtReader(
  blocks: SdtNode[],
  catalog: Record<string, unknown> = {},
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

describe("readerService", function () {
  let gateway: FakeGateway;
  let resolver: ItemResolver;
  let service: ReaderService;

  beforeEach(function () {
    gateway = new FakeGateway();
    resolver = new ItemResolver(gateway);
    service = new ReaderService(gateway, resolver);
  });

  it("returns closed status when no reader is open in Zotero", async function () {
    const res = await service.getOpenReader();
    expect(res.open).to.equal(false);
    if (!res.open) {
      expect(res.message).to.include("No reader is currently open");
    }
  });

  it("returns reader info, location, text selection and context for active PDF reader", async function () {
    const parent = gateway.addItem({
      key: "BOOK0001",
      id: 1,
      itemType: "book",
    });
    const attachment = gateway.addItem({
      key: "PDFA0001",
      id: 2,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
      parentKey: parent.key,
    });
    // Set parentItemID on attachment
    (attachment as any).parentItemID = parent.id;

    gateway.sdtReader = makeSdtReader(
      [
        {
          type: "heading",
          text: "1. Introduction",
          anchor: { pageRects: [[0, 10, 10, 100, 20]] },
        },
        {
          type: "paragraph",
          text: "Deep neural networks have achieved remarkable success across diverse machine learning tasks.",
          anchor: { pageRects: [[0, 10, 30, 200, 50]] },
        },
        {
          type: "paragraph",
          text: "In this work, we propose a novel transformer architecture for sequence modeling.",
          anchor: { pageRects: [[0, 10, 60, 200, 80]] },
        },
      ],
      {
        outline: [
          {
            title: "1. Introduction",
            ref: [0],
            target: { position: { pageIndex: 0 } },
          },
        ],
      },
    );

    gateway.activeReader = {
      readerID: "inst_123",
      tabID: "tab_456",
      itemID: attachment.id,
      title: "Sample Paper",
      type: "pdf",
      readOnly: false,
      state: {
        pageIndex: 0,
        scale: "page-width",
        top: 150,
        left: 0,
        scrollMode: 0,
        spreadMode: 0,
      },
      pageLabel: "1",
      totalPages: 12,
      selection: {
        type: "text",
        text: "novel transformer architecture",
        pageIndex: 0,
        pageLabel: "1",
        position: { pageIndex: 0, rects: [[10, 60, 150, 70]] },
      },
    };

    const res = await service.getOpenReader();
    expect(res.open).to.equal(true);
    if (res.open) {
      expect(res.reader.attachmentKey).to.equal("PDFA0001");
      expect(res.reader.parentItemKey).to.equal("BOOK0001");
      expect(res.reader.title).to.equal("Sample Paper");
      expect(res.reader.type).to.equal("pdf");
      expect(res.reader.uri.select).to.equal(
        "zotero://select/library/items/PDFA0001",
      );
      expect(res.reader.uri.openPdf).to.include(
        "zotero://open-pdf/library/items/PDFA0001",
      );

      // Location
      expect(res.location.pageIndex).to.equal(0);
      expect(res.location.pageNumber).to.equal(1);
      expect(res.location.pageLabel).to.equal("1");
      expect(res.location.totalPages).to.equal(12);
      expect(res.location.scale).to.equal("page-width");

      // Selection
      expect(res.selection).to.not.be.null;
      expect(res.selection?.type).to.equal("text");
      expect(res.selection?.text).to.equal("novel transformer architecture");
      expect(res.selection?.pageIndex).to.equal(0);
      expect(res.selection?.pageNumber).to.equal(1);

      // Context
      expect(res.context).to.not.be.null;
      expect(res.context?.paragraph).to.include(
        "novel transformer architecture",
      );
      expect(res.context?.textBefore).to.equal("In this work, we propose a ");
      expect(res.context?.textAfter).to.equal(" for sequence modeling.");
      expect(res.context?.section?.title).to.equal("1. Introduction");
    }
  });

  it("returns section info and page snippet when there is no selection", async function () {
    const attachment = gateway.addItem({
      key: "PDFA0002",
      id: 10,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
    });

    gateway.sdtReader = makeSdtReader(
      [
        {
          type: "heading",
          text: "2. Related Work",
          anchor: { pageRects: [[1, 0, 0, 100, 20]] },
        },
        {
          type: "paragraph",
          text: "Previous research has explored various attention mechanisms in vision and NLP.",
          anchor: { pageRects: [[1, 0, 30, 200, 50]] },
        },
      ],
      {
        outline: [
          {
            title: "2. Related Work",
            ref: [0],
            target: { position: { pageIndex: 1 } },
          },
        ],
      },
    );

    gateway.activeReader = {
      itemID: attachment.id,
      title: "Attention Paper",
      type: "pdf",
      state: { pageIndex: 1 },
      pageLabel: "2",
      totalPages: 8,
      selection: null,
    };

    const res = await service.getOpenReader();
    expect(res.open).to.equal(true);
    if (res.open) {
      expect(res.selection).to.be.null;
      expect(res.location.pageNumber).to.equal(2);
      expect(res.context?.section?.title).to.equal("2. Related Work");
      expect(res.context?.pageTextSnippet).to.include(
        "Previous research has explored",
      );
    }
  });

  it("returns annotation selection when an existing annotation is clicked", async function () {
    const attachment = gateway.addItem({
      key: "PDFA0003",
      id: 20,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
    });

    gateway.activeReader = {
      itemID: attachment.id,
      title: "Annotated Paper",
      type: "pdf",
      state: { pageIndex: 3 },
      pageLabel: "4",
      selection: {
        type: "annotation",
        text: "key finding of the experiment",
        annotationKey: "ANNO9999",
        annotationType: "highlight",
        comment: "Check this later",
        color: "#ffd400",
        pageIndex: 3,
        pageLabel: "4",
        position: { pageIndex: 3, rects: [[10, 20, 80, 40]] },
      },
    };

    const res = await service.getOpenReader();
    expect(res.open).to.equal(true);
    if (res.open) {
      expect(res.selection?.type).to.equal("annotation");
      expect(res.selection?.annotationKey).to.equal("ANNO9999");
      expect(res.selection?.annotationType).to.equal("highlight");
      expect(res.selection?.comment).to.equal("Check this later");
      expect(res.selection?.color).to.equal("#ffd400");
      expect(res.selection?.text).to.equal("key finding of the experiment");
    }
  });

  it("handles EPUB reader with CFI location", async function () {
    const attachment = gateway.addItem({
      key: "EPUB0001",
      id: 30,
      itemType: "attachment",
      attachmentContentType: "application/epub+zip",
    });

    gateway.activeReader = {
      itemID: attachment.id,
      title: "An EPUB Book",
      type: "epub",
      state: {
        cfi: "epubcfi(/6/4[chapter-1]!/4/2/10)",
        scrollYPercent: 0.45,
      },
      selection: {
        type: "text",
        text: "The quick brown fox jumps over the lazy dog.",
      },
    };

    const res = await service.getOpenReader();
    expect(res.open).to.equal(true);
    if (res.open) {
      expect(res.reader.type).to.equal("epub");
      expect(res.location.cfi).to.equal("epubcfi(/6/4[chapter-1]!/4/2/10)");
      expect(res.location.scrollYPercent).to.equal(0.45);
      expect(res.selection?.text).to.include("The quick brown fox");
    }
  });

  it("inspects a specific attachmentKey when requested", async function () {
    const item1 = gateway.addItem({
      key: "PDFA0001",
      id: 1,
      itemType: "attachment",
    });
    const item2 = gateway.addItem({
      key: "PDFA0002",
      id: 2,
      itemType: "attachment",
    });

    gateway.openReaders = [
      { itemID: item1.id, title: "Reader 1", type: "pdf" },
      {
        itemID: item2.id,
        title: "Reader 2",
        type: "pdf",
        state: { pageIndex: 5 },
      },
    ];
    gateway.activeReader = gateway.openReaders[0];

    const res = await service.getOpenReader({ attachmentKey: "PDFA0002" });
    expect(res.open).to.equal(true);
    if (res.open) {
      expect(res.reader.attachmentKey).to.equal("PDFA0002");
      expect(res.location.pageIndex).to.equal(5);
    }
  });

  it("reports when a specifically requested attachmentKey is not open", async function () {
    const item1 = gateway.addItem({
      key: "PDFA0001",
      id: 1,
      itemType: "attachment",
    });
    gateway.addItem({
      key: "PDFA0002",
      id: 2,
      itemType: "attachment",
    });

    gateway.openReaders = [
      { itemID: item1.id, title: "Reader 1", type: "pdf" },
    ];
    gateway.activeReader = gateway.openReaders[0];

    const res = await service.getOpenReader({ attachmentKey: "PDFA0002" });
    expect(res.open).to.equal(false);
    if (!res.open) {
      expect(res.message).to.include(
        'Attachment "PDFA0002" is not currently open',
      );
      expect(res.openReaders).to.have.length(1);
      expect(res.openReaders?.[0].attachmentKey).to.equal("PDFA0001");
    }
  });

  it("refuses an attachment belonging to a group library", async function () {
    const groupItem = gateway.addItem({
      key: "GRP00001",
      id: 99,
      libraryID: GROUP_LIBRARY_ID,
      itemType: "attachment",
    });

    gateway.activeReader = {
      itemID: groupItem.id,
      title: "Group Paper",
      type: "pdf",
    };

    let error: any;
    try {
      await service.getOpenReader();
    } catch (e) {
      error = e;
    }
    expect(error?.code).to.equal("group_library_unsupported");
  });

  it("omits context when includeContext is false", async function () {
    const attachment = gateway.addItem({
      key: "PDFA0005",
      id: 50,
      itemType: "attachment",
    });

    gateway.activeReader = {
      itemID: attachment.id,
      title: "Paper",
      type: "pdf",
      state: { pageIndex: 2 },
      selection: { type: "text", text: "Some selected text" },
    };

    const res = await service.getOpenReader({ includeContext: false });
    expect(res.open).to.equal(true);
    if (res.open) {
      expect(res.context).to.be.null;
    }
  });

  it("rejects an invalid contextChars value", async function () {
    let error: any;
    try {
      await service.getOpenReader({ contextChars: -10 });
    } catch (e) {
      error = e;
    }
    expect(error?.code).to.equal("invalid_argument");
  });

  describe("navigate", function () {
    it("opens a PDF at a 1-based page and returns the reader state", async function () {
      const attachment = gateway.addItem({
        key: "PDFNAV01",
        id: 100,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });
      gateway.activeReader = {
        itemID: attachment.id,
        title: "Nav Paper",
        type: "pdf",
        state: { pageIndex: 4 },
      };

      const res = await service.navigate({
        attachmentKey: "PDFNAV01",
        page: 5,
      });

      expect(res.navigated).to.equal(true);
      expect(res.target.page).to.equal(5);
      expect(gateway.openReaderCalls).to.have.length(1);
      expect(gateway.openReaderCalls[0].itemID).to.equal(attachment.id);
      expect(gateway.openReaderCalls[0].location?.pageIndex).to.equal(4);
      expect(res.reader.open).to.equal(true);
    });

    it("polls until a freshly opened reader reports its location", async function () {
      const attachment = gateway.addItem({
        key: "PDFNAV07",
        id: 170,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });

      // Simulate an initially unsettled reader: empty state until pdf.js lays
      // out and applies the target page (pageIndex 6 for page 7).
      let reads = 0;
      (gateway as any).getActiveReader = (_id?: number) => {
        reads += 1;
        return {
          itemID: attachment.id,
          title: "Settling Paper",
          type: "pdf",
          state: reads >= 3 ? { pageIndex: 6 } : {},
        };
      };

      const res = await service.navigate({
        attachmentKey: "PDFNAV07",
        page: 7,
      });

      expect(res.reader.open).to.equal(true);
      if (res.reader.open) {
        expect(res.reader.location.pageIndex).to.equal(6);
      }
      expect(reads).to.be.greaterThan(2);
    });

    it("navigates to an EPUB CFI as a FragmentSelector position", async function () {
      gateway.addItem({
        key: "EPUBNAV1",
        id: 110,
        itemType: "attachment",
        attachmentContentType: "application/epub+zip",
      });

      const res = await service.navigate({
        attachmentKey: "EPUBNAV1",
        cfi: "epubcfi(/6/12!/4/2/26/1:17)",
      });

      expect(res.target.cfi).to.equal("epubcfi(/6/12!/4/2/26/1:17)");
      const pos = gateway.openReaderCalls[0].location?.position as Record<
        string,
        unknown
      >;
      expect(pos.type).to.equal("FragmentSelector");
      expect(pos.value).to.equal("epubcfi(/6/12!/4/2/26/1:17)");
    });

    it("rejects a CFI on a non-EPUB attachment", async function () {
      gateway.addItem({
        key: "PDFNAV02",
        id: 120,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });

      let error: any;
      try {
        await service.navigate({
          attachmentKey: "PDFNAV02",
          cfi: "epubcfi(/6/12!/4/2/26/1:17)",
        });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });

    it("navigates to an annotation belonging to the attachment", async function () {
      const attachment = gateway.addItem({
        key: "PDFNAV03",
        id: 130,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });
      const annotation = gateway.addItem({
        key: "ANNONAV1",
        id: 131,
        itemType: "annotation",
      });
      (annotation as any).parentItemID = attachment.id;

      const res = await service.navigate({
        attachmentKey: "PDFNAV03",
        annotationKey: "ANNONAV1",
      });

      expect(res.target.annotationKey).to.equal("ANNONAV1");
      expect(gateway.openReaderCalls[0].location?.annotationID).to.equal(
        "ANNONAV1",
      );
    });

    it("settles on the annotation's own page for a PDF annotation", async function () {
      const attachment = gateway.addItem({
        key: "PDFNAV08",
        id: 180,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });
      const annotation = gateway.addItem({
        key: "ANNONAV3",
        id: 181,
        itemType: "annotation",
        parentItemID: attachment.id,
        annotationPosition: JSON.stringify({ pageIndex: 2, rects: [] }),
      });
      expect(annotation.parentItemID).to.equal(attachment.id);

      // The reader is already parked on a different page; navigation must move
      // it to the annotation's page (index 2) before the state is read back.
      gateway.activeReader = {
        itemID: attachment.id,
        title: "Annotated Paper",
        type: "pdf",
        state: { pageIndex: 7 },
      };

      const res = await service.navigate({
        attachmentKey: "PDFNAV08",
        annotationKey: "ANNONAV3",
      });

      expect(res.reader.open).to.equal(true);
      if (res.reader.open) {
        expect(res.reader.location.pageIndex).to.equal(2);
        expect(res.reader.selection?.annotationKey).to.equal("ANNONAV3");
      }
    });

    it("rejects an annotation that belongs to a different attachment", async function () {
      gateway.addItem({
        key: "PDFNAV04",
        id: 140,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });
      const annotation = gateway.addItem({
        key: "ANNONAV2",
        id: 141,
        itemType: "annotation",
      });
      (annotation as any).parentItemID = 999;

      let error: any;
      try {
        await service.navigate({
          attachmentKey: "PDFNAV04",
          annotationKey: "ANNONAV2",
        });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });

    it("requires at least one navigation target", async function () {
      gateway.addItem({
        key: "PDFNAV05",
        id: 150,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });

      let error: any;
      try {
        await service.navigate({ attachmentKey: "PDFNAV05" });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });

    it("rejects a non-positive page", async function () {
      gateway.addItem({
        key: "PDFNAV06",
        id: 160,
        itemType: "attachment",
        attachmentContentType: "application/pdf",
      });

      let error: any;
      try {
        await service.navigate({ attachmentKey: "PDFNAV06", page: 0 });
      } catch (e) {
        error = e;
      }
      expect(error?.code).to.equal("invalid_argument");
    });
  });

  it("falls back to fulltext cache for context when SDT is unavailable", async function () {
    const attachment = gateway.addItem({
      key: "PDFA0006",
      id: 60,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
    });

    gateway.cacheText =
      "Introduction to machine learning. Stochastic gradient descent is a fundamental algorithm used in optimization.";

    gateway.activeReader = {
      itemID: attachment.id,
      title: "ML Paper",
      type: "pdf",
      state: { pageIndex: 0 },
      selection: {
        type: "text",
        text: "Stochastic gradient descent",
      },
    };

    const res = await service.getOpenReader({ contextChars: 100 });
    expect(res.open).to.equal(true);
    if (res.open) {
      expect(res.context?.textBefore).to.equal(
        "Introduction to machine learning. ",
      );
      expect(res.context?.textAfter).to.equal(
        " is a fundamental algorithm used in optimization.",
      );
    }
  });
});
