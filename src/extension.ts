// Entry point: the core, then every feature in src/features/ (index.generated.ts), each isolated so one
// failing feature never stops the others. A virtual workspace (no folder on disk) gets the web mode
// instead, as in the browser: opentide reads the workspace from disk, the engine (WASM) through VS Code,
// here in a worker thread.
import * as path from "node:path";

import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";

import type { FeatureContext } from "./core/context";
import { type Core, createCore } from "./core/core";
import { activateFeatures } from "./core/featureHost";
import { startEngineWorker } from "./core/services/engine";
import type { WasiHostKind } from "./core/wasi/hostChoice";
import { features } from "./features/index.generated";
import { activateWeb } from "./web/activate";
import { isVirtualOnly } from "./web/mode";

export interface ExtensionApi {
  /** Only in tests (`ExtensionMode.Test`): the feature context, for integration tests. */
  readonly ctx?: FeatureContext;
  /** Only in tests: the host the bundled opentide last started on (the launcher or @vscode/wasm-wasi). */
  readonly wasiHost?: () => WasiHostKind | undefined;
  /** Resolves when the first runtime resolution and language server start finished. */
  readonly started: Promise<void>;
}

/** The running core, for `deactivate` to end its processes. */
let running: Core | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  if (isVirtualOnly((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.scheme))) {
    const module = path.join(context.extensionPath, "dist", "engine", "opentide_wasm_bg.wasm");
    activateWeb(context, {
      startEngine: () => startEngineWorker(module),
      createClient: (serverOptions, clientOptions) =>
        new LanguageClient("opentide", "opentide Language Server", serverOptions, clientOptions),
    });
    return { started: Promise.resolve() };
  }
  const core = createCore(context);
  running = core;
  const activated = activateFeatures(features, core.ctx);
  const started = core.start();
  await activated;
  // ExtensionMode.Test is 3.
  return context.extensionMode === 3 ? { ctx: core.ctx, wasiHost: core.wasiHost, started } : { started };
}

/**
 * VS Code waits for the promise this returns (about five seconds) and then disposes `context.subscriptions` without
 * waiting for them, so the processes are ended and awaited here, in order: otherwise the host can exit while the
 * language server or `opentide serve` still waits to be killed, and leave them behind.
 */
export async function deactivate(): Promise<void> {
  const core = running;
  running = undefined;
  await core?.shutdown();
}
