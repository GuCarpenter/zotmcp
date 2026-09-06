import { expect } from "chai";
import { readFileSync } from "node:fs";
import { stageUndo, UNDO_ACTIONS, undoLabel } from "../../src/services/undo";
import { FakeGateway } from "./fakeGateway";

import { LOCALE_FILE_NAME } from "../../src/hooks";

// The registered resource name is the built filename; strip the namespace prefix
// the build adds to get back to the source file. If these drift apart, Zotero
// resolves nothing and every undo entry shows a raw message ID.
const SOURCE_FTL = LOCALE_FILE_NAME.replace(/^zotmcp-/, "");
const FTL = readFileSync(`addon/locale/en-US/${SOURCE_FTL}`, "utf8");

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

  it("registers the Fluent file under its built, namespace-prefixed name", function () {
    expect(LOCALE_FILE_NAME).to.equal("zotmcp-strings.ftl");
    expect(SOURCE_FTL).to.equal("strings.ftl");
  });

  it("declares every undo action in the plugin's FTL", function () {
    // A label missing from the FTL shows up as a raw message ID in Zotero's
    // Undo menu, which is only visible at runtime — so it is checked here.
    for (const id of Object.values(UNDO_ACTIONS)) {
      expect(FTL, `${id} missing from zotmcp.ftl`).to.include(`${id} =`);
    }
  });
});
