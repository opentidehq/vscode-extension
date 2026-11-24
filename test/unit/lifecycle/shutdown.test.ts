import * as assert from "node:assert/strict";

import { runShutdown } from "../../../src/core/shutdown";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("shutdown (deactivate awaits every disposal, in order)", () => {
  it("awaits each step before the next: a step that takes time finishes before the following one starts", async () => {
    const events: string[] = [];
    const result = await runShutdown(
      [
        {
          name: "language server",
          run: async () => {
            events.push("language server: start");
            await sleep(30);
            events.push("language server: stopped");
          },
        },
        {
          name: "serve",
          run: async () => {
            events.push("serve: start");
            await sleep(10);
            events.push("serve: stopped");
          },
        },
        { name: "processes", run: () => undefined },
      ],
      { deadlineMs: 2000 },
    );
    assert.deepEqual(events, [
      "language server: start",
      "language server: stopped",
      "serve: start",
      "serve: stopped",
    ]);
    assert.deepEqual(result.done, ["language server", "serve", "processes"]);
    assert.deepEqual(result.failed, []);
    assert.equal(result.timedOut, undefined);
  });

  it("does not return until the last step is done (what `void dispose()` did not)", async () => {
    let finished = false;
    await runShutdown(
      [
        {
          name: "serve",
          run: async () => {
            await sleep(40);
            finished = true;
          },
        },
      ],
      { deadlineMs: 2000 },
    );
    assert.equal(finished, true);
  });

  it("records a step that throws and still runs the rest", async () => {
    const ran: string[] = [];
    const result = await runShutdown(
      [
        {
          name: "a",
          run: () => {
            throw new Error("no process");
          },
        },
        { name: "b", run: async () => Promise.reject(new Error("refused")) },
        {
          name: "c",
          run: async () => {
            ran.push("c");
          },
        },
      ],
      { deadlineMs: 2000 },
    );
    assert.deepEqual(ran, ["c"]);
    assert.deepEqual(result.failed, [
      { name: "a", error: "no process" },
      { name: "b", error: "refused" },
    ]);
    assert.deepEqual(result.done, ["c"]);
  });

  it("gives up at the deadline, names the step it was in, forces what is left and skips the rest", async () => {
    let forced: string | undefined;
    const ran: string[] = [];
    const started = Date.now();
    const result = await runShutdown(
      [
        { name: "first", run: async () => void ran.push("first") },
        { name: "stuck", run: () => new Promise(() => undefined) },
        { name: "after", run: async () => void ran.push("after") },
      ],
      {
        deadlineMs: 80,
        onTimeout: (name) => {
          forced = name;
        },
      },
    );
    assert.ok(Date.now() - started < 1500, "returned at the deadline, not when the stuck step ends");
    assert.equal(result.timedOut, "stuck");
    assert.equal(forced, "stuck");
    assert.deepEqual(result.done, ["first"]);
    assert.deepEqual(result.notRun, ["after"]);
    await sleep(20);
    assert.deepEqual(ran, ["first"]);
  });
});
