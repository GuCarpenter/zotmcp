/**
 * Plugin lifecycle. The MCP endpoint is registered here once Zotero is fully
 * initialized, and removed on shutdown so no stale endpoint survives an
 * upgrade or disable.
 */

import { config } from "../package.json";

export async function onStartup(): Promise<void> {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  ztoolkit.log("startup");
}

export async function onShutdown(): Promise<void> {
  ztoolkit.log("shutdown");

  addon.data.alive = false;
  // @ts-expect-error - plugin instance is not typed
  delete Zotero[config.addonInstance];
}

export async function onMainWindowLoad(_win: Window): Promise<void> {}

export async function onMainWindowUnload(_win: Window): Promise<void> {}
