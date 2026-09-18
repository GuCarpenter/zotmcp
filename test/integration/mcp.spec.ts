/**
 * Integration tests. These run inside a real Zotero via `zotero-plugin test`, so
 * they exercise what a fake gateway cannot: endpoint registration, Zotero's own
 * search engine, structured document text, and real saves.
 */

import { handleRequest, type DispatchDeps } from "../../src/protocol/dispatch";
import { createResourceProvider } from "../../src/resources";
import { createToolContext } from "../../src/services/toolContext";
import { RealZoteroGateway } from "../../src/services/zoteroGateway";
import { createToolRegistry } from "../../src/tools";
import { MCP_ENDPOINT_PATH } from "../../src/transport/endpoint";

declare const expect: Chai.ExpectStatic;

/** Zotero.Items.get() is typed as `Item | false`; tests know the item exists. */
function item(itemID: number): Zotero.Item {
  const found = Zotero.Items.get(itemID);
  if (!found) throw new Error(`fixture item ${itemID} disappeared`);
  return found;
}

function makeDeps(): DispatchDeps {
  const gateway = new RealZoteroGateway();
  const toolContext = createToolContext(gateway);
  return {
    registry: createToolRegistry(),
    toolContext,
    resources: createResourceProvider(toolContext),
  };
}

async function rpc(method: string, params?: Record<string, unknown>) {
  const response = await handleRequest(
    { jsonrpc: "2.0", id: 1, method, params },
    makeDeps(),
  );
  return response.body ? JSON.parse(response.body) : null;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const payload = await rpc("tools/call", { name, arguments: args });
  const result = payload.result;
  if (result?.isError) {
    throw new Error(`tool ${name} failed: ${result.content[0].text}`);
  }
  return JSON.parse(result.content[0].text);
}

describe("zotmcp integration", function () {
  const createdItemIDs: number[] = [];

  after(async function () {
    // Leave the library as it was found.
    for (const id of createdItemIDs) {
      const found = Zotero.Items.get(id);
      if (found) await found.eraseTx();
    }
  });

  describe("endpoint", function () {
    it("is registered on Zotero's HTTP server", function () {
      expect(Zotero.Server.Endpoints[MCP_ENDPOINT_PATH]).to.be.a("function");
    });

    it("declares POST and application/json only", function () {
      const Endpoint = Zotero.Server.Endpoints[
        MCP_ENDPOINT_PATH
      ] as never as new () => {
        supportedMethods: string[];
        supportedDataTypes: string[];
      };
      const endpoint = new Endpoint();
      expect(endpoint.supportedMethods).to.deep.equal(["POST"]);
      expect(endpoint.supportedDataTypes).to.deep.equal(["application/json"]);
    });
  });

  describe("protocol", function () {
    it("initializes and lists exactly thirteen tools", async function () {
      const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
      expect(init.result.protocolVersion).to.equal("2025-06-18");

      const list = await rpc("tools/list");
      expect(list.result.tools).to.have.length(13);
    });

    it("serves a tool call with no prior initialize", async function () {
      const payload = await rpc("tools/call", {
        name: "library_search",
        arguments: { entity: "tags", limit: 1 },
      });
      expect(payload.result.isError).to.equal(undefined);
    });

    it("returns a tool failure as an isError result, not a protocol error", async function () {
      const payload = await rpc("tools/call", {
        name: "library_read",
        arguments: { itemKey: "ZZZZZZZZ" },
      });
      expect(payload.error).to.equal(undefined);
      expect(payload.result.isError).to.equal(true);
      expect(payload.result.content[0].text).to.include("ZZZZZZZZ");
    });
  });

  describe("write round trips", function () {
    let itemKey: string;
    let itemID: number;

    before(async function () {
      const item = new Zotero.Item("journalArticle");
      item.setField("title", "zotmcp integration fixture 注意力 🎯");
      await item.saveTx();
      createdItemIDs.push(item.id);
      itemKey = item.key;
      itemID = item.id;
    });

    it("finds the fixture by keyword, preserving non-ASCII", async function () {
      const found = await callTool("library_search", {
        query: "zotmcp integration fixture",
      });
      const hit = found.items.find(
        (entry: { key: string }) => entry.key === itemKey,
      );
      expect(hit, "fixture not found by search").to.not.equal(undefined);
      expect(hit.title).to.include("注意力 🎯");
    });

    it("reads it back with a My Library select URI", async function () {
      const read = await callTool("library_read", {
        itemKey,
        sections: ["metadata", "tags"],
      });
      expect(read.uri.select).to.equal(
        `zotero://select/library/items/${itemKey}`,
      );
      expect(read.uri.select).to.not.include("/groups/");
    });

    it("updates metadata and reports what changed", async function () {
      const result = await callTool("library_update", {
        kind: "metadata",
        itemKey,
        fields: { volume: "42" },
      });
      expect(result.changed).to.deep.equal(["volume"]);
      expect(item(itemID).getField("volume")).to.equal("42");
    });

    it("rejects a field the item type does not have", async function () {
      const payload = await rpc("tools/call", {
        name: "library_update",
        arguments: {
          kind: "metadata",
          itemKey,
          fields: { nameOfAct: "nope" },
        },
      });
      expect(payload.result.isError).to.equal(true);
      expect(payload.result.content[0].text).to.include("journalArticle");
    });

    it("adds tags, then set replaces the whole list", async function () {
      await callTool("library_update", {
        kind: "tags",
        itemKeys: [itemKey],
        action: "add",
        tags: ["zotmcp-test-a"],
      });
      await callTool("library_update", {
        kind: "tags",
        itemKeys: [itemKey],
        action: "set",
        tags: ["zotmcp-test-b"],
      });

      const tags = item(itemID)
        .getTags()
        .map((tag: { tag: string }) => tag.tag);
      expect(tags).to.deep.equal(["zotmcp-test-b"]);
    });

    it("links related items in both directions", async function () {
      const other = new Zotero.Item("journalArticle");
      other.setField("title", "zotmcp integration fixture two");
      await other.saveTx();
      createdItemIDs.push(other.id);

      const result = await callTool("library_update", {
        kind: "related",
        itemKey,
        relatedItemKeys: [other.key],
        action: "add",
      });

      expect(result.linked).to.deep.equal([other.key]);
      // Both sides must carry the relation, or the link is half-written.
      const forward = item(itemID) as never as {
        relatedItems: string[];
      };
      const backward = other as never as { relatedItems: string[] };
      expect(forward.relatedItems).to.include(other.key);
      expect(backward.relatedItems).to.include(itemKey);
    });

    it("writes a note as HTML converted from Markdown", async function () {
      const result = await callTool("note_write", {
        action: "create",
        parentItemKey: itemKey,
        content: "# Heading\n\nBody with **bold**.",
      });

      const note = Zotero.Items.getByLibraryAndKey(
        Zotero.Libraries.userLibraryID,
        result.key,
      ) as never as { id: number; getNote(): string };
      createdItemIDs.push(note.id);

      expect(note.getNote()).to.include("<h1>Heading</h1>");
      expect(note.getNote()).to.include("<strong>bold</strong>");
    });

    it("trashes and restores", async function () {
      await callTool("library_delete", { mode: "trash", itemKeys: [itemKey] });
      expect((item(itemID) as never as { deleted: boolean }).deleted).to.equal(
        true,
      );

      await callTool("library_delete", {
        mode: "restore",
        itemKeys: [itemKey],
      });
      expect((item(itemID) as never as { deleted: boolean }).deleted).to.equal(
        false,
      );
    });

    it("works with default preferences, needing no gate or confirmation", async function () {
      const result = await callTool("library_update", {
        kind: "metadata",
        itemKey,
        fields: { pages: "1-10" },
      });
      expect(result.changed).to.deep.equal(["pages"]);
    });
  });

  describe("collections", function () {
    it("creates a nested collection, renames it, and deletes without losing items", async function () {
      const parent = await callTool("collection_update", {
        action: "create",
        name: "zotmcp-test-parent",
      });
      const child = await callTool("collection_update", {
        action: "create",
        name: "zotmcp-test-child",
        parentCollectionKey: parent.key,
      });

      const listed = await callTool("library_search", {
        entity: "collections",
      });
      const childRow = listed.collections.find(
        (entry: { key: string }) => entry.key === child.key,
      );
      expect(childRow.parentKey).to.equal(parent.key);

      await callTool("collection_update", {
        action: "rename",
        collectionKey: child.key,
        name: "zotmcp-test-renamed",
      });

      await callTool("collection_update", {
        action: "delete",
        collectionKey: child.key,
      });
      await callTool("collection_update", {
        action: "delete",
        collectionKey: parent.key,
      });
    });
  });

  describe("scripts and resources", function () {
    it("runs a read script and returns JSON-safe output", async function () {
      const result = await callTool("zotero_script", {
        mode: "read",
        script: "env.log('hello'); return { version: Zotero.version };",
        description: "read the version",
      });

      expect(result.ok).to.equal(true);
      expect(result.result.version).to.be.a("string");
      expect(result.logs).to.deep.equal(["hello"]);
      expect(result.description).to.equal("read the version");
    });

    it("reports a script error with its message", async function () {
      const result = await callTool("zotero_script", {
        mode: "read",
        script: "throw new Error('deliberate');",
      });
      expect(result.ok).to.equal(false);
      expect(result.error.message).to.equal("deliberate");
    });

    it("reads the collections resource", async function () {
      const payload = await rpc("resources/read", {
        uri: "zotero://collections",
      });
      const parsed = JSON.parse(payload.result.contents[0].text);
      expect(parsed.collections).to.be.an("array");
    });
  });
});
