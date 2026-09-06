import * as hooks from "./hooks";
import { ZotmcpToolkit } from "./ztoolkit";

export class Addon {
  public data: {
    alive: boolean;
    ztoolkit: ZotmcpToolkit;
    /** True once the MCP endpoint is registered on Zotero's HTTP server. */
    endpointRegistered: boolean;
    /**
     * Set when Zotero's HTTP server is unavailable, so the preferences pane can
     * show the actionable banner instead of failing silently.
     */
    httpServerUnavailableReason: string | null;
  };

  public hooks: typeof hooks;

  constructor() {
    this.data = {
      alive: true,
      ztoolkit: new ZotmcpToolkit(),
      endpointRegistered: false,
      httpServerUnavailableReason: null,
    };
    this.hooks = hooks;
  }
}

export default Addon;
