import * as assert from "node:assert/strict";
import { mock } from "node:test";

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

describe("shutdown groups: steps that do not wait on each other run together", () => {
  // Fake timers: a two-second stop costs no test time, and the clock says how long the shutdown took.
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  /** Move the fake clock `ms` on, letting the promises that are waiting on it run in between. */
  const advance = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    mock.timers.tick(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  /** A stop that takes `ms` of the fake clock. */
  const stop = (ms: number) => () => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it("two 2 s stops in a group finish in about 2 s, where one after the other they would not fit in 3", async () => {
    const together = runShutdown(
      [
        [
          { name: "language server", run: stop(2000) },
          { name: "serve", run: stop(2000) },
        ],
      ],
      { deadlineMs: 3000 },
    );
    await advance(2000);
    const result = await together;
    assert.deepEqual([...result.done].sort(), ["language server", "serve"]);
    assert.equal(result.timedOut, undefined);

    let forced: string | undefined;
    const apart = runShutdown(
      [
        { name: "language server", run: stop(2000) },
        { name: "serve", run: stop(2000) },
      ],
      { deadlineMs: 3000, onTimeout: (name) => void (forced = name) },
    );
    await advance(2000);
    await advance(1000);
    const late = await apart;
    assert.equal(late.timedOut, "serve", "the second stop was still running at 3 s");
    assert.equal(forced, "serve");
  });

  it("keeps the order around a group: the first phase before it, the last after it", async () => {
    const events: string[] = [];
    const step = (name: string, ms: number) => ({
      name,
      run: async () => {
        events.push(`${name}: start`);
        await stop(ms)();
        events.push(`${name}: end`);
      },
    });
    const finished = runShutdown(
      [step("resolution", 10), [step("language server", 2000), step("serve", 1000)], step("wasi", 10)],
      { deadlineMs: 4000 },
    );
    await advance(10);
    await advance(1000);
    await advance(1000);
    await advance(10);
    const result = await finished;
    assert.deepEqual(events, [
      "resolution: start",
      "resolution: end",
      "language server: start",
      "serve: start",
      "serve: end",
      "language server: end",
      "wasi: start",
      "wasi: end",
    ]);
    assert.deepEqual(result.done, ["resolution", "serve", "language server", "wasi"]);
  });

  it("isolates a failing step of a group: the other still finishes, and the phases after run", async () => {
    const ran: string[] = [];
    const result = await runShutdown(
      [
        [
          { name: "language server", run: () => Promise.reject(new Error("would not stop")) },
          {
            name: "serve",
            run: async () => {
              ran.push("serve");
            },
          },
        ],
        {
          name: "wasi",
          run: async () => {
            ran.push("wasi");
          },
        },
      ],
      { deadlineMs: 4000 },
    );
    assert.deepEqual(ran, ["serve", "wasi"]);
    assert.deepEqual(result.failed, [{ name: "language server", error: "would not stop" }]);
    assert.deepEqual(result.done, ["serve", "wasi"]);
  });

  it("at the deadline names the steps of the group still running, forces, and skips what follows", async () => {
    let forced: string | undefined;
    const finished = runShutdown(
      [
        [
          { name: "language server", run: stop(1000) },
          { name: "serve", run: () => new Promise(() => undefined) },
          { name: "also stuck", run: () => new Promise(() => undefined) },
        ],
        { name: "wasi", run: async () => undefined },
      ],
      { deadlineMs: 4000, onTimeout: (name) => void (forced = name) },
    );
    await advance(1000);
    await advance(3000);
    const result = await finished;
    assert.equal(result.timedOut, "serve, also stuck");
    assert.equal(forced, "serve, also stuck");
    assert.deepEqual(result.done, ["language server"]);
    assert.deepEqual(result.notRun, ["wasi"]);
  });
});
