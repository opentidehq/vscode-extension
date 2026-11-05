// The desktop engine (WASM) worker: dist/engine/worker.js in a `worker_threads` Worker, as an EnginePort
// for the language client (src/engine/transport.ts).
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { Disposable } from "vscode-jsonrpc";
import type { EnginePort } from "../../engine/transport";

/** The worker script next to the module (dist/engine/). */
export function engineWorkerScript(module: string): string {
  return path.join(path.dirname(module), "worker.js");
}

/** Start the engine worker for the module at `module`. */
export function startEngineWorker(module: string): EnginePort {
  const worker = new Worker(engineWorkerScript(module), {
    workerData: { module },
    // The engine writes nothing to stdout or stderr; keep a stray line out of the extension host's.
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  let exited = false;
  const listen = <T extends unknown[]>(event: string, listener: (...args: T) => void): Disposable => {
    const handler = (...args: unknown[]) => listener(...(args as T));
    worker.on(event, handler);
    return Disposable.create(() => worker.off(event, handler));
  };
  return {
    post: (text) => worker.postMessage(text),
    onMessage: (listener) => listen<[unknown]>("message", listener),
    onError: (listener) => listen<[Error]>("error", listener),
    onExit: (listener) =>
      listen<[number]>("exit", (code) => {
        exited = true;
        listener(`the engine worker exited with code ${code}`);
      }),
    terminate: () => {
      if (!exited) void worker.terminate();
    },
  };
}
