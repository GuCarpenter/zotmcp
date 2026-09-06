/**
 * MCP method dispatch.
 *
 * A pure function of (method, params) plus injected services: no per-client
 * state exists anywhere, which is what makes the endpoint stateless (spec S-6).
 * A `tools/call` therefore succeeds with no prior `initialize`, and concurrent
 * callers cannot interfere except through the write queue.
 */

import { describeError } from "../errors";
import type { ToolContext, ToolRegistry, ToolResult } from "../tools/registry";
import { errorResult } from "../tools/registry";
import { buildInitializeResult } from "./capabilities";
import {
  acceptedResponse,
  errorResponse,
  isNotification,
  jsonResponse,
  makeResult,
  parseRequest,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  type HttpResponse,
  type JsonRpcRequest,
} from "./jsonRpc";

export interface ResourceProvider {
  list(): Promise<unknown[]>;
  read(uri: string): Promise<unknown>;
}

export interface DispatchDeps {
  registry: ToolRegistry;
  toolContext: ToolContext;
  resources: ResourceProvider;
  log?(...args: unknown[]): void;
}

export async function handleRequest(
  body: unknown,
  deps: DispatchDeps,
): Promise<HttpResponse> {
  const parsed = parseRequest(body);
  if (!parsed.ok) return parsed.response;

  const request = parsed.request;

  if (isNotification(request)) {
    // Notifications carry no id, so there is nothing to respond to. Accepting
    // them keeps well-behaved clients from treating startup as a failure.
    return acceptedResponse();
  }

  const id = request.id ?? null;

  try {
    return await dispatch(request, id, deps);
  } catch (e) {
    deps.log?.("dispatch failed", request.method, e);
    return errorResponse(
      id,
      RPC_INTERNAL_ERROR,
      `Internal error handling "${request.method}": ${describeError(e)}`,
    );
  }
}

async function dispatch(
  request: JsonRpcRequest,
  id: string | number | null,
  deps: DispatchDeps,
): Promise<HttpResponse> {
  switch (request.method) {
    case "initialize":
      return jsonResponse(
        makeResult(id, buildInitializeResult(request.params)),
      );

    case "ping":
      return jsonResponse(makeResult(id, {}));

    case "tools/list":
      return jsonResponse(makeResult(id, { tools: deps.registry.list() }));

    case "tools/call":
      return callTool(request, id, deps);

    case "resources/list":
      return jsonResponse(
        makeResult(id, { resources: await deps.resources.list() }),
      );

    case "resources/read":
      return readResource(request, id, deps);

    default:
      if (request.method.startsWith("notifications/")) {
        return jsonResponse(makeResult(id, {}));
      }
      return errorResponse(
        id,
        RPC_METHOD_NOT_FOUND,
        `Unknown method "${request.method}".`,
      );
  }
}

async function callTool(
  request: JsonRpcRequest,
  id: string | number | null,
  deps: DispatchDeps,
): Promise<HttpResponse> {
  const name = request.params?.name;
  if (typeof name !== "string" || !name) {
    return errorResponse(
      id,
      RPC_INVALID_PARAMS,
      'tools/call requires a string "name".',
    );
  }

  const spec = deps.registry.get(name);
  if (!spec) {
    return errorResponse(
      id,
      RPC_METHOD_NOT_FOUND,
      `Unknown tool "${name}". Call tools/list for the available tools.`,
    );
  }

  const rawArgs = request.params?.arguments;
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  // A tool failure is a result with isError, not a JSON-RPC error: clients show
  // it to the model, which can then correct itself (spec E-4).
  let result: ToolResult;
  try {
    result = await spec.handler(args, deps.toolContext);
  } catch (e) {
    deps.log?.("tool failed", name, e);
    result = errorResult(describeError(e));
  }

  return jsonResponse(makeResult(id, result));
}

async function readResource(
  request: JsonRpcRequest,
  id: string | number | null,
  deps: DispatchDeps,
): Promise<HttpResponse> {
  const uri = request.params?.uri;
  if (typeof uri !== "string" || !uri) {
    return errorResponse(
      id,
      RPC_INVALID_PARAMS,
      'resources/read requires a string "uri".',
    );
  }

  try {
    const contents = await deps.resources.read(uri);
    return jsonResponse(makeResult(id, { contents }));
  } catch (e) {
    return errorResponse(id, RPC_INVALID_PARAMS, describeError(e));
  }
}
