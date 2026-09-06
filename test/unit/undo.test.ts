import { expect } from "chai";
import { readFileSync } from "node:fs";
import { stageUndo, UNDO_ACTIONS, undoLabel } from "../../src/services/undo";
import { FakeGateway } from "./fakeGateway";

const FTL = readFileSync("addon/locale/en-US/zotmcp.ftl", "utf8");

describe("undo", function () {
  it("builds save options Zotero puts on the undo stack", function () {
    expect(undoLabel(UNDO_ACTIONS.editMetadata, 3)).to.deep.equal({
      undoAction: "zotmcp-undo-edit-metadata",
      undoActionArgs: { count: 3 },
    });
  });

  it("stages a single undo step for a multi-object transaction", function () {
    const gateway = new FakeGateway();
    stageUndo(gateway, UNDO_ACTIONS.editRelated);
    expect(gateway.stagedUndoActions).to.deep.equal([
      { action: "zotmcp-undo-edit-related", args: { count: 1 } },
    ]);
  });

  it("declares every undo action in the plugin's FTL", function () {
    // A label missing from the FTL shows up as a raw message ID in Zotero's
    // Undo menu, which is only visible at runtime — so it is checked here.
    for (const id of Object.values(UNDO_ACTIONS)) {
      expect(FTL, `${id} missing from zotmcp.ftl`).to.include(`${id} =`);
    }
  });
});
