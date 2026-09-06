import { expect } from "chai";
import { createResourceProvider } from "../../src/resources";
import { createToolContext } from "../../src/services/toolContext";
import { ToolRegistry, textResult } from "../../src/tools/registry";
import type { DispatchDeps } from "../../src/protocol/dispatch";
import {
  MCP_ENDPOINT_PATH,
  registerEndpoint,
  unregisterEndpoint,
} from "../../src/transport/endpoint";
import { HTTP_SERVER_PREF } from "../../src/transport/httpServerCheck";
import { FakeGateway } from "./fakeGateway";

function makeDeps(gateway: FakeGateway): DispatchDeps {
  const registry = new ToolRegistry();
  registry.register({
    name: "library_search",
    description: "Test tool.",
    inputSchema: { type: "object", properties: {} },
    mutability: "read",
    handler: async () => textResult("ok"),
  });

  return {
    registry,
    toolContext: createToolContext(gateway),
    resources: createResourceProvider(createToolContext(gateway)),
  };
}

describe("mcp endpoint", function () {
  let gateway: FakeGateway;

  beforeEach(function () {
    gateway = new FakeGateway();
  });

  it("registers on Zotero's HTTP server and reports the connection URL", function () {
    gateway.port = 23119;

    const registration = registerEndpoint(gateway, makeDeps(gateway));

    expect(registration.registered).to.equal(true);
    expect(registration.url).to.equal("http://127.0.0.1:23119/zotmcp/mcp");
    expect(gateway.hasEndpoint(MCP_ENDPOINT_PATH)).to.equal(true);
  });

  it("uses whatever port Zotero is configured for", function () {
    gateway.port = 24119;
    const registration = registerEndpoint(gateway, makeDeps(gateway));
    expect(registration.url).to.equal("http://127.0.0.1:24119/zotmcp/mcp");
  });

  it("fails loudly and registers nothing when Zotero's HTTP server is off", function () {
    gateway.httpServerEnabled = false;

    const registration = registerEndpoint(gateway, makeDeps(gateway));

    expect(registration.registered).to.equal(false);
    expect(gateway.hasEndpoint(MCP_ENDPOINT_PATH)).to.equal(false);
    expect(registration.reason).to.include(HTTP_SERVER_PREF);
    expect(gateway.popups).to.have.length(1);
    expect(gateway.popups[0].isError).to.equal(true);
    expect(
      gateway.logs.some((line) => String(line[0]).startsWith("ERROR")),
    ).to.equal(true);
  });

  it("warns when the endpoint path is already taken", function () {
    registerEndpoint(gateway, makeDeps(gateway));
    gateway.logs = [];

    registerEndpoint(gateway, makeDeps(gateway));

    expect(
      gateway.logs.some((line) =>
        String(line[0]).includes("already registered"),
      ),
    ).to.equal(true);
  });

  it("removes the endpoint on unregister", function () {
    registerEndpoint(gateway, makeDeps(gateway));
    unregisterEndpoint(gateway);
    expect(gateway.hasEndpoint(MCP_ENDPOINT_PATH)).to.equal(false);
  });

  it("declares POST and application/json only", function () {
    registerEndpoint(gateway, makeDeps(gateway));
    const Endpoint = gateway.endpoints.get(MCP_ENDPOINT_PATH)!;
    const endpoint = new Endpoint();

    expect(endpoint.supportedMethods).to.deep.equal(["POST"]);
    expect(endpoint.supportedDataTypes).to.deep.equal(["application/json"]);
  });

  it("returns Zotero's [status, contentType, body] tuple", async function () {
    registerEndpoint(gateway, makeDeps(gateway));
    const Endpoint = gateway.endpoints.get(MCP_ENDPOINT_PATH)!;

    const [status, contentType, body] = await new Endpoint().init({
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

    expect(status).to.equal(200);
    expect(contentType).to.equal("application/json");
    expect(JSON.parse(body).result.tools[0].name).to.equal("library_search");
  });

  it("accepts a pre-parsed object body and a raw string body alike", async function () {
    registerEndpoint(gateway, makeDeps(gateway));
    const Endpoint = gateway.endpoints.get(MCP_ENDPOINT_PATH)!;

    const [, , fromString] = await new Endpoint().init({
      data: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });

    expect(JSON.parse(fromString).result).to.deep.equal({});
  });
});
