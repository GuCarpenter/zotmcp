/**
 * Plugin lifecycle. The MCP endpoint is registered once Zotero is fully
 * initialized and removed on shutdown, so no stale endpoint survives a disable
 * or upgrade.
 */

import { config } from "../package.json";
import type { DispatchDeps } from "./protocol/dispatch";
import { createResourceProvider } from "./resources";
import { createToolContext } from "./services/toolContext";
import { RealZoteroGateway } from "./services/zoteroGateway";
import { createToolRegistry } from "./tools";
import {
  MCP_ENDPOINT_PATH,
  registerEndpoint,
  unregisterEndpoint,
} from "./transport/endpoint";

const SERVER_ENABLED_PREF = "mcp.server.enabled";

/**
 * The plugin's Fluent file, which supplies the Undo/Redo menu labels.
 *
 * The build prefixes locale filenames with the plugin namespace so plugins cannot
 * collide in Zotero's shared localization registry, so `strings.ftl` ships as
 * `zotmcp-strings.ftl` and must be registered under that name. Registering the
 * unprefixed name silently resolves nothing, and every undo entry then shows a
 * raw message ID.
 */
export const LOCALE_FILE_NAME = `${config.addonRef}-strings.ftl`;
const UNDO_LABEL_FTL = [LOCALE_FILE_NAME];

let prefObserverId: symbol | string | undefined;

export async function onStartup(): Promise<void> {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  const gateway = new RealZoteroGateway();
  const toolContext = createToolContext(gateway);
  const deps: DispatchDeps = {
    registry: createToolRegistry(),
    toolContext,
    resources: createResourceProvider(toolContext),
    log: (...args) => gateway.log(...args),
  };

  addon.data.gateway = gateway;
  addon.data.dispatchDeps = deps;

  // Undo labels are formatted through Zotero.ftl rather than window l10n, so the
  // plugin's FTL has to be in Zotero's own bundle.
  gateway.registerLocalization(UNDO_LABEL_FTL);

  startOrStopServer();
  watchServerPref();
  registerPreferencePane();
}

export async function onShutdown(): Promise<void> {
  unwatchServerPref();

  if (addon.data.gateway) {
    unregisterEndpoint(addon.data.gateway);
    addon.data.gateway.unregisterLocalization(UNDO_LABEL_FTL);
  }
  addon.data.endpointRegistered = false;
  addon.data.alive = false;

  // @ts-expect-error - plugin instance is not typed
  delete Zotero[config.addonInstance];
}

export async function onMainWindowLoad(_win: Window): Promise<void> {}

export async function onMainWindowUnload(_win: Window): Promise<void> {}

/** Applies the current `mcp.server.enabled` preference. */
export function startOrStopServer(): void {
  const gateway = addon.data.gateway;
  const deps = addon.data.dispatchDeps;
  if (!gateway || !deps) return;

  const enabled = gateway.getPref(SERVER_ENABLED_PREF) !== false;

  if (!enabled) {
    unregisterEndpoint(gateway);
    addon.data.endpointRegistered = false;
    addon.data.endpointUrl = null;
    gateway.log(`MCP endpoint disabled by ${SERVER_ENABLED_PREF}`);
    return;
  }

  const registration = registerEndpoint(gateway, deps);
  addon.data.endpointRegistered = registration.registered;
  addon.data.endpointUrl = registration.url;
  addon.data.httpServerUnavailableReason = registration.reason;
}

function registerPreferencePane(): void {
  try {
    (
      Zotero as unknown as {
        PreferencePanes: {
          register(options: Record<string, unknown>): Promise<void> | void;
        };
      }
    ).PreferencePanes.register({
      pluginID: config.addonID,
      src: `${rootURI}content/preferences.xhtml`,
      label: config.addonName,
      image: `${rootURI}content/icons/icon-48.png`,
    });
  } catch (e) {
    // A missing preferences pane is cosmetic; the endpoint still works.
    addon.data.gateway?.log("WARN could not register the preferences pane", e);
  }
}

function watchServerPref(): void {
  const gateway = addon.data.gateway;
  if (!gateway) return;

  try {
    prefObserverId = Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.${SERVER_ENABLED_PREF}`,
      () => startOrStopServer(),
      true,
    );
  } catch (e) {
    gateway.log("WARN could not observe the server preference", e);
  }
}

function unwatchServerPref(): void {
  if (prefObserverId === undefined) return;
  try {
    Zotero.Prefs.unregisterObserver(prefObserverId as never);
  } catch {
    // Nothing actionable: shutdown is already in progress.
  }
  prefObserverId = undefined;
}

export { MCP_ENDPOINT_PATH };
