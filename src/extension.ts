// Entry point: the core, then every feature in src/features/ (index.generated.ts), each isolated so one
// failing feature never stops the others. A virtual workspace (no folder on disk) gets the web mode
// instead, as in the browser: opentide reads the workspace from disk, the engine (WASM) through VS Code,
// here in a worker thread.
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import * as vscode from "vscode";

import type { FeatureContext } from "./core/context";
import { type Core, createCore } from "./core/core";
import { activateFeatures } from "./core/featureHost";
import { loadLsp } from "./core/lsp/load";
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
  /** Only in tests: answer the WASI module's tenant requests with `perform` (a stub) in the serve processes started next. */
  readonly stubWasiFetch?: Core["stubWasiFetch"];
  /** Only in tests: how long `activate` took, and where the time went (SPEC §14: under 300 ms). */
  readonly activation?: ActivationTimes;
  /** Resolves when the first runtime resolution and language server start finished. */
  readonly started: Promise<void>;
}

/** Where `activate`'s time went, in milliseconds. The features run one after another, so `features` is their sum. */
export interface ActivationTimes {
  readonly totalMs: number;
  /** `createCore`: the services, the commands the core registers. */
  readonly coreMs: number;
  /** `activateFeatures`: every feature's `activate`. */
  readonly featuresMs: number;
  /** What `core.start()` does before its first await. */
  readonly startMs: number;
  /** Waiting for the features' promises after all of that. */
  readonly settleMs: number;
  readonly features: readonly { readonly id: string; readonly ms: number }[];
}

/** The running core, for `deactivate` to end its processes. */
let running: Core | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const began = performance.now();
  if (isVirtualOnly((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.scheme))) {
    const module = path.join(context.extensionPath, "dist", "engine", "opentide_wasm_bg.wasm");
    activateWeb(context, {
      startEngine: () => startEngineWorker(module),
      get State() {
        return loadLsp().State;
      },
      engineTransports: (port) => loadLsp().engineTransports(port),
      createClient: (serverOptions, clientOptions) =>
        new (loadLsp().LanguageClient)("opentide", "opentide Language Server", serverOptions, clientOptions),
    });
    return { started: Promise.resolve() };
  }
  const created = performance.now();
  const core = createCore(context);
  running = core;
  const coreDone = performance.now();
  const activated = activateFeatures(features, core.ctx);
  const featuresDone = performance.now();
  const started = core.start();
  const startDone = performance.now();
  const outcomes = await activated;
  // ExtensionMode.Test is 3.
  if (context.extensionMode !== 3) return { started };
  const end = performance.now();
  const activation: ActivationTimes = {
    totalMs: end - began,
    settleMs: end - startDone,
    coreMs: coreDone - created,
    featuresMs: featuresDone - coreDone,
    startMs: startDone - featuresDone,
    features: outcomes.map((outcome) => ({ id: outcome.id, ms: outcome.ms })),
  };
  return { ctx: core.ctx, wasiHost: core.wasiHost, stubWasiFetch: core.stubWasiFetch, activation, started };
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
