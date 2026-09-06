import { expect } from "chai";
import { config } from "../../package.json";

// Guards the build contract the bootstrap depends on: `addonInstance` names the
// property bootstrap.js reads as `Zotero.<addonInstance>`, and `addonRef` names
// the bundled script file and chrome package. A rename that misses one of them
// yields a plugin that installs but never starts.
describe("build config", function () {
  it("declares the identifiers bootstrap.js substitutes", function () {
    expect(config.addonRef).to.equal("zotmcp");
    expect(config.addonInstance).to.equal("Zotmcp");
    expect(config.prefsPrefix).to.equal("extensions.zotero.zotmcp");
  });
});
