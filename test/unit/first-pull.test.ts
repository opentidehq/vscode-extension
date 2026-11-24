import * as assert from "node:assert/strict";

import { FIRST_PULL_WAIT_MS, FirstPullGuard } from "../../src/core/services/firstPull";

const A = "file:///w/detections/rules/a.yaml";
const B = "file:///w/detections/rules/b.yaml";
type Report = { kind: "full" | "unchanged"; items: string[] };
const empty: Report = { kind: "full", items: [] };
const full: Report = { kind: "full", items: ["tlp"] };
const isEmpty = (report: Report): boolean => report.kind === "full" && report.items.length === 0;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A server that answers from `answers` in turn, and counts the pulls. */
function server(...answers: Report[]): { pull: () => Promise<Report>; calls: () => number } {
  let calls = 0;
  return {
    pull: async () => answers[Math.min(calls++, answers.length - 1)] ?? empty,
    calls: () => calls,
  };
}

describe("a pull that overtook its didOpen (firstPull)", () => {
  it("leaves a pull that came after the didOpen alone, whatever it answered", async () => {
    const guard = new FirstPullGuard(20);
    guard.opened(A);
    const s = server(empty);
    assert.deepEqual(await guard.provide(A, s.pull, isEmpty, s.pull), empty);
    assert.equal(s.calls(), 1);
  });

  it("leaves an answer with problems alone when the pull went first", async () => {
    const guard = new FirstPullGuard(20);
    const s = server(full);
    assert.deepEqual(await guard.provide(A, s.pull, isEmpty, s.pull), full);
    assert.equal(s.calls(), 1);
  });

  it("pulls again after the didOpen when the pull went first and was answered empty", async () => {
    const guard = new FirstPullGuard(1000);
    const s = server(empty, full);
    const result = guard.provide(A, s.pull, isEmpty, s.pull);
    await tick();
    assert.equal(s.calls(), 1, "the second pull waits for the didOpen");
    guard.opened(A);
    assert.deepEqual(await result, full);
    assert.equal(s.calls(), 2);
  });

  it("pulls again at once when the didOpen was sent while the first pull was in flight", async () => {
    const guard = new FirstPullGuard(1000);
    let calls = 0;
    const answers = [empty, full];
    const pull = async (): Promise<Report> => {
      const answer = answers[calls++] ?? full;
      if (calls === 1) guard.opened(A);
      return answer;
    };
    assert.deepEqual(await guard.provide(A, pull, isEmpty, pull), full);
    assert.equal(calls, 2);
  });

  it("asks once: a second empty answer is kept", async () => {
    const guard = new FirstPullGuard(1000);
    const s = server(empty, empty, full);
    const result = guard.provide(A, s.pull, isEmpty, s.pull);
    await tick();
    guard.opened(A);
    assert.deepEqual(await result, empty);
    assert.equal(s.calls(), 2);
  });

  it("gives up after the wait when the didOpen never comes, keeping the empty answer", async () => {
    const guard = new FirstPullGuard(15);
    const s = server(empty, full);
    assert.deepEqual(await guard.provide(A, s.pull, isEmpty, s.pull), empty);
    assert.equal(s.calls(), 1);
    assert.ok(FIRST_PULL_WAIT_MS >= 1000, "the real wait is long enough for a replay of open documents");
  });

  it("is not released by another document's didOpen", async () => {
    const guard = new FirstPullGuard(30);
    const s = server(empty, full);
    const result = guard.provide(A, s.pull, isEmpty, s.pull);
    await tick();
    guard.opened(B);
    assert.deepEqual(await result, empty);
    assert.equal(s.calls(), 1);
  });

  it("does not pull again for a cancelled request", async () => {
    const guard = new FirstPullGuard(1000);
    const s = server(empty, full);
    let cancelled = false;
    const result = guard.provide(
      A,
      async () => {
        const answer = await s.pull();
        cancelled = true;
        return answer;
      },
      isEmpty,
      s.pull,
      () => cancelled,
    );
    assert.deepEqual(await result, empty);
    assert.equal(s.calls(), 1);
  });

  it("treats a document closed and pulled before its next didOpen as overtaking again", async () => {
    const guard = new FirstPullGuard(1000);
    guard.opened(A);
    guard.closed(A);
    const s = server(empty, full);
    const result = guard.provide(A, s.pull, isEmpty, s.pull);
    await tick();
    guard.opened(A);
    assert.deepEqual(await result, full);
  });

  it("an unchanged answer is not empty", async () => {
    const guard = new FirstPullGuard(20);
    const unchanged: Report = { kind: "unchanged", items: [] };
    const s = server(unchanged);
    assert.deepEqual(await guard.provide(A, s.pull, isEmpty, s.pull), unchanged);
    assert.equal(s.calls(), 1);
  });
});
