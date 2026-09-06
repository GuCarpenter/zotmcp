/**
 * The MCP endpoint, registered on Zotero's own HTTP server.
 *
 * Zotero owns the socket, the body read, UTF-8 decoding and the size limit, so
 * none of that is reimplemented here — the class of encoding bug that forces
 * plugins with their own sockets to hand-roll HTTP parsing cannot arise.
 *
 * Note the response shape Zotero expects: `[status, contentType, body]`, with no
 * header channel. That is the concrete reason the server is stateless — there is
 * no way to hand a session id back to a client.
 */

import { describeError } from "../errors";
import { handleRequest, type DispatchDeps } from "../protocol/dispatch";
import {
  JSON_CONTENT_TYPE,
  makeError,
  RPC_INTERNAL_ERROR,
} from "../protocol/jsonRpc";
import type {
  EndpointConstructor,
  ZoteroGateway,
} from "../services/zoteroGateway";
import {
  checkHttpServer,
  reportHttpServerUnavailable,
} from "./httpServerCheck";

export const MCP_ENDPOINT_PATH = "/zotmcp/mcp";

export interface EndpointRegistration {
  registered: boolean;
  path: string;
  url: string | null;
  reason: string | null;
}

export function buildEndpointClass(deps: DispatchDeps): EndpointConstructor {
  return class McpEndpoint implements ZotmcpServer.Endpoint {
    public supportedMethods = ["POST"];
    public supportedDataTypes = [JSON_CONTENT_TYPE];

    public async init(
      options: ZotmcpServer.EndpointOptions,
    ): Promise<ZotmcpServer.EndpointResponse> {
      try {
        const response = await handleRequest(options.data, deps);
        return [response.status, response.contentType, response.body];
      } catch (e) {
        // handleRequest already converts failures into JSON-RPC errors; this is
        // the last resort so Zotero never sees a rejected promise.
        return [
          200,
          JSON_CONTENT_TYPE,
          makeError(
            null,
            RPC_INTERNAL_ERROR,
            `Internal error: ${describeError(e)}`,
          ),
        ];
      }
    }
  };
}

export function registerEndpoint(
  gateway: ZoteroGateway,
  deps: DispatchDeps,
): EndpointRegistration {
  const status = checkHttpServer(gateway);

  if (!status.available) {
    reportHttpServerUnavailable(gateway, status.reason!);
    return {
      registered: false,
      path: MCP_ENDPOINT_PATH,
      url: null,
      reason: status.reason,
    };
  }

  if (gateway.hasEndpoint(MCP_ENDPOINT_PATH)) {
    gateway.log(
      `WARN endpoint ${MCP_ENDPOINT_PATH} was already registered; replacing it.`,
    );
  }

  gateway.registerEndpoint(MCP_ENDPOINT_PATH, buildEndpointClass(deps));

  const url = `http://127.0.0.1:${status.port}${MCP_ENDPOINT_PATH}`;
  gateway.log(`MCP endpoint listening at ${url}`);

  return { registered: true, path: MCP_ENDPOINT_PATH, url, reason: null };
}

export function unregisterEndpoint(gateway: ZoteroGateway): void {
  gateway.unregisterEndpoint(MCP_ENDPOINT_PATH);
}
