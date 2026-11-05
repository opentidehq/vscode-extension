// The desktop engine worker (dist/engine/worker.js): the opentide language server built for WebAssembly,
// in a `worker_threads` Worker so that compiling and running it never blocks the extension host. The
// extension passes the module's path as `workerData.module`; src/engine/host.ts serves the session.
import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { initSync, LanguageServer, version } from "opentide-wasm-glue";
import { type EngineModule, serveEngine } from "../../engine/host";

const port = parentPort;
if (!port) throw new Error("the opentide engine runs in a worker thread");
const file = (workerData as { module?: unknown } | null)?.module;

void serveEngine(
  {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on("message", listener),
    close: () => port.close(),
  },
  (): EngineModule => {
    if (typeof file !== "string") throw new Error("no engine module path (workerData.module)");
    initSync({ module: readFileSync(file) });
    return { createSession: () => new LanguageServer(), version };
  },
);
