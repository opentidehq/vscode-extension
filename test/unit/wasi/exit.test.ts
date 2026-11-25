// The exit of a WASI process under @vscode/wasm-wasi (src/core/wasi/exit.ts): `run()` settles only when the module calls
// `proc_exit`, and `terminate()` kills the worker without settling it, so a process the extension ended itself never
// reported an exit and whoever waited for it waited for ever.
import * as assert from "node:assert/strict";
import { mock } from "node:test";

import type { ServeProcess } from "../../../src/core/backend/process";
import { ServeClient } from "../../../src/core/backend/serve";
import { type ProcessExit, type TerminableRun, watchExit } from "../../../src/core/wasi/exit";

const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** A WasmProcess as wasm-wasi-core 1.0.4 has it: `terminate()` resolves, `run()` does not, unless the module exits. */
function wasmProcess(options: { terminate?: () => Promise<unknown> } = {}) {
  let exit: (code: number) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const proc: TerminableRun = {
    run: () =>
      new Promise<number>((resolve, reject) => {
        exit = resolve;
        fail = reject;
      }),
    terminate: options.terminate ?? (() => Promise.resolve(0)),
  };
  return { proc, exit: (code: number) => exit(code), fail: (error: Error) => fail(error) };
}

describe("watchExit", () => {
  it("reports the exit of a process that ends by itself, once", async () => {
    const exits: ProcessExit[] = [];
    const { proc, exit } = wasmProcess();
    const watcher = watchExit(proc, (e) => exits.push(e));
    exit(3);
    await settle();
    await watcher.terminate(); // a terminate after the exit adds nothing
    assert.deepEqual(exits, [{ kind: "exited", code: 3 }]);
  });

  it("reports a process the extension ended although run() never settles: today it never did", async () => {
    const exits: ProcessExit[] = [];
    const { proc } = wasmProcess();
    const watcher = watchExit(proc, (e) => exits.push(e));
    await settle();
    assert.deepEqual(exits, [], "nothing yet: it runs");
    await watcher.terminate();
    assert.deepEqual(exits, [{ kind: "terminated" }]);
  });

  it("reports it once terminate has settled, also when terminate rejects", async () => {
    const exits: ProcessExit[] = [];
    const { proc } = wasmProcess({ terminate: () => Promise.reject(new Error("worker already gone")) });
    const watcher = watchExit(proc, (e) => exits.push(e));
    await watcher.terminate();
    assert.deepEqual(exits, [{ kind: "terminated" }]);
  });

  it("does not report twice when run() settles after the terminate, or the terminate after run() failed", async () => {
    const exits: ProcessExit[] = [];
    const first = wasmProcess();
    const a = watchExit(first.proc, (e) => exits.push(e));
    await a.terminate();
    first.exit(1);
    await settle();
    const second = wasmProcess();
    const b = watchExit(second.proc, (e) => exits.push(e));
    second.fail(new Error("trap"));
    await settle();
    await b.terminate();
    assert.equal(exits.length, 2);
    assert.deepEqual(exits[0], { kind: "terminated" });
    assert.equal(exits[1]?.kind, "failed");
  });
});

describe("opentide serve on a WASI process that terminate ends but run() does not report", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());
  const advance = async (ms: number): Promise<void> => {
    await settle();
    mock.timers.tick(ms);
    await settle();
  };

  /** What WasiHost.rawProcess makes of a WasmProcess: kill ends it through watchExit, and close follows. */
  function serveProcess(options: { reportTerminate: boolean }): {
    process: ServeProcess;
    killed: () => number;
  } {
    const out: ((chunk: string) => void)[] = [];
    const closers: ((code: number | null, signal: string | null) => void)[] = [];
    const { proc } = wasmProcess();
    const watcher = watchExit(proc, (exit) => {
      for (const close of closers)
        close(exit.kind === "exited" ? exit.code : null, exit.kind === "terminated" ? "SIGKILL" : null);
    });
    let killed = 0;
    return {
      killed: () => killed,
      process: {
        // Answers `initialize`, ignores `shutdown`: the serve is busy with a run.
        write: (text) => {
          for (const line of text.split("\n").filter(Boolean)) {
            const message = JSON.parse(line) as { id?: number; method?: string };
            if (message.method === "initialize")
              queueMicrotask(() =>
                out.forEach((emit) =>
                  emit(
                    `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocol: 1, version: "1.0.0", commands_digest: "d" } })}\n`,
                  ),
                ),
              );
          }
        },
        onStdout: (listener) => void out.push(listener),
        onStderr: () => undefined,
        onError: () => undefined,
        onClose: (listener) => void closers.push(listener),
        kill: () => {
          killed++;
          if (options.reportTerminate) void watcher.terminate();
        },
      },
    };
  }

  it("stop() returns as soon as the kill has taken effect, not when the last limit runs out", async () => {
    const { process, killed } = serveProcess({ reportTerminate: true });
    const serve = new ServeClient({ start: () => process, shutdownTimeoutMs: 2000 });
    await serve.start();
    let stopped = false;
    const stopping = serve.stop().then(() => (stopped = true));
    await advance(2000); // no answer to `shutdown`
    await advance(2000); // the kill
    assert.equal(killed(), 1);
    await stopping;
    assert.equal(stopped, true, "stop() resolved right after the kill, long before the 3 s wait for an exit");
    assert.equal(serve.isRunning, false);
  });

  it("and without the exit report it still returns, after the last limit: the safety net", async () => {
    const { process } = serveProcess({ reportTerminate: false });
    const warnings: string[] = [];
    const serve = new ServeClient({
      start: () => process,
      shutdownTimeoutMs: 2000,
      log: (level, message) => void (level === "warn" && warnings.push(message)),
    });
    await serve.start();
    const stopping = serve.stop();
    await advance(2000);
    await advance(2000);
    await advance(3000);
    await stopping;
    assert.equal(serve.isRunning, false, "marked ended");
    assert.match(warnings.join("\n"), /did not report its exit/);
  });
});
