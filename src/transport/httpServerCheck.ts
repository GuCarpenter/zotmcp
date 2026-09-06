/**
 * Zotero's own HTTP server hosts the MCP endpoint, so the plugin has no socket
 * of its own. When that server is off there is nowhere to listen, and the plugin
 * says so loudly instead of appearing installed but unreachable (spec S-3).
 */

import type { ZoteroGateway } from "../services/zoteroGateway";

export const HTTP_SERVER_PREF = "extensions.zotero.httpServer.enabled";

export interface HttpServerStatus {
  available: boolean;
  port: number;
  /** Actionable message when unavailable, else null. */
  reason: string | null;
}

export function checkHttpServer(gateway: ZoteroGateway): HttpServerStatus {
  const port = gateway.httpServerPort();

  if (!gateway.isHttpServerEnabled()) {
    return {
      available: false,
      port,
      reason:
        `Zotero's HTTP server is disabled, so the MCP endpoint cannot be ` +
        `served. Enable "${HTTP_SERVER_PREF}" (Settings → Advanced → Allow ` +
        `other applications on this computer to communicate with Zotero), ` +
        `then restart Zotero.`,
    };
  }

  return { available: true, port, reason: null };
}

export function reportHttpServerUnavailable(
  gateway: ZoteroGateway,
  reason: string,
): void {
  gateway.log(`ERROR ${reason}`);
  gateway.showPopup("Zotmcp", reason, true);
}
