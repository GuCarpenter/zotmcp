import { expect } from "chai";
import {
  isWhitespaceChar,
  mergeLineRects,
  rectsForText,
  textUnderRects,
  type TextLeaf,
} from "../../src/services/pdfTextMap";

/**
 * A run is `[header, pageIndex, minX, minY, maxX, maxY, ...widths]`. Header 0
 * means a horizontal, non-hyphenated line. Each width is `[gap, glyphWidth]`.
 */
function leaf(text: string, run: unknown[], pageIndex = 0): TextLeaf {
  return {
    text,
    anchor: { textMap: JSON.stringify([[0, pageIndex, ...run]]) },
  };
}

// "AB CD": four glyphs (space carries no glyph) on one line, y 700-710.
const AB_CD = leaf("AB CD", [
  100,
  700,
  145,
  710,
  [0, 10],
  [0, 10],
  [5, 10],
  [0, 10],
]);

describe("pdfTextMap", function () {
  describe("rectsForText", function () {
    it("returns character-exact rects for a mid-string quote", function () {
      const pos = rectsForText([AB_CD], "B CD");
      expect(pos).to.not.equal(null);
      expect(pos!.pageIndex).to.equal(0);
      // B starts at 110, D ends at 145; the space contributes no glyph.
      expect(pos!.rects).to.deep.equal([[110, 700, 145, 710]]);
    });

    it("clips to just the leading glyphs", function () {
      const pos = rectsForText([AB_CD], "AB");
      expect(pos!.rects).to.deep.equal([[100, 700, 120, 710]]);
    });

    it("returns null when the quote is absent verbatim", function () {
      expect(rectsForText([AB_CD], "XY")).to.equal(null);
    });

    it("returns null when the leaf has no glyph geometry", function () {
      expect(rectsForText([{ text: "AB CD" }], "AB")).to.equal(null);
    });

    it("merges glyphs across leaves on the same line", function () {
      const a = leaf("Hello ", [
        10,
        700,
        60,
        710,
        [0, 10],
        [0, 10],
        [0, 10],
        [0, 10],
        [0, 10],
      ]);
      const b = leaf("World", [
        65,
        700,
        115,
        710,
        [0, 10],
        [0, 10],
        [0, 10],
        [0, 10],
        [0, 10],
      ]);
      const pos = rectsForText([a, b], "lo World");
      expect(pos!.pageIndex).to.equal(0);
      expect(pos!.rects).to.have.length(1);
      expect(pos!.rects[0][1]).to.equal(700);
    });

    it("returns null for a match that spans a page break", function () {
      const a = leaf(
        "firstpage",
        [10, 700, 60, 710, [0, 10], [0, 10], [0, 10], [0, 10], [0, 10]],
        0,
      );
      const b = leaf(
        "nextpage",
        [10, 700, 60, 710, [0, 10], [0, 10], [0, 10], [0, 10]],
        1,
      );
      // "page" appears within each leaf; a phrase crossing both cannot resolve.
      expect(rectsForText([a, b], "firstpagenextpage")).to.equal(null);
    });
  });

  describe("textUnderRects", function () {
    it("reconstructs the glyphs covered by a rectangle", function () {
      const covered = textUnderRects([AB_CD], 0, [[110, 700, 145, 710]]);
      // Whitespace is not represented, so the space between B and C is dropped.
      expect(covered).to.equal("BCD");
    });

    it("round-trips against rectsForText", function () {
      const pos = rectsForText([AB_CD], "AB")!;
      expect(textUnderRects([AB_CD], pos.pageIndex, pos.rects)).to.equal("AB");
    });
  });

  describe("mergeLineRects", function () {
    it("keeps rects on different lines separate", function () {
      const merged = mergeLineRects([
        [10, 700, 20, 710],
        [22, 700, 30, 710],
        [10, 680, 20, 690],
      ]);
      expect(merged).to.have.length(2);
      expect(merged[0]).to.deep.equal([10, 700, 30, 710]);
    });
  });

  describe("isWhitespaceChar", function () {
    it("recognizes space, tab and newline", function () {
      for (const ch of [" ", "\t", "\n"])
        expect(isWhitespaceChar(ch)).to.equal(true);
      expect(isWhitespaceChar("a")).to.equal(false);
    });
  });
});
