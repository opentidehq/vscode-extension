import * as assert from "node:assert/strict";
import {
  describe as describeNode,
  incomingLabel,
  keptFocus,
  listGroups,
  opensMenu,
} from "../../../src/features/graph/list";
import { buildModel, type NodeKind, OBJECT_KINDS } from "../../../src/features/graph/model";
import { computeView } from "../../../src/features/graph/view";
import { sampleCatalog, UUID } from "../catalogFixture";

describe("graph as a list", () => {
  const model = buildModel(sampleCatalog());
  const view = computeView(
    model,
    {},
    {
      mode: "catalogue",
      focus: [],
      depth: 1,
      kinds: new Set<NodeKind>(OBJECT_KINDS),
      platforms: new Set(),
      statuses: new Set(),
      problemsOnly: false,
    },
  );
  const groups = listGroups(view, { [UUID.rule]: { errors: 2, warnings: 0 } });

  it("groups the same nodes as the canvas by kind, sorted by name", () => {
    assert.deepEqual(
      groups.map((g) => g.label),
      ["Threats (2)", "Objectives (2)", "Signals (2)", "Rules (4)", "Missing references (1)"],
    );
    assert.equal(
      groups.reduce((sum, g) => sum + g.nodes.length, 0),
      view.nodes.length,
    );
    assert.deepEqual(
      groups[0]?.nodes.map((n) => n.node.label),
      ["Credential Dumping", "Lateral Movement"],
    );
  });

  it("lists each node's links both ways, as sentences", () => {
    const objective = groups[1]?.nodes.find((n) => n.node.id === UUID.objective);
    const texts = objective?.links.map((l) => l.text) ?? [];
    assert.ok(texts.includes("covers Credential Dumping"));
    assert.ok(texts.includes("implemented by Suspicious LSASS Access"));
    assert.ok(texts.includes("has signal LSASS handle opened"));
    const broken = groups[3]?.nodes.find((n) => n.node.id === UUID.broken);
    assert.equal(broken?.links[0]?.missing, true);
    assert.equal(incomingLabel({ kind: "chains", relation: "sequence::preceeds" }), "preceeds (from)");
  });

  it("describes problems, platforms and techniques", () => {
    const rule = groups[3]?.nodes.find((n) => n.node.id === UUID.rule);
    assert.equal(rule?.description, "2 errors · sentinel DESIGN, defender PRODUCTION · T1003.001, T1003");
    const bad = model.nodes.find((n) => n.id === "file:objects/rules/bad.yaml");
    assert.match(bad ? describeNode(bad, {}) : "", /^failed to load: mapping values/);
  });
});

describe("graph list: the node menu by keyboard", () => {
  it("opens with the ContextMenu key and Shift+F10, as VS Code's own trees do", () => {
    assert.ok(opensMenu({ key: "ContextMenu", shiftKey: false }));
    assert.ok(opensMenu({ key: "F10", shiftKey: true }));
    assert.ok(!opensMenu({ key: "F10", shiftKey: false }));
    assert.ok(!opensMenu({ key: "Enter", shiftKey: true }));
  });
});

describe("graph list: the focus across a redraw", () => {
  const kinds: Record<string, string> = { r1: "rule", o1: "objective" };
  const kindOf = (id: string) => kinds[id];

  it("keeps the focused item, else the closest one still listed", () => {
    const keys = ["group:objective", "node:o1", "link:o1:0", "group:rule", "node:r1"];
    assert.equal(keptFocus("link:o1:0", keys, kindOf), "link:o1:0");
    assert.equal(keptFocus("link:o1:3", keys, kindOf), "node:o1", "a link that went: its node");
    assert.equal(
      keptFocus("node:r2", keys, (id) => (id === "r2" ? "rule" : undefined)),
      "group:rule",
    );
    assert.equal(
      keptFocus("node:gone", keys, () => undefined),
      "group:objective",
      "else the first",
    );
    assert.equal(keptFocus("", keys, kindOf), "group:objective");
    assert.equal(keptFocus("node:r1", [], kindOf), undefined);
  });
});
