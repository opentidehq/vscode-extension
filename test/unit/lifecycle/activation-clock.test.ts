// The activation test's CPU and GC figures (src/core/activationClock.ts): what tells a slow feature from a host
// that was collecting garbage or not running when that feature activated.
import * as assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { overlapMs, threadCpuClock, watchGc } from "../../../src/core/activationClock";

describe("activation clock", () => {
  it("counts the part of each pause inside a span, and nothing outside it", () => {
    const span = { at: 100, ms: 50 };
    assert.equal(overlapMs(span, []), 0);
    assert.equal(overlapMs(span, [{ at: 110, ms: 5 }]), 5, "inside");
    assert.equal(overlapMs(span, [{ at: 90, ms: 20 }]), 10, "across the start");
    assert.equal(overlapMs(span, [{ at: 140, ms: 30 }]), 10, "across the end");
    assert.equal(overlapMs(span, [{ at: 50, ms: 200 }]), 50, "around it");
    assert.equal(
      overlapMs(span, [
        { at: 0, ms: 100 },
        { at: 150, ms: 9 },
      ]),
      0,
      "touching is not inside",
    );
    assert.equal(
      overlapMs(span, [
        { at: 100, ms: 1 },
        { at: 120, ms: 2 },
      ]),
      3,
    );
  });

  it("reads this thread's CPU time where Node has a per-thread clock, and has none where it does not", () => {
    assert.equal(threadCpuClock({}), undefined, "VS Code 1.91's Node has no process.threadCpuUsage");
    const fake = threadCpuClock({ threadCpuUsage: () => ({ user: 1500, system: 500 }) });
    assert.equal(fake?.(), 2, "microseconds to milliseconds, user and system");
    const clock = threadCpuClock();
    if (!clock) return;
    const before = clock();
    const until = performance.now() + 30;
    while (performance.now() < until);
    const spent = clock() - before;
    assert.ok(spent >= 15, `30 ms of busy loop is CPU time on this thread: ${spent}`);
  });

  it("sees a GC pause once a task has passed, on the timeline performance.now() uses", async () => {
    const watch = watchGc();
    assert.ok(watch, "Node reports GC entries");
    const began = performance.now();
    let keep: unknown[] = [];
    for (let round = 0; round < 20; round++)
      keep = Array.from({ length: 50_000 }, (_, i) => ({ i, s: `x${i}` }));
    assert.ok(keep.length > 0);
    await new Promise((resolve) => setImmediate(resolve));
    const pauses = watch.pauses();
    watch.dispose();
    assert.ok(pauses.length > 0, "allocating 1M objects collects at least once");
    for (const pause of pauses) {
      assert.ok(
        pause.at >= began - 1 && pause.at <= performance.now(),
        `pause at ${pause.at}, began ${began}`,
      );
      assert.ok(pause.ms >= 0);
    }
  });
});
