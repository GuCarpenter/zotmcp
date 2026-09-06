import * as hooks from "./hooks";
import type { DispatchDeps } from "./protocol/dispatch";
import type { ZoteroGateway } from "./services/zoteroGateway";
import { ZotmcpToolkit } from "./ztoolkit";

export class Addon {
  public data: {
    alive: boolean;
    ztoolkit: ZotmcpToolkit;
    gateway: ZoteroGateway | null;
    dispatchDeps: DispatchDeps | null;
    /** True once the MCP endpoint is registered on Zotero's HTTP server. */
    endpointRegistered: boolean;
    /** Connection URL to show in the preferences pane. */
    endpointUrl: string | null;
    /**
     * Set when Zotero's HTTP server is unavailable, so the preferences pane can
     * show an actionable banner instead of failing silently.
     */
    httpServerUnavailableReason: string | null;
  };

  public hooks: typeof hooks;

  constructor() {
    this.data = {
      alive: true,
      ztoolkit: new ZotmcpToolkit(),
      gateway: null,
      dispatchDeps: null,
      endpointRegistered: false,
      endpointUrl: null,
      httpServerUnavailableReason: null,
    };
    this.hooks = hooks;
  }
}

export default Addon;
