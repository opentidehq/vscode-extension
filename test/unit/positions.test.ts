import * as assert from "node:assert/strict";
import {
  cliPosition,
  cliRange,
  codePointColumnToUtf16,
  linesOf,
  utf16ToCodePointColumn,
} from "../../src/core/positions";

describe("CLI positions to editor positions", () => {
  it("counts code points, not UTF-16 units: a finding after an emoji underlines the right characters", () => {
    const line = "name: 🔥 ambr x";
    // 1-based code-point column of "ambr" is 9 ("name: " is 6, the emoji 1, the space 1).
    const start = codePointColumnToUtf16(line, 9);
    const end = codePointColumnToUtf16(line, 13);
    assert.equal(line.slice(start, end), "ambr");
    assert.equal(utf16ToCodePointColumn(line, start), 9);
  });

  it("converts a validate finding (line, column, end_column) to a 0-based range", () => {
    const doc = linesOf("a: 1\nmetadata:\n  tlp: ambr\n");
    assert.deepEqual(cliRange(doc, { line: 3, column: 8, end_column: 12 }), {
      start: { line: 2, character: 7 },
      end: { line: 2, character: 11 },
    });
  });

  it("covers the whole line when there is no column, and clamps out-of-range positions", () => {
    const doc = linesOf("first\nsecond line\n");
    assert.deepEqual(cliRange(doc, { line: 2 }), {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 11 },
    });
    assert.deepEqual(cliPosition(doc, 99, 99), { line: 2, character: 0 });
    assert.deepEqual(cliPosition(doc, 0), { line: 0, character: 0 });
  });

  it("spans lines with end_line", () => {
    const doc = linesOf("query: |\n  Process\n  | where x\n");
    assert.deepEqual(cliRange(doc, { line: 2, column: 3, end_line: 3, end_column: 6 }), {
      start: { line: 1, character: 2 },
      end: { line: 2, character: 5 },
    });
    assert.deepEqual(cliRange(doc, { line: 2, column: 3, end_line: 3 }), {
      start: { line: 1, character: 2 },
      end: { line: 2, character: 11 },
    });
  });
});
