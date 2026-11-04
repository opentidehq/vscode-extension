import * as assert from "node:assert/strict";
import { emphasisOf, Incidence, planEmphasis, slices } from "../../../src/features/graph/emphasis";

const edges = [
  { id: "r>o", source: "r", target: "o" },
  { id: "o>t", source: "o", target: "t" },
  { id: "r2>o", source: "r2", target: "o" },
  { id: "o>s", source: "o", target: "s" },
  { id: "t>t2", source: "t", target: "t2" },
  { id: "t2>t", source: "t2", target: "t" },
];

describe("graph emphasis: in and out", () => {
  const incidence = new Incidence(edges);

  it("marks the node, its outgoing edges and targets, and its incoming edges and sources", () => {
    const classes = Object.fromEntries(emphasisOf(incidence, "o"));
    assert.deepEqual(classes, {
      o: "em-center",
      "o>t": "em-out",
      t: "em-out",
      "o>s": "em-out",
      s: "em-out",
      "r>o": "em-in",
      r: "em-in",
      "r2>o": "em-in",
      r2: "em-in",
    });
  });

  it("marks a node that points back as both, and nothing for no node", () => {
    const classes = emphasisOf(incidence, "t");
    assert.equal(classes.get("t2"), "em-both");
    assert.equal(classes.get("t>t2"), "em-out");
    assert.equal(classes.get("t2>t"), "em-in");
    assert.equal(emphasisOf(incidence, undefined).size, 0);
    assert.deepEqual([...incidence.neighbours("o")].sort(), ["r", "r2", "s", "t"]);
  });

  it("dims everything once when an emphasis appears, and undims everything when it goes", () => {
    const none = new Map();
    const shown = emphasisOf(incidence, "r");
    const appear = planEmphasis(none, shown);
    assert.equal(appear.dimming, "all");
    assert.deepEqual(appear.remove, []);
    assert.deepEqual(appear.add.map(([id]) => id).sort(), ["o", "r", "r>o"]);
    const gone = planEmphasis(shown, none);
    assert.equal(gone.dimming, "none");
    assert.deepEqual(gone.add, []);
    assert.deepEqual(gone.remove.map(([id]) => id).sort(), ["o", "r", "r>o"]);
    assert.equal(planEmphasis(none, none).dimming, "diff");
  });

  it("moves an emphasis by difference: only the two neighbourhoods change", () => {
    const from = emphasisOf(incidence, "r");
    const to = emphasisOf(incidence, "s");
    const plan = planEmphasis(from, to);
    assert.equal(plan.dimming, "diff");
    assert.deepEqual([...plan.dim].sort(), ["r", "r>o"], "what left the emphasis is dimmed");
    assert.deepEqual([...plan.undim].sort(), ["o>s", "s"], "what joined it is undimmed");
    // o was the target of r (out) and is the source of s (in): its class changes, nothing else.
    assert.deepEqual(plan.remove, [
      ["r", "em-center"],
      ["r>o", "em-out"],
      ["o", "em-out"],
    ]);
    assert.deepEqual([...plan.add].sort(), [
      ["o", "em-in"],
      ["o>s", "em-in"],
      ["s", "em-center"],
    ]);
  });

  it("spreads a large restyle over slices", () => {
    assert.deepEqual(slices([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(slices([], 2), []);
    assert.deepEqual(slices([1, 2], 0), [[1], [2]]);
  });
});
