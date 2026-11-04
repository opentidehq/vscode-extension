import * as assert from "node:assert/strict";
import { SelectionHistory, withoutGone } from "../../../src/features/graph/history";

describe("graph selection history", () => {
  it("goes back and forward, and a new selection drops what was ahead", () => {
    const history = new SelectionHistory();
    assert.equal(history.canBack, false);
    for (const id of ["a", "b", "b", "c"]) history.visit(id);
    assert.equal(history.current, "c");
    assert.equal(history.back(), "b");
    assert.equal(history.back(), "a");
    assert.equal(history.back(), undefined, "nothing before the first");
    assert.equal(history.forward(), "b");
    history.visit("d");
    assert.equal(history.canForward, false, "c is gone");
    assert.equal(history.back(), "b");
    assert.equal(history.back(), "a");
  });

  it("keeps at most `limit` entries", () => {
    const history = new SelectionHistory(3);
    for (const id of ["a", "b", "c", "d"]) history.visit(id);
    assert.equal(history.back(), "c");
    assert.equal(history.back(), "b");
    assert.equal(history.canBack, false);
  });

  it("drops nodes that left the catalogue, and the repeats that leaves", () => {
    const history = new SelectionHistory();
    for (const id of ["a", "x", "a", "b", "x", "c"]) history.visit(id);
    history.back();
    history.back(); // on b
    history.retain((id) => id !== "x");
    assert.equal(history.current, "b");
    assert.equal(history.back(), "a");
    assert.equal(history.canBack, false, "a, x, a became a");
    assert.equal(history.forward(), "b");
    assert.equal(history.forward(), "c");
    history.retain(() => false);
    assert.equal(history.current, undefined);
    history.visit("z");
    assert.equal(history.current, "z");
  });
});

describe("graph: selected and hovered nodes across a catalogue change", () => {
  it("forgets a selection the model lost and a hover over a node no longer drawn", () => {
    const inModel = (id: string) => id !== "gone";
    const drawn = (id: string) => id !== "gone" && id !== "filtered";
    assert.deepEqual(withoutGone({ selected: "gone", hovered: "gone" }, inModel, drawn), {
      selected: undefined,
      hovered: undefined,
    });
    assert.deepEqual(withoutGone({ selected: "filtered", hovered: "filtered" }, inModel, drawn), {
      selected: "filtered",
      hovered: undefined,
    });
    assert.deepEqual(withoutGone({ selected: "a", hovered: "b" }, inModel, drawn), {
      selected: "a",
      hovered: "b",
    });
  });
});
