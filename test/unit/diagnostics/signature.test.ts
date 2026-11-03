import * as assert from "node:assert/strict";
import { itemSignature, type ShownItem } from "../../../src/features/diagnostics/plan";

const range = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end },
});

function item(overrides: Partial<ShownItem["diagnostic"]> = {}, fix: unknown = null): ShownItem {
  return {
    key: "metadata_recommended\u00014",
    diagnostic: {
      message: "Recommended metadata missing: organisation",
      severity: 2,
      range: range(4, 0, 10),
      ...overrides,
    },
    finding: { fix },
  };
}

describe("diagnostics: what a shown finding's signature covers", () => {
  it("is the same for the same rendering", () => {
    assert.equal(itemSignature(item()), itemSignature(item()));
  });

  it("changes with the severity alone (a lint.toml severity override)", () => {
    assert.notEqual(itemSignature(item({ severity: 2 })), itemSignature(item({ severity: 1 })));
  });

  it("changes with the columns or end of the range on the same line", () => {
    assert.notEqual(itemSignature(item()), itemSignature(item({ range: range(4, 2, 12) })));
  });

  it("changes when the fix's edits move", () => {
    const fix = (line: number) => ({ edits: [{ line, column: 3, replacement: "amber" }] });
    assert.notEqual(itemSignature(item({}, fix(4))), itemSignature(item({}, fix(5))));
  });

  it("changes with the related locations", () => {
    const related = (line: number) => [
      {
        message: "defined here",
        location: { uri: { toString: () => "file:///a.yaml" }, range: range(line, 0, 1) },
      },
    ];
    assert.notEqual(
      itemSignature(item({ relatedInformation: related(1) })),
      itemSignature(item({ relatedInformation: related(2) })),
    );
  });
});
