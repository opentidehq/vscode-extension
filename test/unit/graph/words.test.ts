import * as assert from "node:assert/strict";
import { OBJECT_ICONS } from "../../../src/core/catalog/objectIcons";
import { MISSING_ICON, RELATION_WORDS, relationLabel } from "../../../src/core/catalog/relations";
import { ALL_KINDS } from "../../../src/features/graph/model";
import { graphRelationLabel, NODE_ICONS, themeVar, wordsOf } from "../../../src/features/graph/words";

describe("graph words and icons", () => {
  it("uses the catalogue's relation words, and labels the same way relationLabel does", () => {
    for (const kind of Object.keys(RELATION_WORDS) as (keyof typeof RELATION_WORDS)[]) {
      assert.equal(wordsOf(kind), RELATION_WORDS[kind]);
      assert.equal(graphRelationLabel(kind, "out", 2), relationLabel(kind, "out", 2));
      assert.equal(graphRelationLabel(kind, "in"), relationLabel(kind, "in"));
    }
    assert.equal(graphRelationLabel("actor", "out", 1), "Attributed to 1 →");
    assert.equal(graphRelationLabel("platform", "in", 3), "← Platform of 3");
  });

  it("gives every node kind an icon and a colour, the sidebar's for objects", () => {
    for (const kind of ALL_KINDS) assert.ok(NODE_ICONS[kind].codicon && NODE_ICONS[kind].themeColor, kind);
    assert.equal(NODE_ICONS.rule, OBJECT_ICONS.rule);
    assert.equal(NODE_ICONS.threat.codicon, "flame");
    assert.equal(NODE_ICONS.missing.codicon, MISSING_ICON);
    assert.equal(themeVar("charts.red"), "--vscode-charts-red");
    assert.equal(themeVar("terminal.ansiCyan"), "--vscode-terminal-ansiCyan");
  });
});
