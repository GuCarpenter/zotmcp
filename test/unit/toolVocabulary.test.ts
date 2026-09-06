import { expect } from "chai";
import { createToolRegistry } from "../../src/tools";

/**
 * Out-of-scope capabilities must not leak into the model-facing surface. A tool
 * description that mentions something the plugin does not do makes the model
 * attempt it and report a failure to the user, so the vocabulary is enforced.
 */
const FORBIDDEN = [
  "semantic",
  "embedding",
  "vector",
  "cosine",
  "undo",
  "revert",
  "approval",
  "confirmation",
  "group librar",
  "openalex",
  "arxiv search",
  "europe pmc",
  "scite",
  "mineru",
  "outline",
];

describe("tool vocabulary", function () {
  it("never advertises an out-of-scope capability", function () {
    for (const spec of createToolRegistry().all()) {
      const haystack = [
        spec.name,
        spec.description,
        JSON.stringify(spec.inputSchema),
      ]
        .join(" ")
        .toLowerCase();

      for (const term of FORBIDDEN) {
        expect(haystack, `${spec.name} mentions "${term}"`).to.not.include(
          term,
        );
      }
    }
  });

  it("scopes the searchable library to My Library", function () {
    const search = createToolRegistry().get("library_search")!;
    expect(search.description).to.include("My Library");
  });
});
