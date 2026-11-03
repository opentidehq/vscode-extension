import * as assert from "node:assert/strict";
import {
  isChanged,
  markerRange,
  nextPlaceholder,
  placeholderKey,
  placeholderLines,
  placeholderSelection,
  placeholderSnapshot,
  placeholderValue,
} from "../../../src/features/new-object/placeholders";

// What `opentide new rule --platform sentinel` writes (0.21.0), trimmed.
const RULE = [
  "name: Test Rule",
  "metadata:",
  "  tlp: amber",
  "  #reviewed: YYYY-MM-DD",
  "description: |  # opentide:placeholder",
  "  ...",
  "#techniques:  # opentide:placeholder",
  "configurations:",
  "  sentinel:",
  "    query: |  # opentide:placeholder",
  "      ...",
  "    scheduling:",
  "      frequency: 1h  # opentide:placeholder",
  "      lookback: 1h  # opentide:placeholder",
  "      entities:",
  "        - Host::Account  # opentide:placeholder",
];

describe("new-object: placeholders", () => {
  it("finds the marked lines, not commented-out keys", () => {
    assert.deepEqual(placeholderLines(RULE), [4, 9, 12, 13, 15]);
  });

  it("selects the value, or a block scalar's first line", () => {
    assert.deepEqual(placeholderSelection(RULE, 12), { line: 12, start: 17, end: 19 });
    assert.equal(RULE[12]?.slice(17, 19), "1h");
    assert.deepEqual(placeholderSelection(RULE, 4), { line: 5, start: 2, end: 5 });
    assert.deepEqual(placeholderSelection(RULE, 15), { line: 15, start: 10, end: 23 });
    assert.equal(RULE[15]?.slice(10, 23), "Host::Account");
  });

  it("visits every placeholder in order, wrapping both ways", () => {
    const lines = placeholderLines(RULE);
    const visited: number[] = [];
    let at = -1;
    for (let i = 0; i < lines.length; i++) {
      at = nextPlaceholder(lines, at, 1) ?? -1;
      visited.push(at);
    }
    assert.deepEqual(visited, lines);
    assert.equal(nextPlaceholder(lines, 15, 1), 4, "wraps to the first");
    assert.equal(nextPlaceholder(lines, 4, -1), 15, "wraps to the last");
    assert.equal(nextPlaceholder([], 0, 1), undefined);
  });

  it("tells a changed value from what opentide new wrote, block scalars included", () => {
    const snapshot = placeholderSnapshot(RULE);
    assert.equal(snapshot.get(placeholderKey(RULE, 12)), "1h");
    assert.equal(isChanged(RULE, 12, snapshot.get(placeholderKey(RULE, 12))), false);
    const edited = [...RULE];
    edited[12] = "      frequency: 5m  # opentide:placeholder";
    edited[5] = "  Detects LSASS access.";
    assert.equal(isChanged(edited, 12, snapshot.get(placeholderKey(edited, 12))), true);
    assert.equal(placeholderValue(edited, 4), "Detects LSASS access.");
    assert.equal(isChanged(edited, 4, snapshot.get(placeholderKey(edited, 4))), true);
    assert.equal(isChanged(RULE, 4, undefined), false, "`...` is never done");
  });

  it("keys same-named placeholders by occurrence, so two `query:` blocks stay apart", () => {
    const two = ["a:", "  query: x  # opentide:placeholder", "b:", "  query: y  # opentide:placeholder"];
    assert.notEqual(placeholderKey(two, 1), placeholderKey(two, 3));
  });

  it("removes only the marker and the spaces before it", () => {
    const range = markerRange(RULE, 12);
    assert.ok(range);
    const line = RULE[12] ?? "";
    assert.equal(line.slice(0, range.start) + line.slice(range.end), "      frequency: 1h");
    assert.equal(markerRange(RULE, 0), undefined);
  });
});
