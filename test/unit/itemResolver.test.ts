import { expect } from "chai";
import { ItemResolver } from "../../src/services/itemResolver";
import { FakeGateway, GROUP_LIBRARY_ID, USER_LIBRARY_ID } from "./fakeGateway";

describe("itemResolver", function () {
  let gateway: FakeGateway;
  let resolver: ItemResolver;

  beforeEach(function () {
    gateway = new FakeGateway();
    resolver = new ItemResolver(gateway);
  });

  it("resolves a My Library item", async function () {
    gateway.addItem({ key: "ABCD1234", libraryID: USER_LIBRARY_ID });
    const item = await resolver.resolveItem("ABCD1234");
    expect(item.key).to.equal("ABCD1234");
  });

  it("refuses a key that belongs to a group library", async function () {
    gateway.addItem({ key: "GRUP0001", libraryID: GROUP_LIBRARY_ID });

    let error: any;
    try {
      await resolver.resolveItem("GRUP0001");
    } catch (e) {
      error = e;
    }

    expect(error?.code).to.equal("group_library_unsupported");
    expect(error.message).to.include("GRUP0001");
    expect(error.message).to.include(String(GROUP_LIBRARY_ID));
  });

  it("reports a missing key as not found", async function () {
    let error: any;
    try {
      await resolver.resolveItem("MISS0001");
    } catch (e) {
      error = e;
    }
    expect(error?.code).to.equal("not_found");
    expect(error.message).to.include("MISS0001");
  });

  it("rejects a malformed key naming the offending value", async function () {
    let error: any;
    try {
      await resolver.resolveItem("not-a-key");
    } catch (e) {
      error = e;
    }
    expect(error?.code).to.equal("invalid_argument");
    expect(error.message).to.include("not-a-key");
  });

  it("requires an attachment for resolveAttachment", async function () {
    gateway.addItem({ key: "ABCD1234", itemType: "journalArticle" });

    let error: any;
    try {
      await resolver.resolveAttachment("ABCD1234");
    } catch (e) {
      error = e;
    }
    expect(error?.code).to.equal("invalid_argument");
    expect(error.message).to.include("journalArticle");
  });

  it("resolves an attachment", async function () {
    gateway.addItem({
      key: "EFGH5678",
      itemType: "attachment",
      attachmentContentType: "application/pdf",
    });
    const attachment = await resolver.resolveAttachment("EFGH5678");
    expect(attachment.key).to.equal("EFGH5678");
  });

  it("refuses a group collection", async function () {
    gateway.addCollection({ key: "GRUPCOLL", libraryID: GROUP_LIBRARY_ID });

    let error: any;
    try {
      await resolver.resolveCollection("GRUPCOLL");
    } catch (e) {
      error = e;
    }
    expect(error?.code).to.equal("group_library_unsupported");
  });

  it("reports whether a library ID is My Library", function () {
    expect(resolver.isUserLibrary(USER_LIBRARY_ID)).to.equal(true);
    expect(resolver.isUserLibrary(GROUP_LIBRARY_ID)).to.equal(false);
  });
});
