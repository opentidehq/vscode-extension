// The serve supervisor (src/core/backend/supervisor.ts) through the Backend: the crash ceiling, cancel-then-kill and
// the writers' lock, against the fake opentide's serve (`crash` exits on every run, `hang` never answers, not even a
// cancel). The timings are shortened through `supervision`; the defaults are in supervisor.ts.
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { Backend, type BackendDeps, SERVE_GIVEN_UP } from "../../src/core/backend/backend";
import { fromChildProcess } from "../../src/core/backend/process";
import {
  CANCEL_GRACE_MS,
  CRASH_RESTARTS,
  CRASH_WINDOW_MS,
  makeCrashBudget,
  makeWriteLock,
} from "../../src/core/backend/supervisor";
import { BackendError } from "../../src/core/backend/types";
import type { Classification } from "../../src/core/capabilities/classification";
import { CommandTree } from "../../src/core/capabilities/tree";
import type { Runtime, WasiModule } from "../../src/core/runtime/types";
import { CancellationTokenSource } from "../../src/core/util/cancellation";
import { COMMANDS_FIXTURE, FAKE_OPENTIDE, fakeRuntime, sleep } from "./helpers";

const REPO = mkdtempSync(path.join(tmpdir(), "otide-supervisor-"));
const READ: Classification = { class: "read-only", writes: false, contactsTenant: false, spawn: false };
const WRITE: Classification = {
  class: "writes-workspace",
  writes: true,
  contactsTenant: false,
  spawn: false,
};

function tree(): CommandTree {
  const document = JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8"));
  document.commands.push({
    path: "serve",
    name: "serve",
    summary: "",
    group: false,
    subcommands: [],
    deprecated: false,
    arguments: [],
    options: [],
  });
  return CommandTree.parse(document);
}

const GRACE_MS = 300;

function make(runtime: Runtime, overrides: Partial<BackendDeps> = {}) {
  const logs: string[] = [];
  const notices: string[] = [];
  const backend = new Backend({
    runtime: () => runtime,
    commands: async () => tree(),
    classify: (argv) => (argv.includes("--write") ? WRITE : READ),
    serveMode: () => "auto",
    baseEnv: () => process.env,
    proxy: () => undefined,
    credentials: async () => ({}),
    platform: process.platform,
    log: (level, message) => logs.push(`${level}: ${message}`),
    notify: (message) => notices.push(message),
    supervision: { cancelGraceMs: GRACE_MS, crashBackoffMs: 5 },
    ...overrides,
  });
  const starts = () => logs.filter((line) => /opentide serve .* started/.test(line)).length;
  return { backend, logs, notices, starts };
}

/** A WASI runtime (tier 4) whose serve is the fake opentide's, started as the WASI host would start it. */
function wasi(): { runtime: Runtime; deps: Partial<BackendDeps> } {
  return {
    runtime: fakeRuntime({ tier: 4, wasi: {} as WasiModule }),
    deps: {
      wasi: {
        start: async () =>
          fromChildProcess(
            cp.spawn(process.execPath, [FAKE_OPENTIDE, "serve"], { stdio: ["pipe", "pipe", "pipe"] }),
          ),
        initializeParams: {},
      },
    },
  };
}

describe("serve supervisor", function () {
  this.timeout(20_000);
  const backends: Backend[] = [];
  afterEach(async () => {
    for (const backend of backends.splice(0)) await backend.dispose();
  });

  describe("the crash ceiling", () => {
    it("starts a serve that crashes on every run at most 4 times, then refuses, with one notice (WASI)", async () => {
      const { runtime, deps } = wasi();
      const made = make(runtime, deps);
      backends.push(made.backend);
      for (let i = 0; i < 5; i++) {
        await assert.rejects(made.backend.run(REPO, ["crash"]), (error: unknown) => {
          assert.ok(error instanceof BackendError, String(error));
          assert.equal(error.code, "crashed");
          return true;
        });
      }
      assert.equal(made.starts(), 1 + CRASH_RESTARTS);
      assert.deepEqual(made.notices, [SERVE_GIVEN_UP]);
      // Refused before any start: no fifth process.
      await assert.rejects(made.backend.run(REPO, ["echo"]), /crashed 4 times/);
      assert.equal(made.starts(), 4);
      // A restart (opentide: Restart Server) gives serve another chance.
      await made.backend.restart();
      assert.equal((await made.backend.run(REPO, ["echo"])).exitCode, 0);
      assert.equal(made.starts(), 5);
      assert.equal(made.notices.length, 1);
    });

    it("falls back to spawning on a native runtime once serve crashed past the ceiling, without a notice", async () => {
      const made = make(fakeRuntime());
      backends.push(made.backend);
      for (let i = 0; i < 2; i++) await assert.rejects(made.backend.run(REPO, ["crash"]), /exited/);
      assert.equal(made.starts(), 4);
      const result = await made.backend.run(REPO, ["echo"]);
      assert.equal(result.via, "spawn");
      assert.equal(made.starts(), 4);
      assert.deepEqual(made.notices, []);
    });

    it("waits the Schedule's backoff before a restart, and forgets crashes older than the window", () => {
      const budget = makeCrashBudget({ baseMs: 500, windowMs: CRASH_WINDOW_MS });
      const delays = [0, 1, 2].map(() => budget.crashed(1000)?.delayMs);
      // Jittered exponential: about 500, 1000 and 2000 ms (jitter is 80% to 120%).
      for (const [i, delay] of delays.entries()) {
        assert.ok(delay !== undefined, `crash ${i + 1}`);
        assert.ok(
          delay >= 0.8 * 500 * 2 ** i - 1 && delay <= 1.2 * 500 * 2 ** i + 1,
          `crash ${i + 1}: ${delay}`,
        );
      }
      assert.equal(budget.crashed(1000), undefined, "the fourth crash in the window reaches the ceiling");
      const spread = makeCrashBudget();
      for (let i = 0; i < 10; i++)
        assert.ok(spread.crashed(i * (CRASH_WINDOW_MS + 1)), `crash ${i + 1}, each in a window of its own`);
    });
  });

  describe("cancel-then-kill", () => {
    it("kills a serve that ignores $/cancelRequest within the grace (+1 s), and the caller gets `cancelled`", async () => {
      const made = make(fakeRuntime());
      backends.push(made.backend);
      const source = new CancellationTokenSource();
      const run = made.backend.run(REPO, ["hang"], { cancellation: source.token });
      await sleep(300);
      assert.equal(made.backend.serveRunning, true);
      const cancelledAt = Date.now();
      source.cancel();
      const result = await run;
      const elapsed = Date.now() - cancelledAt;
      assert.ok(
        elapsed >= GRACE_MS - 20 && elapsed < GRACE_MS + 1000,
        `answered ${elapsed} ms after the cancel`,
      );
      assert.equal(result.cancelled, true);
      assert.equal(result.exitCode, 130);
      assert.equal(result.via, "serve");
      assert.equal(result.document.failure?.code, "cancelled");
      assert.ok(made.logs.some((line) => line.includes(`did not answer a cancel within ${GRACE_MS} ms`)));
      // The kill is not a crash: the next request starts a new serve at once, and no ceiling moves.
      assert.equal((await made.backend.run(REPO, ["echo"])).exitCode, 0);
      assert.equal(made.starts(), 2);
      assert.equal(made.logs.filter((line) => line.includes("the next request restarts it")).length, 0);
    });

    it("keeps the document of a serve that honours the cancel within the grace", async () => {
      const made = make(fakeRuntime(), { supervision: { cancelGraceMs: CANCEL_GRACE_MS } });
      backends.push(made.backend);
      const source = new CancellationTokenSource();
      const run = made.backend.run(REPO, ["slow", "5000"], { cancellation: source.token });
      await sleep(300);
      source.cancel();
      const result = await run;
      assert.equal(result.cancelled, true);
      assert.equal(result.document.command, "slow");
      assert.equal(made.starts(), 1);
      assert.equal(made.backend.serveRunning, true, "the serve that answered is kept");
    });
  });

  describe("the writers' lock", () => {
    it("frees the lock for the next writer once a hung writer is cancelled", async () => {
      const made = make(fakeRuntime());
      backends.push(made.backend);
      const source = new CancellationTokenSource();
      const hung = made.backend.run(REPO, ["hang", "--write"], { cancellation: source.token });
      await sleep(300);
      let nextDone = false;
      const next = made.backend.run(REPO, ["echo", "--write"]).finally(() => {
        nextDone = true;
      });
      await sleep(200);
      assert.equal(nextDone, false, "the next writer waits for the hung one");
      source.cancel();
      assert.equal((await hung).cancelled, true);
      const result = await next;
      assert.equal(result.exitCode, 0);
      assert.equal(result.cancelled, false);
    });

    it("lets a writer cancelled while it waits leave the line without running", async () => {
      const made = make(fakeRuntime());
      backends.push(made.backend);
      const first = new CancellationTokenSource();
      const hung = made.backend.run(REPO, ["hang", "--write"], { cancellation: first.token });
      await sleep(300);
      const waiting = new CancellationTokenSource();
      const queued = made.backend.run(REPO, ["echo", "--write"], { cancellation: waiting.token });
      await sleep(100);
      const cancelledAt = Date.now();
      waiting.cancel();
      const result = await queued;
      assert.ok(Date.now() - cancelledAt < 200, "it did not wait for the writer before it");
      assert.equal(result.cancelled, true);
      assert.equal(result.document.command, "echo");
      assert.equal(result.document.failure?.code, "cancelled");
      first.cancel();
      await hung;
    });

    it("runs writers one at a time, in order", async () => {
      const lock = makeWriteLock();
      const order: string[] = [];
      const task = (name: string, ms: number) => async () => {
        order.push(`${name} start`);
        await sleep(ms);
        order.push(`${name} end`);
        return name;
      };
      const results = await Promise.all([
        lock.run(task("a", 50)),
        lock.run(task("b", 10)),
        lock.run(task("c", 1)),
      ]);
      assert.deepEqual(results, ["a", "b", "c"]);
      assert.deepEqual(order, ["a start", "a end", "b start", "b end", "c start", "c end"]);
    });

    it("passes a writer's own error through, and releases the lock after it", async () => {
      const lock = makeWriteLock();
      await assert.rejects(
        lock.run(async () => {
          throw new BackendError("crashed", "boom");
        }),
        /boom/,
      );
      assert.equal(await lock.run(async () => "after"), "after");
    });
  });
});
