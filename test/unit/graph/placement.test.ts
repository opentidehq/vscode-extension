import * as assert from "node:assert/strict";
import {
  ACTIVE,
  BESIDE,
  Debounced,
  EditorFollow,
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

describe("graph: follow editor and the pin", () => {
  function setup() {
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
    const followed: string[] = [];
    const follow = new EditorFollow<string>(150, (editor) => followed.push(editor), timers);
    return { follow, followed, fire: () => pending?.() };
  }

  it("follows the active editor once the switches settle, and remembers the last one", () => {
    const { follow, followed, fire } = setup();
    follow.editorChanged("a.yaml", true);
    follow.editorChanged("b.yaml", true);
    fire();
    assert.deepEqual(followed, ["b.yaml"]);
    follow.editorChanged(undefined, true);
    assert.equal(follow.lastEditor, "b.yaml", "the graph taking the focus is no editor change");
  });

  it("catches up on unpin with the last editor, though the graph has the focus", () => {
    const { follow } = setup();
    follow.editorChanged("rule.yaml", true);
    assert.equal(follow.setFollowing(false), undefined);
    follow.editorChanged(undefined, true);
    assert.equal(follow.setFollowing(true), "rule.yaml");
  });

  it("drops, on pin, a follow waiting for its delay and a followed file awaiting the catalogue", () => {
    const { follow, followed, fire } = setup();
    follow.editorChanged("a.yaml", true);
    follow.awaitFile({ path: "/ws/a.yaml", explicit: false });
    follow.setFollowing(false);
    fire();
    assert.deepEqual(followed, [], "the pending follow is gone");
    assert.equal(follow.takeAwaited(), undefined, "the catalogue arriving does not move a pinned graph");
    follow.editorChanged("b.yaml", true);
    fire();
    assert.deepEqual(followed, [], "pinned: no follow");
  });

  it("keeps an explicitly awaited file through a pin, and lets an explicit request cancel a follow", () => {
    const { follow, followed, fire } = setup();
    follow.awaitFile({ path: "/ws/asked.yaml", explicit: true });
    follow.setFollowing(false);
    assert.deepEqual(follow.takeAwaited(), { path: "/ws/asked.yaml", explicit: true });
    assert.equal(follow.takeAwaited(), undefined, "once");
    follow.setFollowing(true);
    follow.editorChanged("other.yaml", true);
    follow.explicitRequest();
    fire();
    assert.deepEqual(followed, [], "Show in Graph wins over the follow still waiting");
  });

  it("follows nothing while the panel is closed, and starts following again when it closes", () => {
    const { follow, followed, fire } = setup();
    follow.editorChanged("a.yaml", false);
    fire();
    assert.deepEqual(followed, []);
    follow.setFollowing(false);
    follow.reset();
    assert.equal(follow.following, true);
  });
});
