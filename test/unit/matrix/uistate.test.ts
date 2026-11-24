import * as assert from "node:assert/strict";

import { restoreUi } from "../../../src/features/matrix/uistate";

describe("matrix panel state", () => {
  it("restores what the panel saved, including the scroll offset and the focused cell", () => {
    const saved = {
      expanded: ["T1003", "T1059"],
      find: "lsass",
      hideEmpty: true,
      scroll: { left: 420, top: 36 },
      focused: "2:T1003",
    };
    assert.deepEqual(restoreUi(saved), saved);
  });

  it("starts empty with no saved state, and from state saved by an earlier version", () => {
    const empty = {
      expanded: [],
      find: "",
      hideEmpty: false,
      scroll: { left: 0, top: 0 },
      focused: undefined,
    };
    assert.deepEqual(restoreUi(undefined), empty);
    assert.deepEqual(restoreUi({ expanded: ["T1003"], find: "x", hideEmpty: true }), {
      ...empty,
      expanded: ["T1003"],
      find: "x",
      hideEmpty: true,
    });
  });

  it("ignores fields of the wrong shape, one by one", () => {
    const state = restoreUi({
      expanded: ["T1003", 7, null],
      find: 3,
      hideEmpty: "yes",
      scroll: { left: -5, top: Number.NaN },
      focused: "not-a-cell",
    });
    assert.deepEqual(state, {
      expanded: ["T1003"],
      find: "",
      hideEmpty: false,
      scroll: { left: 0, top: 0 },
      focused: undefined,
    });
    assert.deepEqual(restoreUi("junk"), restoreUi(undefined));
    assert.deepEqual(restoreUi(null), restoreUi(undefined));
  });
});
