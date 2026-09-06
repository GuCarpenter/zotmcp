// Unit tests run in plain Node, outside Zotero. `zotero-plugin-toolkit` reaches
// for Zotero globals at import time, so it is stubbed here. Modules under test
// must never import it directly — they take a ZoteroGateway instead.
const Module = require("module");

const zoteroPluginToolkitStub = {
  BasicTool: class BasicTool {
    constructor() {
      this.basicOptions = { log: {}, api: {} };
    }
    getGlobal() {
      return undefined;
    }
    log() {}
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "zotero-plugin-toolkit") {
    return zoteroPluginToolkitStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};
