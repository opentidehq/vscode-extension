import * as assert from "node:assert/strict";

import { type Clock, CrashSupervisor } from "../../../src/core/lsp/crashSupervisor";

/** A clock the test moves: timers fire when `advance` reaches them. */
class FakeClock implements Clock {
  at = 1_000_000;
  private timers: { due: number; fire: () => void }[] = [];
  now(): number {
    return this.at;
  }
  after(ms: number, fire: () => void): () => void {
    const timer = { due: this.at + ms, fire };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }
  advance(ms: number): void {
    this.at += ms;
    const due = this.timers.filter((t) => t.due <= this.at);
    this.timers = this.timers.filter((t) => t.due > this.at);
    for (const timer of due) timer.fire();
  }
  get pending(): number {
    return this.timers.length;
  }
}

describe("CrashSupervisor", () => {
  it("restarts after 0.5, 1, 2 and 4 s, then gives up on the fifth crash", () => {
    const clock = new FakeClock();
    const supervisor = new CrashSupervisor(clock);
    const decisions = [];
    for (let n = 0; n < 5; n += 1) {
      decisions.push(supervisor.crashed());
      clock.advance(10_000);
    }
    assert.deepEqual(decisions, [
      { restartAfterMs: 500, crashesInWindow: 1 },
      { restartAfterMs: 1000, crashesInWindow: 2 },
      { restartAfterMs: 2000, crashesInWindow: 3 },
      { restartAfterMs: 4000, crashesInWindow: 4 },
      { giveUp: true, crashes: 5, crashesInWindow: 5 },
    ]);
  });

  it("forgets crashes older than three minutes", () => {
    const clock = new FakeClock();
    const supervisor = new CrashSupervisor(clock);
    for (let n = 0; n < 4; n += 1) supervisor.crashed();
    clock.advance(3 * 60 * 1000);
    assert.deepEqual(supervisor.crashed(), { restartAfterMs: 500, crashesInWindow: 1 });
  });

  it("waits, then lets the restart go ahead", async () => {
    const clock = new FakeClock();
    const supervisor = new CrashSupervisor(clock);
    const waited = supervisor.wait(1000);
    clock.advance(999);
    assert.equal(clock.pending, 1);
    clock.advance(1);
    assert.equal(await waited, true);
  });

  it("cancels a wait in progress, and clears its timer", async () => {
    const clock = new FakeClock();
    const supervisor = new CrashSupervisor(clock);
    const waited = supervisor.wait(4000);
    assert.equal(supervisor.cancel(), true, "a wait was interrupted");
    assert.equal(await waited, false);
    assert.equal(clock.pending, 0);
  });

  it("does not wait at all once cancelled", async () => {
    const clock = new FakeClock();
    const supervisor = new CrashSupervisor(clock);
    assert.equal(supervisor.cancel(), false, "nothing was waiting");
    assert.equal(await supervisor.wait(500), false);
    assert.equal(clock.pending, 0);
  });
});
