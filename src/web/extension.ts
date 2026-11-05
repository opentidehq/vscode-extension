// The `browser` entry (vscode.dev, github.dev, VS Code for the Web): the opentide engine (WASM) in a Web
// Worker, spoken to by vscode-languageclient/browser, with the Catalogue, Relations and Find Detection
// from its index (src/web/activate.ts). Desktop virtual workspaces run the same web mode from the node
// bundle, with a worker thread instead (src/extension.ts). Keep this bundle free of Node built-ins and of
// src/core/ (test/scripts/web-bundle.test.mjs).
//
// TODO(#10, SPEC §13), what the web lacks that the engine could give, in this order:
//   1. Follow file changes without a restart: language-server#212 (`opentide/didChangeWorkspace`), sent
//      once a release announces `experimental.opentide.workspaceUpdates` (the session already does).
//   2. Problems for closed files: the engine indexes what it is given but checks only open documents.
//   3. The graph on the web, from the same index (the desktop's graph panel is Node-bound today).
//   4. Start before the workspace is read on a large repository (thousands of files over a slow file
//      system), feeding the rest in batches with #1.
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/browser";
import { engineInit } from "../engine/protocol";
import type { EnginePort } from "../engine/transport";
import { activateWeb } from "./activate";
import type { EngineSession } from "./session";

/** The browser's Worker, as much as this file uses (the build's lib has no DOM). */
interface BrowserWorker {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message" | "error",
    listener: (event: { data?: unknown; message?: string }) => void,
  ): void;
  removeEventListener(
    type: "message" | "error",
    listener: (event: { data?: unknown; message?: string }) => void,
  ): void;
  terminate(): void;
}
type WorkerConstructor = new (url: string) => BrowserWorker;

/** The engine in a Web Worker: dist/web/engine-worker.js, told where the module is. */
export function webEnginePort(extensionUri: vscode.Uri): EnginePort {
  const Worker = (globalThis as unknown as { Worker: WorkerConstructor }).Worker;
  const script = vscode.Uri.joinPath(extensionUri, "dist", "web", "engine-worker.js").toString(true);
  const module = vscode.Uri.joinPath(extensionUri, "dist", "engine", "opentide_wasm_bg.wasm").toString(true);
  const worker = new Worker(script);
  worker.postMessage(engineInit(module));
  const exits = new Set<(detail: string) => void>();
  const on = (type: "message" | "error", listener: (event: { data?: unknown; message?: string }) => void) => {
    worker.addEventListener(type, listener);
    return { dispose: () => worker.removeEventListener(type, listener) };
  };
  return {
    post: (text) => worker.postMessage(text),
    onMessage: (listener) => on("message", (event) => listener(event.data)),
    onError: (listener) =>
      on("error", (event) => listener(new Error(event.message ?? "the engine worker failed"))),
    onExit: (listener) => {
      exits.add(listener);
      return { dispose: () => exits.delete(listener) };
    },
    terminate: () => {
      worker.terminate();
      for (const listener of exits) listener("the engine worker was terminated");
    },
  };
}

/** Only in tests (`ExtensionMode.Test`): the engine session, for the browser tests. */
export interface WebApi {
  readonly session?: EngineSession;
}

export function activate(context: vscode.ExtensionContext): WebApi {
  const session = activateWeb(context, {
    startEngine: () => webEnginePort(context.extensionUri),
    createClient: (serverOptions, clientOptions) =>
      new LanguageClient("opentide", "opentide Language Server", serverOptions, clientOptions),
  });
  return context.extensionMode === vscode.ExtensionMode.Test ? { session } : {};
}

export function deactivate(): void {
  // Everything is in context.subscriptions.
}
