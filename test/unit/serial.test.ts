import * as assert from "node:assert/strict";
import { SerialQueue, serialized } from "../../src/core/util/serial";

/** A task whose runs finish when the test says so. */
function gated() {
  const runs: { reason: string; finish: () => void; finished: boolean }[] = [];
  const task = (reason: string): Promise<void> =>
    new Promise<void>((resolve) => {
      const run = {
        reason,
        finished: false,
        finish: () => {
          run.finished = true;
          resolve();
        },
      };
      runs.push(run);
    });
  return { runs, task };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("serialized: restarts run one at a time", () => {
  it("runs a call at once when nothing runs", async () => {
    const { runs, task } = gated();
    const restart = serialized(task);
    const done = restart("activation");
    assert.deepEqual(
      runs.map((r) => r.reason),
      ["activation"],
    );
    runs[0]?.finish();
    await done;
  });

  it("resolves a call made during a run only after the run that follows it", async () => {
    const { runs, task } = gated();
    const restart = serialized(task);
    void restart("settings changed");
    let settled = false;
    const mine = restart("test").then(() => {
      settled = true;
    });
    assert.equal(runs.length, 1, "the second waits for the first");
    runs[0]?.finish();
    await tick();
    assert.deepEqual(
      runs.map((r) => r.reason),
      ["settings changed", "test"],
    );
    assert.equal(settled, false, "the caller's restart has not finished yet");
    runs[1]?.finish();
    await mine;
    assert.equal(runs[1]?.finished, true);
  });

  it("runs once more for every call made meanwhile, with the latest reason", async () => {
    const { runs, task } = gated();
    const restart = serialized(task);
    void restart("a");
    const b = restart("b");
    const c = restart("c");
    runs[0]?.finish();
    await tick();
    assert.deepEqual(
      runs.map((r) => r.reason),
      ["a", "c"],
    );
    runs[1]?.finish();
    await Promise.all([b, c]);
    assert.equal(runs.length, 2);
  });

  it("still runs the queued call when the running one fails", async () => {
    const reasons: string[] = [];
    let fail = true;
    const restart = serialized(async (reason) => {
      reasons.push(reason);
      await tick();
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
    });
    const first = restart("first").catch(() => "failed");
    await restart("second");
    assert.equal(await first, "failed");
    assert.deepEqual(reasons, ["first", "second"]);
  });
});

describe("SerialQueue: the language client's starts and stops", () => {
  it("runs a stop asked for during a start after that start, never in the middle of it", async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    let release: () => void = () => undefined;
    const start = queue.run(async () => {
      log.push("start: begin");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      log.push("start: client up");
    });
    const stop = queue.run(async () => {
      log.push("stop");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(log, ["start: begin"], "the stop waits");
    release();
    await Promise.all([start, stop]);
    assert.deepEqual(log, ["start: begin", "start: client up", "stop"]);
  });

  it("goes on after a task that fails, and hands each caller its own result", async () => {
    const queue = new SerialQueue();
    const failed = queue.run(async () => {
      throw new Error("boom");
    });
    await assert.rejects(failed, /boom/);
    assert.equal(await queue.run(async () => 7), 7);
  });
});
