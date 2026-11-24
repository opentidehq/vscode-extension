import * as assert from "node:assert/strict";

import {
  BACKOFF_MS,
  CRASH_CEILING,
  CRASH_WINDOW_MS,
  recentCrashes,
  restartDecision,
} from "../../../src/core/lsp/restartPolicy";

describe("restartDecision", () => {
  it("backs off 0.5, 1, 2 and 4 seconds over the first four crashes", () => {
    const crashes: number[] = [];
    const waits: unknown[] = [];
    for (let n = 0; n < 4; n += 1) {
      const now = 10_000 + n * 1000;
      crashes.push(now);
      waits.push(restartDecision(crashes, now));
    }
    assert.deepEqual(waits, [
      { restartAfterMs: 500 },
      { restartAfterMs: 1000 },
      { restartAfterMs: 2000 },
      { restartAfterMs: 4000 },
    ]);
  });

  it("gives up on the fifth crash in three minutes", () => {
    const crashes = [0, 10_000, 20_000, 30_000, 40_000];
    assert.deepEqual(restartDecision(crashes, 40_000), { giveUp: true, crashes: 5 });
    assert.equal(CRASH_CEILING, 5);
  });

  it("keeps giving up while the crashes stay in the window", () => {
    const crashes = [0, 1000, 2000, 3000, 4000, 5000];
    assert.deepEqual(restartDecision(crashes, 5000), { giveUp: true, crashes: 6 });
  });

  it("restarts after the fourth crash, not the fifth, when the fifth falls outside the window", () => {
    const crashes = [0, 1000, 2000, 3000];
    // The first crash is exactly one window old: it no longer counts.
    const now = CRASH_WINDOW_MS;
    assert.deepEqual(restartDecision([...crashes, now], now), { restartAfterMs: 4000 });
  });

  it("slides the window: an old crash stops counting and the wait shortens", () => {
    const crashes = [0, 60_000, 120_000, 170_000, 179_999];
    assert.deepEqual(restartDecision(crashes, 179_999), { giveUp: true, crashes: 5 });
    // A moment later the first has left the window.
    assert.deepEqual(restartDecision(crashes, 180_001), { restartAfterMs: 4000 });
    // And far later only the new crash counts: the shortest wait again.
    assert.deepEqual(restartDecision([...crashes, 400_000], 400_000), { restartAfterMs: BACKOFF_MS[0] });
  });

  it("waits the shortest backoff when asked with no crash in the window", () => {
    assert.deepEqual(restartDecision([], 1000), { restartAfterMs: 500 });
  });
});

describe("recentCrashes", () => {
  it("drops the crashes a window or more old", () => {
    assert.deepEqual(recentCrashes([0, 1000, CRASH_WINDOW_MS], CRASH_WINDOW_MS), [1000, CRASH_WINDOW_MS]);
    assert.deepEqual(recentCrashes([1, 2], 3), [1, 2]);
  });
});
