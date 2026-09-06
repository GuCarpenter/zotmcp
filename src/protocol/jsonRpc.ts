/**
 * JSON-RPC 2.0 framing for the MCP endpoint.
 *
 * Hand-rolled rather than pulled from the MCP SDK: the SDK's transports assume
 * Node, while this runs inside Zotero on Zotero's own HTTP server.
 */

export const JSON_RPC_VERSION = "2.0";

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface HttpResponse {
  status: number;
  contentType: string;
  body: string;
}

export const JSON_CONTENT_TYPE = "application/json";

export function makeResult(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, result });
}

export function makeError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): string {
  return JSON.stringify({
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  });
}

export function jsonResponse(body: string, status = 200): HttpResponse {
  return { status, contentType: JSON_CONTENT_TYPE, body };
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200,
): HttpResponse {
  return jsonResponse(makeError(id, code, message), status);
}

/**
 * A notification (no `id`) gets no JSON-RPC body. 202 with an empty body is the
 * conventional MCP-over-HTTP answer.
 */
export function acceptedResponse(): HttpResponse {
  return { status: 202, contentType: JSON_CONTENT_TYPE, body: "" };
}

export type ParseOutcome =
  { ok: true; request: JsonRpcRequest } | { ok: false; response: HttpResponse };

/**
 * Parses a request body into a single JSON-RPC request.
 *
 * Batch arrays are rejected explicitly rather than silently ignored: a client
 * that batches would otherwise see its calls vanish with a 200.
 */
export function parseRequest(body: unknown): ParseOutcome {
  let payload: unknown = body;

  if (typeof body === "string") {
    if (!body.trim()) {
      return {
        ok: false,
        response: errorResponse(null, RPC_PARSE_ERROR, "Empty request body."),
      };
    }
    try {
      payload = JSON.parse(body);
    } catch (e) {
      return {
        ok: false,
        response: errorResponse(
          null,
          RPC_PARSE_ERROR,
          `Request body is not valid JSON: ${(e as Error).message}`,
        ),
      };
    }
  }

  if (Array.isArray(payload)) {
    return {
      ok: false,
      response: errorResponse(
        null,
        RPC_INVALID_REQUEST,
        "JSON-RPC batch requests are not supported. Send one request per call.",
      ),
    };
  }

  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      response: errorResponse(
        null,
        RPC_INVALID_REQUEST,
        "Request body must be a JSON-RPC 2.0 request object.",
      ),
    };
  }

  const candidate = payload as Record<string, unknown>;

  if (typeof candidate.method !== "string" || !candidate.method) {
    return {
      ok: false,
      response: errorResponse(
        normalizeId(candidate.id) ?? null,
        RPC_INVALID_REQUEST,
        'Request is missing a string "method".',
      ),
    };
  }

  return {
    ok: true,
    request: {
      jsonrpc: typeof candidate.jsonrpc === "string" ? candidate.jsonrpc : "",
      id: normalizeId(candidate.id),
      method: candidate.method,
      params:
        candidate.params && typeof candidate.params === "object"
          ? (candidate.params as Record<string, unknown>)
          : undefined,
    },
  };
}

/** `undefined` marks a notification; anything else becomes a valid id. */
export function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined;
}

function normalizeId(value: unknown): JsonRpcId | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}
