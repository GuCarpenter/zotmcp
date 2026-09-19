import { expect } from "chai";
import { createToolRegistry, TOOL_NAMES } from "../../src/tools";

/**
 * The MCP surface is a public API. Comparable projects let their documented tool
 * list drift from the code; this test makes the surface fail CI the moment it
 * changes, so a rename or addition is a deliberate act.
 */
const EXPECTED_TOOLS = Object.freeze([
  "annotation_write",
  "attachment_update",
  "collection_update",
  "image_read",
  "library_delete",
  "library_import",
  "library_read",
  "library_search",
  "library_update",
  "note_write",
  "paper_read",
  "reader_navigate",
  "reader_read",
  "zotero_script",
]);

describe("tool surface", function () {
  it("registers exactly the fourteen planned tools", function () {
    const registered = createToolRegistry().names().sort();
    expect(registered).to.deep.equal([...EXPECTED_TOOLS]);
    expect(registered).to.have.length(14);
  });

  it("keeps the canonical TOOL_NAMES list in step with the registry", function () {
    expect([...TOOL_NAMES].sort()).to.deep.equal([...EXPECTED_TOOLS]);
  });

  it("gives every tool a description and an object input schema", function () {
    for (const spec of createToolRegistry().all()) {
      expect(spec.description.length, spec.name).to.be.greaterThan(40);
      expect(spec.inputSchema.type, spec.name).to.equal("object");
      expect(spec.inputSchema.properties, spec.name).to.be.an("object");
    }
  });

  it("marks read tools readOnlyHint and write tools not", function () {
    const entries = createToolRegistry().list();
    const byName = new Map(entries.map((e) => [e.name, e]));

    for (const name of [
      "library_search",
      "library_read",
      "paper_read",
      "reader_read",
      "image_read",
    ]) {
      expect(byName.get(name)!.annotations.readOnlyHint, name).to.equal(true);
    }
    for (const name of [
      "library_update",
      "library_import",
      "note_write",
      "annotation_write",
      "zotero_script",
      "reader_navigate",
    ]) {
      expect(byName.get(name)!.annotations.readOnlyHint, name).to.equal(false);
    }
  });

  it("flags only library_delete as destructive", function () {
    const destructive = createToolRegistry()
      .list()
      .filter((entry) => entry.annotations.destructiveHint)
      .map((entry) => entry.name);
    expect(destructive).to.deep.equal(["library_delete"]);
  });

  it("refuses to register the same tool name twice", function () {
    const registry = createToolRegistry();
    expect(() =>
      registry.register({
        name: "library_search",
        description: "duplicate",
        inputSchema: { type: "object", properties: {} },
        mutability: "read",
        handler: async () => ({ content: [] }),
      }),
    ).to.throw(/already registered/);
  });
});
