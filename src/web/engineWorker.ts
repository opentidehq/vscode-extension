// The browser's engine worker (dist/web/engine-worker.js): the opentide language server built for
// WebAssembly in a Web Worker, on vscode.dev, github.dev and in VS Code for the Web. The extension's
// first message names the module's URL (`{ opentideEngine: { module } }`); every later one is a JSON-RPC
// message for src/engine/host.ts. A classic script, not a module: VS Code's web extension host starts a
// worker from another origin through `importScripts`.
import { initSync, LanguageServer, version } from "opentide-wasm-glue";
import { type EngineModule, serveEngine } from "../engine/host";
import { moduleUrlOf } from "../engine/protocol";

/** The worker's global, typed as much as this file uses it (the build's lib has no WebWorker). */
interface WorkerScope {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;
let resolveUrl: (url: string) => void = () => undefined;
const moduleUrl = new Promise<string>((resolve) => {
  resolveUrl = resolve;
});
const listeners: ((data: unknown) => void)[] = [];
scope.addEventListener("message", (event) => {
  const url = moduleUrlOf(event.data);
  if (url !== undefined) resolveUrl(url);
  else for (const listener of listeners) listener(event.data);
});

void serveEngine(
  {
    postMessage: (message) => scope.postMessage(message),
    onMessage: (listener) => {
      listeners.push(listener);
    },
    close: () => scope.close(),
  },
  async (): Promise<EngineModule> => {
    const url = await moduleUrl;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
    initSync({ module: new Uint8Array(await response.arrayBuffer()) });
    return { createSession: () => new LanguageServer(), version };
  },
);
