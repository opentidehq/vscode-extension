import * as assert from "node:assert/strict";
import {
  countOf,
  kindName,
  OBJECT_ICONS,
  OTHER_ICON,
  objectIcon,
  themeColorVariable,
} from "../../../src/core/catalog/objectIcons";
import { RELATION_WORDS } from "../../../src/core/catalog/relations";

describe("object icons", () => {
  it("gives each kind one codicon and one theme colour, all distinct", () => {
    const kinds = ["threat", "objective", "rule", "signal", "technique", "logsource"] as const;
    assert.deepEqual(Object.keys(OBJECT_ICONS).sort(), [...kinds].sort());
    const codicons = kinds.map((k) => OBJECT_ICONS[k].codicon);
    const colours = kinds.map((k) => OBJECT_ICONS[k].themeColor);
    assert.equal(new Set(codicons).size, kinds.length, codicons.join());
    assert.equal(new Set(colours).size, kinds.length, colours.join());
    for (const kind of kinds) assert.match(OBJECT_ICONS[kind].themeColor, /^[a-zA-Z]+(\.[a-zA-Z]+)+$/, kind);
  });

  it("uses the graph's colours for threats, objectives, signals, rules and techniques", () => {
    assert.equal(themeColorVariable(OBJECT_ICONS.threat.themeColor), "--vscode-charts-red");
    assert.equal(themeColorVariable(OBJECT_ICONS.objective.themeColor), "--vscode-charts-blue");
    assert.equal(themeColorVariable(OBJECT_ICONS.signal.themeColor), "--vscode-charts-purple");
    assert.equal(themeColorVariable(OBJECT_ICONS.rule.themeColor), "--vscode-charts-green");
    assert.equal(themeColorVariable(OBJECT_ICONS.technique.themeColor), "--vscode-charts-orange");
  });

  it("draws a relation to a signal, technique or log source with that end's own icon", () => {
    assert.equal(RELATION_WORDS.signal.icon, OBJECT_ICONS.signal.codicon);
    assert.equal(RELATION_WORDS.technique.icon, OBJECT_ICONS.technique.codicon);
    assert.equal(RELATION_WORDS.logsource.icon, OBJECT_ICONS.logsource.codicon);
    // A group icon never looks like an object row of another kind.
    const objectRows = [OBJECT_ICONS.threat, OBJECT_ICONS.objective, OBJECT_ICONS.rule].map((i) => i.codicon);
    for (const kind of ["implements", "covers", "parent", "chains"] as const)
      assert.ok(!objectRows.includes(RELATION_WORDS[kind].icon), kind);
  });

  it("falls back for a type it does not know, and names kinds and counts", () => {
    assert.equal(objectIcon("actor"), OTHER_ICON);
    assert.equal(objectIcon(null), OTHER_ICON);
    assert.equal(objectIcon("toString"), OTHER_ICON);
    assert.equal(objectIcon("rule"), OBJECT_ICONS.rule);
    assert.equal(kindName("rule"), "Rule");
    assert.equal(kindName("logsource"), "Log source");
    assert.equal(kindName("actor"), "Actor");
    assert.equal(kindName(undefined), "Object");
    assert.equal(countOf(1, "rule"), "1 rule");
    assert.equal(countOf(3, "objective"), "3 objectives");
    assert.equal(countOf(2, undefined), "2 objects");
    assert.equal(countOf(1, "actor"), "1 object");
  });
});
