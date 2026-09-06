import { BasicTool } from "zotero-plugin-toolkit";
import { config } from "../package.json";

/**
 * Thin toolkit wrapper. Only logging is needed: the MCP request path must not
 * depend on a Zotero window, so toolkit UI helpers are deliberately unused.
 */
export class ZotmcpToolkit extends BasicTool {
  constructor() {
    super();
    this.basicOptions.log.prefix = `[${config.addonName}]`;
    this.basicOptions.log.disableConsole = false;
  }
}
