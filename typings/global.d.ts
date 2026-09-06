declare const _globalThis: {
  rootURI: string;
  Zotero: _ZoteroTypes.Zotero;
  addon: import("../src/addon").Addon;
  ztoolkit: import("../src/ztoolkit").ZotmcpToolkit;
};

declare const rootURI: string;
declare const ztoolkit: import("../src/ztoolkit").ZotmcpToolkit;
declare const addon: import("../src/addon").Addon;

/**
 * Zotero's built-in HTTP server. Not covered by zotero-types, so the shape the
 * plugin relies on is declared here.
 *
 * An endpoint is a class keyed by request path in `Zotero.Server.Endpoints`.
 * `init()` resolves to `[statusCode, contentType, body]` — note the absence of
 * any response-header channel, which is why the MCP endpoint is stateless.
 */
declare namespace ZotmcpServer {
  interface EndpointOptions {
    method?: string;
    pathname?: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    /** Already JSON-parsed when the request declares application/json. */
    data?: unknown;
  }

  type EndpointResponse = [number, string, string];

  interface Endpoint {
    supportedMethods: string[];
    supportedDataTypes?: string[];
    init(options: EndpointOptions): Promise<EndpointResponse>;
  }
}
