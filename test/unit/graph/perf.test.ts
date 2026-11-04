// The graph's budgets at scale (SPEC §14): what a hover, a selection and a catalogue change cost in
// the vscode-free code the webview runs, on a synthetic catalogue of 2,000 and 5,000 objects. The
// Cytoscape side (classes, drawing) is measured in a real VS Code; see SPEC §10.1 "Scale".
import * as assert from "node:assert/strict";
import { DetailsIndex } from "../../../src/features/graph/details";
import { diffModels } from "../../../src/features/graph/diff";
import { emphasisOf, Incidence, planEmphasis } from "../../../src/features/graph/emphasis";
import { hiddenNeighbours, placeNear, withOverrides } from "../../../src/features/graph/expand";
import { layout } from "../../../src/features/graph/layout";
import { listGroups } from "../../../src/features/graph/list";
import { buildModel, type NodeKind, OBJECT_KINDS } from "../../../src/features/graph/model";
import { computeView, passesFilters, type ViewOptions } from "../../../src/features/graph/view";
import { syntheticCatalog } from "../catalogFixture";

const catalogue: ViewOptions = {
  mode: "catalogue",
  focus: [],
  depth: 1,
  kinds: new Set<NodeKind>(OBJECT_KINDS),
  platforms: new Set(),
  statuses: new Set(),
  problemsOnly: false,
};

/** The slowest of `runs` calls, in ms. */
function worst(runs: number, run: (index: number) => void): number {
  let slowest = 0;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    run(i);
    slowest = Math.max(slowest, performance.now() - started);
  }
  return slowest;
}

for (const size of [2000, 5000]) {
  describe(`graph at ${size.toLocaleString("en")} objects`, () => {
    const model = buildModel(syntheticCatalog(size));
    const view = computeView(model, {}, catalogue);
    const viewIndex = new Incidence(view.edges);
    const details = new DetailsIndex(model);
    const ids = view.nodes.map((node) => node.id);

    it("computes and lays out the Catalogue view, the first paint's work, in under 1.5 s", () => {
      const started = performance.now();
      const fresh = computeView(model, {}, catalogue);
      const positions = layout(fresh.nodes, fresh.edges);
      const elapsed = performance.now() - started;
      assert.equal(positions.size, fresh.nodes.length);
      assert.ok(elapsed < 1500, `${fresh.nodes.length} nodes took ${Math.round(elapsed)} ms`);
    });

    it("works out a hover's or a selection's emphasis, and its change, in well under a frame", () => {
      let previous = emphasisOf(viewIndex, undefined);
      // Objectives and threats have the most edges: the worst case for a hover.
      const busiest = [...ids].sort((a, b) => viewIndex.neighbours(b).size - viewIndex.neighbours(a).size);
      const slowest = worst(200, (i) => {
        const next = emphasisOf(viewIndex, busiest[i % 20]);
        planEmphasis(previous, next);
        previous = next;
      });
      assert.ok(slowest < 16, `the slowest hover took ${slowest.toFixed(2)} ms`);
    });

    it("builds the selected node's details pane in well under a frame", () => {
      const slowest = worst(200, (i) => {
        details.details(ids[(i * 37) % ids.length] as string);
      });
      assert.ok(slowest < 16, `the slowest details took ${slowest.toFixed(2)} ms`);
    });

    it("indexes the model's relations once per catalogue in under 300 ms", () => {
      const started = performance.now();
      new DetailsIndex(model);
      new Incidence(model.edges);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 300, `took ${Math.round(elapsed)} ms`);
    });

    it("expands a node in place: the new view and the new nodes' places, without a layout", () => {
      const focus: ViewOptions = { ...catalogue, mode: "focus", focus: ["r-1"] };
      const base = computeView(model, {}, focus);
      const positions = layout(base.nodes, base.edges);
      const drawn = new Set(base.nodes.map((n) => n.id));
      const byId = new Map(model.nodes.map((node) => [node.id, node]));
      const started = performance.now();
      const hidden = hiddenNeighbours(new Incidence(model.edges), drawn, "o-1", (id) => {
        const node = byId.get(id);
        return node !== undefined && passesFilters(node, focus);
      });
      const next = withOverrides(model, base, { added: new Set(hidden), removed: new Set() }, (node) =>
        passesFilters(node, focus),
      );
      const placed = placeNear(positions, hidden, next.edges);
      const elapsed = performance.now() - started;
      assert.ok(hidden.length > 0);
      assert.equal(placed.size, hidden.length);
      assert.ok(elapsed < 150, `took ${Math.round(elapsed)} ms`);
    });

    it("diffs a changed catalogue into a patch in under 300 ms", () => {
      const next = {
        ...model,
        nodes: model.nodes.map((n) => (n.id === "r-3" ? { ...n, label: "changed" } : n)),
      };
      const started = performance.now();
      const patch = diffModels(model, next, 1, 2);
      const elapsed = performance.now() - started;
      assert.equal(patch.nodes.length, 1);
      assert.ok(elapsed < 300, `took ${Math.round(elapsed)} ms`);
    });

    it("lists the Catalogue view as a tree in under 500 ms", () => {
      const started = performance.now();
      const groups = listGroups(view, {}, details);
      const elapsed = performance.now() - started;
      assert.equal(
        groups.reduce((sum, g) => sum + g.nodes.length, 0),
        view.nodes.length,
      );
      assert.ok(elapsed < 500, `took ${Math.round(elapsed)} ms`);
    });
  });
}
