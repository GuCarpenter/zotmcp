import { BasicTool, ProgressWindowHelper } from "zotero-plugin-toolkit";
import { config } from "../package.json";

/**
 * Thin toolkit wrapper. Only logging and a startup popup are needed: the MCP
 * request path must not depend on a Zotero window, so toolkit UI helpers are
 * otherwise unused.
 */
export class ZotmcpToolkit extends BasicTool {
  public readonly ProgressWindow = ProgressWindowHelper;

  constructor() {
    super();
    this.basicOptions.log.prefix = `[${config.addonName}]`;
    this.basicOptions.log.disableConsole = false;
  }
}
