import { expect } from "chai";
import {
  extractFrontMatter,
  frontMatterToMetadata,
} from "../../src/services/frontMatter";

describe("frontMatter", function () {
  describe("extractFrontMatter", function () {
    it("splits a YAML block from the body", function () {
      const md = '---\ntitle: "Hello"\n---\n\n# Body\n\ntext';
      const { data, body } = extractFrontMatter(md);
      expect(data.title).to.equal("Hello");
      expect(body).to.equal("# Body\n\ntext");
    });

    it("returns the whole input when there is no front matter", function () {
      const md = "# Just a heading\n\ntext";
      const { data, body } = extractFrontMatter(md);
      expect(data).to.deep.equal({});
      expect(body).to.equal(md);
    });

    it("parses inline arrays and indented lists", function () {
      const inline = '---\nauthors: ["Erik", "Barry"]\n---\nx';
      expect(extractFrontMatter(inline).data.authors).to.deep.equal([
        "Erik",
        "Barry",
      ]);

      const block = "---\ntags:\n  - ml\n  - agents\n---\nx";
      expect(extractFrontMatter(block).data.tags).to.deep.equal([
        "ml",
        "agents",
      ]);
    });
  });

  describe("frontMatterToMetadata", function () {
    it("maps common keys to fields, creators and tags", function () {
      const { fields, creators, tags } = frontMatterToMetadata({
        title: "Building effective agents",
        authors: ["Erik Schluntz", "Barry Zhang"],
        source: "Anthropic Engineering",
        published: "2024-12-19",
        url: "https://example.com/x",
        tags: ["llm"],
      });

      expect(fields.title).to.equal("Building effective agents");
      expect(fields.date).to.equal("2024-12-19");
      expect(fields.url).to.equal("https://example.com/x");
      expect(fields.websiteTitle).to.equal("Anthropic Engineering");
      expect(creators).to.deep.equal([
        { creatorType: "author", name: "Erik Schluntz" },
        { creatorType: "author", name: "Barry Zhang" },
      ]);
      expect(tags).to.deep.equal(["llm"]);
    });

    it("is empty for empty front matter", function () {
      const mapped = frontMatterToMetadata({});
      expect(mapped.fields).to.deep.equal({});
      expect(mapped.creators).to.deep.equal([]);
      expect(mapped.tags).to.deep.equal([]);
    });
  });
});
