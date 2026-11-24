// A language client whose start or stop never settles must not hold the queue every restart waits in: the limits of
// src/core/lsp/bounds.ts, with fake timers (a thirty-second wait costs no test time).
import * as assert from "node:assert/strict";
import { mock } from "node:test";

import {
  type BoundedClient,
  bounded,
  disposeBounded,
  START_TIMEOUT_MS,
  startBounded,
  STOP_TIMEOUT_MS,
  stopBounded,
} from "../../../src/core/lsp/bounds";
import { fallbackAttempts, type ServerStart, startWithFallback } from "../../../src/core/runtime/fallback";
import { engineRuntime } from "../../../src/core/runtime/resolve";
import { fakeRuntime } from "../helpers";

const never = (): Promise<never> => new Promise(() => undefined);
const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** Move the fake clock on, letting the promises waiting on it run before and after. */
async function advance(ms: number): Promise<void> {
  await settle();
  mock.timers.tick(ms);
  await settle();
}

/** A client whose calls do what the test says; it counts them. */
function fakeClient(behaviour: Partial<BoundedClient> = {}) {
  const calls = { start: 0, stop: 0, dispose: 0 };
  const client: BoundedClient = {
    start: () => (calls.start++, behaviour.start?.() ?? Promise.resolve()),
    stop: (timeout) => (calls.stop++, behaviour.stop?.(timeout) ?? Promise.resolve()),
    dispose: (timeout) => (calls.dispose++, behaviour.dispose?.(timeout) ?? Promise.resolve()),
  };
  return { client, calls };
}

describe("language client limits", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  describe("bounded", () => {
    it("is done with the value, failed with the message, timed out, or abandoned: whichever comes first", async () => {
      assert.deepEqual(await bounded(Promise.resolve(7), 1000), { kind: "done", value: 7 });
      assert.deepEqual(await bounded(Promise.reject(new Error("boom")), 1000), {
        kind: "failed",
        error: "boom",
      });
      const timed = bounded(never(), 1000);
      await advance(1000);
      assert.deepEqual(await timed, { kind: "timeout" });
      assert.deepEqual(await bounded(never(), 1000, Promise.resolve()), { kind: "abandoned" });
    });

    it("leaves no timer behind once the work is done, and drops a later failure of what it gave up on", async () => {
      await bounded(Promise.resolve(1), 1000);
      let late: (error: Error) => void = () => undefined;
      const slow = new Promise<never>((_, reject) => {
        late = reject;
      });
      const timed = bounded(slow, 10);
      await advance(10);
      await timed;
      late(new Error("too late"));
      await settle(); // no unhandled rejection: the test would fail
    });
  });

  describe("start", () => {
    it("is ok when the client starts", async () => {
      const { client } = fakeClient();
      assert.deepEqual(await startBounded(client), { ok: true });
    });

    it("gives up on a start that never answers `initialize`, after the limit, and says so", async () => {
      const { client } = fakeClient({ start: never });
      const started = startBounded(client);
      await advance(START_TIMEOUT_MS - 1);
      let finished = false;
      void started.then(() => (finished = true));
      await settle();
      assert.equal(finished, false, "still waiting just before the limit");
      await advance(1);
      const result = await started;
      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, /did not answer `initialize` in 30 s/);
      assert.equal(result.ok ? undefined : result.abandoned, undefined, "a timeout is a failed start");
    });

    it("reports a start that fails", async () => {
      const { client } = fakeClient({ start: () => Promise.reject(new Error("no module")) });
      assert.deepEqual(await startBounded(client), { ok: false, error: "no module" });
    });

    it("is abandoned at once when a stop or a new start is asked for, which is no failure of the server", async () => {
      const { client } = fakeClient({ start: never });
      const result = await startBounded(client, { abandoned: Promise.resolve() });
      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.abandoned, true);
    });
  });

  describe("stop and dispose", () => {
    it("stops and disposes a client that answers", async () => {
      const { client, calls } = fakeClient();
      assert.deepEqual(await stopBounded(client), []);
      assert.deepEqual([calls.stop, calls.dispose], [1, 1]);
    });

    it("gives up on a stop that never settles, disposes anyway, and says what happened", async () => {
      const { client, calls } = fakeClient({ stop: never });
      const stopped = stopBounded(client);
      await advance(STOP_TIMEOUT_MS);
      assert.deepEqual(await stopped, [`did not stop in ${STOP_TIMEOUT_MS / 1000} s`]);
      assert.equal(calls.dispose, 1, "the client is disposed after a stop that gave up");
    });

    it("gives up on a dispose that never settles too: both limits, one after the other", async () => {
      const { client } = fakeClient({ stop: never, dispose: never });
      const stopped = stopBounded(client);
      await advance(STOP_TIMEOUT_MS);
      await advance(4000);
      assert.deepEqual(await stopped, ["did not stop in 8 s", "did not dispose in 4 s"]);
    });

    it("reports a stop that fails, and still disposes", async () => {
      const { client, calls } = fakeClient({ stop: () => Promise.reject(new Error("not running")) });
      assert.deepEqual(await stopBounded(client), ["did not stop cleanly: not running"]);
      assert.equal(calls.dispose, 1);
    });

    it("disposes a client that did not start within its limit", async () => {
      const { client } = fakeClient({ dispose: never });
      const disposed = disposeBounded(client);
      await advance(4000);
      assert.deepEqual(await disposed, ["did not dispose in 4 s"]);
    });
  });

  describe("a restart whose start never settles", () => {
    const engine = engineRuntime({ version: "1.0.0", module: "opentide_wasm_bg.wasm" } as never, false);
    const wasi = fakeRuntime({ tier: 4, source: "wasi" });

    /** What the manager's `startServer` does with a client: bounded, then ended. */
    function startsAs(clients: Map<string, BoundedClient>, abandoned?: Promise<unknown>) {
      return async (runtime: { kind: string }): Promise<ServerStart> => {
        const client = clients.get(runtime.kind);
        if (!client) return { ok: false, error: "no client" };
        const result = await startBounded(client, abandoned ? { abandoned } : {});
        if (result.ok) return { ok: true };
        await disposeBounded(client);
        return { ok: false, error: result.error, ...(result.abandoned ? { abandoned: true } : {}) };
      };
    }

    it("falls back to the engine after the limit: a timed-out start is a failed start, not a crash", async () => {
      const stuck = fakeClient({ start: never });
      const fine = fakeClient();
      const clients = new Map<string, BoundedClient>([
        [wasi.kind, stuck.client],
        [engine.kind, fine.client],
      ]);
      // The wasi runtime and the engine have different kinds here, so each gets its own client.
      const done = startWithFallback(wasi, startsAs(clients), () => engine);
      await advance(START_TIMEOUT_MS);
      const started = await done;
      assert.equal(started.server, engine, "the engine serves the editor features");
      assert.match(started.fallback?.reason ?? "", /did not answer `initialize` in 30 s/);
      assert.equal(started.fallback?.crashed, undefined, "it is not recorded as a crash");
      assert.equal(stuck.calls.dispose, 1, "the client that never started is disposed");
      assert.match(
        fallbackAttempts(started.fallback ?? { from: wasi, reason: "" }, engine)[0]?.detail ?? "",
        /did not start \(the language server did not answer/,
      );
    });

    it("does not fall back when the start was abandoned for a restart: the restart goes on", async () => {
      const stuck = fakeClient({ start: never });
      const clients = new Map<string, BoundedClient>([[wasi.kind, stuck.client]]);
      let started = false;
      const result = await startWithFallback(wasi, startsAs(clients, Promise.resolve()), () => {
        started = true;
        return engine;
      });
      assert.deepEqual(result, { server: undefined });
      assert.equal(started, false, "the engine is not asked for");
    });
  });
});
