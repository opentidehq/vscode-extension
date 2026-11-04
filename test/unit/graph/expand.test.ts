import * as assert from "node:assert/strict";
import { Incidence } from "../../../src/features/graph/emphasis";
import {
  collapsibleNeighbours,
  hiddenNeighbours,
  NO_OVERRIDES,
  placeNear,
  withOverrides,
} from "../../../src/features/graph/expand";
import { NODE_BOX } from "../../../src/features/graph/layout";
import { buildModel, type NodeKind, OBJECT_KINDS } from "../../../src/features/graph/model";
import { computeView, passesFilters, type ViewOptions } from "../../../src/features/graph/view";
import { sampleCatalog, UUID } from "../catalogFixture";

const options: ViewOptions = {
  mode: "focus",
  focus: [UUID.rule],
  depth: 1,
  kinds: new Set<NodeKind>(OBJECT_KINDS),
  platforms: new Set(),
  statuses: new Set(),
  problemsOnly: false,
};

describe("graph expand and collapse", () => {
  const model = buildModel(sampleCatalog());
  const base = computeView(model, {}, options);
  const passes = (node: Parameters<typeof passesFilters>[0]) => passesFilters(node, options);
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const passesId = (id: string) => {
    const node = byId.get(id);
    return node !== undefined && passes(node);
  };

  it("finds the drawn node's hidden neighbours that the filters let in", () => {
    const drawn = new Set(base.nodes.map((n) => n.id));
    const hidden = hiddenNeighbours(new Incidence(model.edges), drawn, UUID.objective, passesId);
    assert.deepEqual(
      hidden,
      [UUID.signal, UUID.childSignal].sort(),
      "its signals; techniques are filtered out",
    );
    assert.deepEqual(hiddenNeighbours(new Incidence(model.edges), drawn, UUID.rule, passesId), []);
  });

  it("adds expanded nodes and their edges to the view, and takes collapsed ones away", () => {
    const expanded = withOverrides(
      model,
      base,
      { added: new Set([UUID.signal]), removed: new Set() },
      passes,
    );
    const ids = new Set(expanded.nodes.map((n) => n.id));
    assert.ok(ids.has(UUID.signal));
    assert.ok(expanded.edges.some((e) => e.source === UUID.objective && e.target === UUID.signal));
    const collapsed = withOverrides(
      model,
      base,
      { added: new Set(), removed: new Set([UUID.threat]) },
      passes,
    );
    assert.ok(!collapsed.nodes.some((n) => n.id === UUID.threat));
    assert.ok(!collapsed.edges.some((e) => e.target === UUID.threat));
    assert.equal(withOverrides(model, base, NO_OVERRIDES, passes), base, "no overrides: the same view");
    const filtered = withOverrides(
      model,
      base,
      { added: new Set(["technique:T1003.001"]), removed: new Set() },
      passes,
    );
    assert.ok(!filtered.nodes.some((n) => n.id === "technique:T1003.001"), "a filtered-out kind stays out");
  });

  it("collapses only neighbours that link to nothing else drawn, never the focus", () => {
    const view = new Incidence(base.edges);
    assert.deepEqual(collapsibleNeighbours(view, UUID.objective, new Set([UUID.rule])), [UUID.threat]);
    assert.deepEqual(
      collapsibleNeighbours(view, UUID.threat, new Set([UUID.rule])),
      [],
      "o links to the rule",
    );
  });

  it("places new nodes beside their neighbour, upstream left and downstream right, without overlaps", () => {
    const positions = new Map([
      [UUID.objective, { x: 0, y: 0 }],
      [UUID.rule, { x: 240, y: 0 }],
    ]);
    const edges = model.edges;
    const placed = placeNear(positions, [UUID.threat, UUID.signal, UUID.childSignal], edges);
    const threat = placed.get(UUID.threat);
    const signal = placed.get(UUID.signal);
    const child = placed.get(UUID.childSignal);
    assert.ok(threat && threat.x < 0, "a threat goes left of its objective");
    assert.ok(signal && signal.x > 0, "a signal goes right of its objective");
    assert.notDeepEqual(signal, positions.get(UUID.rule), "not on top of the rule");
    assert.ok(child && signal);
    assert.ok(
      Math.abs(child.y - signal.y) >= NODE_BOX.height || Math.abs(child.x - signal.x) >= NODE_BOX.width,
      "two new nodes do not overlap",
    );
    const orphan = placeNear(positions, ["nowhere"], edges).get("nowhere");
    assert.ok(orphan && orphan.y > 0, "a node with no drawn neighbour goes below");
  });
});
