import { expect } from "chai";
import { handleRequest, type DispatchDeps } from "../../src/protocol/dispatch";
import { LATEST_PROTOCOL_VERSION } from "../../src/protocol/capabilities";
import { createResourceProvider } from "../../src/resources";
import { createToolContext } from "../../src/services/toolContext";
import {
  ToolRegistry,
  textResult,
  type ToolSpec,
} from "../../src/tools/registry";
import { FakeGateway } from "./fakeGateway";

function makeDeps(overrides: Partial<ToolSpec> = {}): {
  deps: DispatchDeps;
  calls: Record<string, unknown>[];
} {
  const gateway = new FakeGateway();
  const registry = new ToolRegistry();
  const calls: Record<string, unknown>[] = [];

  registry.register({
    name: "library_search",
    description: "Test tool.",
    inputSchema: { type: "object", properties: {} },
    mutability: "read",
    async handler(args) {
      calls.push(args);
      return textResult("ok");
    },
    ...overrides,
  } as ToolSpec);

  return {
    calls,
    deps: {
      registry,
      toolContext: createToolContext(gateway),
      resources: createResourceProvider(),
    },
  };
}

async function post(body: unknown, deps: DispatchDeps) {
  const response = await handleRequest(body, deps);
  return {
    status: response.status,
    payload: response.body ? JSON.parse(response.body) : null,
  };
}

describe("protocol dispatch", function () {
  it("answers initialize with tools and resources capabilities only", async function () {
    const { deps } = makeDeps();
    const { status, payload } = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: LATEST_PROTOCOL_VERSION },
      },
      deps,
    );

    expect(status).to.equal(200);
    expect(payload.result.protocolVersion).to.equal(LATEST_PROTOCOL_VERSION);
    expect(Object.keys(payload.result.capabilities).sort()).to.deep.equal([
      "resources",
      "tools",
    ]);
    expect(payload.result.serverInfo.name).to.equal("zotmcp");
  });

  it("echoes an older supported protocol version", async function () {
    const { deps } = makeDeps();
    const { payload } = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      },
      deps,
    );
    expect(payload.result.protocolVersion).to.equal("2024-11-05");
  });

  it("falls back to its newest version for an unknown request", async function () {
    const { deps } = makeDeps();
    const { payload } = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "1999-01-01" },
      },
      deps,
    );
    expect(payload.result.protocolVersion).to.equal(LATEST_PROTOCOL_VERSION);
  });

  it("serves tools/call with no prior initialize (stateless)", async function () {
    const { deps } = makeDeps();
    const { status, payload } = await post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "library_search", arguments: { query: "x" } },
      },
      deps,
    );

    expect(status).to.equal(200);
    expect(payload.result.isError).to.equal(undefined);
    expect(payload.result.content[0].text).to.equal("ok");
  });

  it("handles two independent calls with no shared state", async function () {
    const { deps, calls } = makeDeps();
    const [first, second] = await Promise.all([
      post(
        {
          jsonrpc: "2.0",
          id: "a",
          method: "tools/call",
          params: { name: "library_search", arguments: { query: "one" } },
        },
        deps,
      ),
      post(
        {
          jsonrpc: "2.0",
          id: "b",
          method: "tools/call",
          params: { name: "library_search", arguments: { query: "two" } },
        },
        deps,
      ),
    ]);

    expect(first.payload.id).to.equal("a");
    expect(second.payload.id).to.equal("b");
    expect(calls).to.deep.equal([{ query: "one" }, { query: "two" }]);
  });

  it("rejects a JSON-RPC batch array instead of ignoring it", async function () {
    const { deps } = makeDeps();
    const { payload } = await post(
      [{ jsonrpc: "2.0", id: 1, method: "tools/list" }],
      deps,
    );

    expect(payload.error.code).to.equal(-32600);
    expect(payload.error.message).to.include("batch");
  });

  it("reports malformed JSON as a parse error", async function () {
    const { deps } = makeDeps();
    const { payload } = await post("{ not json", deps);
    expect(payload.error.code).to.equal(-32700);
  });

  it("reports an empty body as a parse error", async function () {
    const { deps } = makeDeps();
    const { payload } = await post("", deps);
    expect(payload.error.code).to.equal(-32700);
  });

  it("rejects a request with no method", async function () {
    const { deps } = makeDeps();
    const { payload } = await post({ jsonrpc: "2.0", id: 1 }, deps);
    expect(payload.error.code).to.equal(-32600);
  });

  it("reports an unknown method as method not found", async function () {
    const { deps } = makeDeps();
    const { payload } = await post(
      { jsonrpc: "2.0", id: 1, method: "does/notExist" },
      deps,
    );
    expect(payload.error.code).to.equal(-32601);
    expect(payload.error.message).to.include("does/notExist");
  });

  it("accepts a notification with 202 and an empty body", async function () {
    const { deps } = makeDeps();
    const response = await handleRequest(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      deps,
    );
    expect(response.status).to.equal(202);
    expect(response.body).to.equal("");
  });

  it("answers ping", async function () {
    const { deps } = makeDeps();
    const { payload } = await post(
      { jsonrpc: "2.0", id: 3, method: "ping" },
      deps,
    );
    expect(payload.result).to.deep.equal({});
  });

  it("lists tools from the registry with annotations", async function () {
    const { deps } = makeDeps();
    const { payload } = await post(
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      deps,
    );
    expect(payload.result.tools).to.have.length(1);
    expect(payload.result.tools[0].name).to.equal("library_search");
    expect(payload.result.tools[0].annotations.readOnlyHint).to.equal(true);
  });

  it("reports an unknown tool as method not found", async function () {
    const { deps } = makeDeps();
    const { payload } = await post(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "nope" },
      },
      deps,
    );
    expect(payload.error.code).to.equal(-32601);
    expect(payload.error.message).to.include("nope");
  });

  it("requires a tool name on tools/call", async function () {
    const { deps } = makeDeps();
    const { payload } = await post(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: {} },
      deps,
    );
    expect(payload.error.code).to.equal(-32602);
  });

  it("returns a thrown tool failure as an isError result, not a protocol error", async function () {
    const { deps } = makeDeps({
      async handler() {
        throw new Error("attachment EFGH5678 has no file on disk");
      },
    });

    const { status, payload } = await post(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "library_search" },
      },
      deps,
    );

    expect(status).to.equal(200);
    expect(payload.error).to.equal(undefined);
    expect(payload.result.isError).to.equal(true);
    expect(payload.result.content[0].text).to.include("EFGH5678");
  });

  it("defaults absent or non-object tool arguments to an empty object", async function () {
    const { deps, calls } = makeDeps();
    await post(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "library_search", arguments: "nonsense" },
      },
      deps,
    );
    expect(calls).to.deep.equal([{}]);
  });

  it("lists the three MCP resources", async function () {
    const { deps } = makeDeps();
    const { payload } = await post(
      { jsonrpc: "2.0", id: 9, method: "resources/list" },
      deps,
    );
    expect(payload.result.resources.map((r: any) => r.uri)).to.deep.equal([
      "zotero://collections",
      "zotero://items/{itemKey}",
      "zotero://collections/{collectionKey}/items",
    ]);
  });

  it("requires a uri on resources/read", async function () {
    const { deps } = makeDeps();
    const { payload } = await post(
      { jsonrpc: "2.0", id: 10, method: "resources/read", params: {} },
      deps,
    );
    expect(payload.error.code).to.equal(-32602);
  });
});
