import * as assert from "node:assert/strict";
import { DetailsIndex } from "../../../src/features/graph/details";
import {
  describe as describeNode,
  KEY_SEPARATOR,
  keptFocus,
  listGroups,
  listKey,
  opensMenu,
  parentKey,
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
  const groups = listGroups(view, { [UUID.rule]: { errors: 2, warnings: 0 } }, new DetailsIndex(model));

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

  it("lists each node's relations as the details pane does: out groups, then in, with counts", () => {
    const objective = groups[1]?.nodes.find((n) => n.node.id === UUID.objective);
    assert.deepEqual(
      objective?.relations.map((r) => r.header),
      ["Covers 1 →", "Has signal 2 →", "Technique 1 →", "← Implemented by 1"],
    );
    const implementers = objective?.relations.find((r) => r.kind === "implements" && r.direction === "in");
    assert.deepEqual(
      implementers?.items.map((i) => i.label),
      ["Suspicious LSASS Access"],
    );
    const broken = groups[3]?.nodes.find((n) => n.node.id === UUID.broken);
    assert.equal(broken?.relations[0]?.items[0]?.missing, true);
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
  const kinds: Record<string, string> = { r1: "rule", o1: "objective", "technique:T1": "technique" };
  const kindOf = (id: string) => kinds[id];
  const out = { direction: "out", kind: "implements", relation: null } as const;

  it("keeps the focused item, else the closest one still listed", () => {
    const keys = [
      "group:objective",
      "node:o1",
      listKey.relation("o1", out),
      listKey.link("o1", out, 0),
      "group:rule",
      "node:r1",
    ];
    assert.equal(keptFocus(listKey.link("o1", out, 0), keys, kindOf), listKey.link("o1", out, 0));
    assert.equal(
      keptFocus(listKey.link("o1", out, 3), keys, kindOf),
      listKey.relation("o1", out),
      "a link that went: its relation group",
    );
    assert.equal(
      keptFocus(listKey.relation("o1", { direction: "in", kind: "covers", relation: null }), keys, kindOf),
      "node:o1",
      "a group that went: its node",
    );
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

  it("keeps ids with colons and slashes whole in the keys", () => {
    const id = "technique:T1";
    const key = listKey.link(id, out, 2);
    assert.ok(key.includes(KEY_SEPARATOR));
    assert.equal(parentKey(key, kindOf), listKey.relation(id, out));
    assert.equal(parentKey(listKey.relation(id, out), kindOf), `node:${id}`);
    assert.equal(parentKey(`node:${id}`, kindOf), "group:technique");
    assert.equal(parentKey("group:technique", kindOf), undefined);
  });
});
