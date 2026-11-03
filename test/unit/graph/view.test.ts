import * as assert from "node:assert/strict";
import { layout } from "../../../src/features/graph/layout";
import { buildModel, type NodeKind, OBJECT_KINDS, techniqueId } from "../../../src/features/graph/model";
import {
  clampDepth,
  computeView,
  initialMode,
  neighbourhood,
  searchNodes,
  type ViewOptions,
} from "../../../src/features/graph/view";
import { sampleCatalog, syntheticCatalog, UUID } from "../catalogFixture";

const base: ViewOptions = {
  mode: "focus",
  focus: [],
  depth: 1,
  kinds: new Set<NodeKind>(OBJECT_KINDS),
  platforms: new Set(),
  statuses: new Set(),
  problemsOnly: false,
};

describe("graph view", () => {
  const model = buildModel(sampleCatalog());
  const ids = (options: Partial<ViewOptions>, problems = {}) =>
    new Set(computeView(model, problems, { ...base, ...options }).nodes.map((n) => n.id));

  it("focuses a rule with its objective and that objective's threat (issue #19)", () => {
    const shown = ids({ focus: [UUID.rule], depth: 1 });
    assert.ok(shown.has(UUID.rule));
    assert.ok(shown.has(UUID.objective));
    assert.ok(shown.has(UUID.threat), "the threat is two hops up, yet always shown");
    assert.ok(!shown.has(UUID.comsvcs), "a sibling rule is two hops away");
  });

  it("climbs from a rule that implements a signal to the signal's objective and threat", () => {
    const shown = ids({ focus: [UUID.comsvcs], depth: 1 });
    for (const id of [UUID.signal, UUID.objective, UUID.threat]) assert.ok(shown.has(id), id);
  });

  it("widens with the depth", () => {
    assert.ok(ids({ focus: [UUID.rule], depth: 2 }).has(UUID.signal));
    assert.ok(ids({ focus: [UUID.rule], depth: 3 }).has(UUID.comsvcs));
    assert.equal(clampDepth(9), 3);
    assert.equal(clampDepth(0), 1);
    assert.equal(clampDepth(Number.NaN), 2);
  });

  it("focuses several nodes at once (from a search)", () => {
    const shown = ids({ focus: [UUID.rule, UUID.broken], depth: 1 });
    assert.ok(shown.has(UUID.rule) && shown.has(UUID.broken) && shown.has(`missing:${UUID.missing}`));
  });

  it("hides optional kinds until they are switched on", () => {
    assert.ok(!ids({ mode: "catalogue" }).has(techniqueId("T1003")));
    const all = ids({
      mode: "catalogue",
      kinds: new Set<NodeKind>([...OBJECT_KINDS, "technique", "logsource"]),
    });
    assert.ok(all.has(techniqueId("T1003")));
    assert.ok(all.has("logsource:DeviceProcessEvents"));
    assert.ok(!all.has("platform:sentinel"));
  });

  it("filters rules by platform and status on the same block", () => {
    const production = ids({ mode: "catalogue", statuses: new Set(["production"]) });
    assert.ok(production.has(UUID.rule), "defender is PRODUCTION");
    const sentinelProduction = ids({
      mode: "catalogue",
      platforms: new Set(["sentinel"]),
      statuses: new Set(["production"]),
    });
    assert.ok(!sentinelProduction.has(UUID.rule), "its sentinel block is DESIGN");
    assert.ok(sentinelProduction.has(UUID.broken));
    assert.ok(sentinelProduction.has(UUID.objective), "non-rules stay");
  });

  it("keeps only problems, dangling references and what they touch with problems only", () => {
    const shown = ids(
      { mode: "catalogue", problemsOnly: true },
      { [UUID.comsvcs]: { errors: 0, warnings: 1 } },
    );
    assert.deepEqual(
      [...shown].sort(),
      [UUID.broken, UUID.comsvcs, "file:objects/rules/bad.yaml", `missing:${UUID.missing}`].sort(),
    );
  });

  it("shows only threats and their chaining in threat chains", () => {
    const view = computeView(model, {}, { ...base, mode: "chains" });
    assert.deepEqual(
      view.nodes.map((n) => n.kind),
      ["threat", "threat"],
    );
    assert.deepEqual(
      view.edges.map((e) => e.kind),
      ["chains"],
    );
  });

  it("says when the focus is not in the view", () => {
    const view = computeView(model, {}, { ...base, focus: [UUID.rule], platforms: new Set(["splunk"]) });
    assert.deepEqual(view.unknownFocus, [UUID.rule]);
    assert.equal(view.nodes.length, 0);
  });

  it("drops missing nodes nothing points at in the catalogue", () => {
    const view = computeView(model, {}, { ...base, mode: "catalogue", platforms: new Set(["splunk"]) });
    assert.ok(!view.nodes.some((n) => n.kind === "missing"));
  });

  it("searches names, UUID prefixes, paths and techniques", () => {
    const nodes = model.nodes;
    assert.ok(searchNodes(nodes, "lsass").has(UUID.rule));
    assert.ok(searchNodes(nodes, "44444444-0000-4000-8000-000000000002").has(UUID.comsvcs));
    assert.ok(searchNodes(nodes, "bad.yaml").has("file:objects/rules/bad.yaml"));
    assert.ok(searchNodes(nodes, "t1003.001").has(UUID.rule));
    assert.equal(searchNodes(nodes, "  ").size, 0);
  });

  it("opens large catalogues in focus mode", () => {
    assert.equal(initialMode(model, false), "catalogue");
    assert.equal(initialMode(model, true), "focus");
    assert.equal(initialMode(buildModel(syntheticCatalog(1500)), false), "focus");
  });

  it("walks the neighbourhood both ways", () => {
    const reached = neighbourhood(model.edges, [UUID.threat], 1);
    assert.ok(reached.has(UUID.objective) && reached.has(UUID.lateral));
  });

  for (const size of [500, 2000]) {
    it(`computes and lays out a focus view of a ${size}-object catalogue within the 300 ms budget`, () => {
      const big = buildModel(syntheticCatalog(size));
      const started = performance.now();
      const view = computeView(big, {}, { ...base, focus: ["r-42"], depth: 2 });
      layout(view.nodes, view.edges);
      const elapsed = performance.now() - started;
      assert.ok(view.nodes.length > 3);
      assert.ok(elapsed < 300, `took ${Math.round(elapsed)} ms`);
    });
  }
});
