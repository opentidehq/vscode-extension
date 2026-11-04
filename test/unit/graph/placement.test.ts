import * as assert from "node:assert/strict";
import {
  ACTIVE,
  BESIDE,
  Debounced,
  openColumn,
  showPlan,
  type Timers,
} from "../../../src/features/graph/placement";

describe("graph placement", () => {
  it("opens beside the editor it is asked from, leaving the focus there", () => {
    assert.deepEqual(showPlan({ editorColumn: 1 }), { column: BESIDE, preserveFocus: true });
    assert.deepEqual(showPlan({}), { column: ACTIVE, preserveFocus: false }, "no editor: here, focused");
  });

  it("keeps an open graph where it is, unless it would cover the editor", () => {
    assert.deepEqual(showPlan({ editorColumn: 1, panelColumn: 2 }), {
      column: undefined,
      preserveFocus: true,
    });
    assert.deepEqual(showPlan({ editorColumn: 2, panelColumn: 2 }), { column: BESIDE, preserveFocus: true });
    assert.deepEqual(showPlan({ panelColumn: 2 }), { column: undefined, preserveFocus: true });
  });

  it("opens files in the editor's group, never over the graph", () => {
    assert.equal(openColumn(2, [1, 2]), 1);
    assert.equal(openColumn(2, [2, 3]), 3);
    assert.equal(openColumn(1, [1]), BESIDE);
    assert.equal(openColumn(undefined, []), BESIDE);
  });

  it("follows the editor once a switch storm settles", () => {
    let pending: (() => void) | undefined;
    const timers: Timers = {
      set: (run) => {
        pending = run;
        return 1;
      },
      clear: () => {
        pending = undefined;
      },
    };
    const seen: string[] = [];
    const follow = new Debounced<string>(150, (value) => seen.push(value), timers);
    follow.push("a");
    follow.push("b");
    follow.push("c");
    assert.equal(follow.isPending, true);
    pending?.();
    assert.deepEqual(seen, ["c"], "one follow, for the last editor");
    follow.push("d");
    follow.cancel();
    assert.equal(pending, undefined);
    assert.equal(follow.isPending, false);
  });
});
