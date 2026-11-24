// The page watchdog (src/core/webview/watchdog.ts): a workaround for a VS Code webview behaviour, a page that never
// runs after the first page of its view type was closed while it loaded.
import * as assert from "node:assert/strict";

import { LoadWatchdog } from "../../../src/core/webview/watchdog";

/** A watchdog on a fake clock: `tick` runs the pending timer. */
function make(visible = true) {
  const state = { visible, replaced: 0, logs: [] as string[] };
  let pending: (() => void) | undefined;
  let armed = 0;
  const watchdog = new LoadWatchdog(
    "opentide.graph",
    {
      visible: () => state.visible,
      replace: () => void (state.replaced += 1),
      log: (level, message) => void state.logs.push(`${level}: ${message}`),
      setTimer: (run) => {
        armed += 1;
        pending = run;
        return armed;
      },
      clearTimer: () => {
        pending = undefined;
      },
    },
    10_000,
  );
  const tick = () => {
    const run = pending;
    pending = undefined;
    run?.();
  };
  return { watchdog, state, tick, isArmed: () => pending !== undefined };
}

describe("page watchdog", () => {
  it("replaces the panel of a visible page that said nothing, and says so", () => {
    const { state, tick, isArmed } = make();
    assert.ok(isArmed());
    tick();
    assert.equal(state.replaced, 1);
    assert.deepEqual(state.logs, [
      "info: the page of opentide.graph sent nothing in 10 s: opening it again in a new panel",
    ]);
    assert.ok(isArmed(), "it waits again, for the new panel's page");
  });

  it("stops for good at the page's first message, any message", () => {
    const { watchdog, state, tick, isArmed } = make();
    watchdog.heard();
    assert.ok(!isArmed());
    tick();
    watchdog.visibilityChanged();
    assert.ok(!isArmed(), "showing it again does not start a wait");
    assert.equal(state.replaced, 0);
  });

  it("does not run while the panel is hidden, and starts over when it is shown", () => {
    const { watchdog, state, tick, isArmed } = make(false);
    assert.ok(!isArmed(), "a hidden panel may not load until it is shown");
    tick();
    assert.equal(state.replaced, 0);
    state.visible = true;
    watchdog.visibilityChanged();
    assert.ok(isArmed());
    state.visible = false;
    watchdog.visibilityChanged();
    assert.ok(!isArmed(), "hidden again: the wait stops");
    state.visible = true;
    watchdog.visibilityChanged();
    tick();
    assert.equal(state.replaced, 1);
  });

  it("replaces a panel at most once: a replacement silent too is only a warning", () => {
    const { state, tick, isArmed } = make();
    tick();
    tick();
    assert.equal(state.replaced, 1, "never a second replacement, so it cannot loop");
    assert.equal(
      state.logs[1],
      "warn: the page of opentide.graph still sent nothing 10 s after its panel was replaced",
    );
    assert.ok(!isArmed());
    tick();
    assert.equal(state.logs.length, 2);
  });

  it("stops when the panel goes", () => {
    const { watchdog, state, tick, isArmed } = make();
    watchdog.dispose();
    assert.ok(!isArmed());
    tick();
    assert.equal(state.replaced, 0);
  });
});
