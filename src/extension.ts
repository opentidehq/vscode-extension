// Entry point: the core, then every feature in src/features/ (index.generated.ts), each isolated so one
// failing feature never stops the others. A virtual workspace (no folder on disk) gets the web mode
// instead, as in the browser: opentide reads the workspace from disk, the engine (WASM) through VS Code,
// here in a worker thread.
import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import type { FeatureContext } from "./core/context";
import { createCore } from "./core/core";
import { activateFeatures } from "./core/featureHost";
import { startEngineWorker } from "./core/services/engine";
import { features } from "./features/index.generated";
import { activateWeb } from "./web/activate";
import { isVirtualOnly } from "./web/mode";

export interface ExtensionApi {
  /** Only in tests (`ExtensionMode.Test`): the feature context, for integration tests. */
  readonly ctx?: FeatureContext;
  /** Resolves when the first runtime resolution and language server start finished. */
  readonly started: Promise<void>;
}

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
  const activated = activateFeatures(features, core.ctx);
  const started = core.start();
  await activated;
  // ExtensionMode.Test is 3.
  return context.extensionMode === 3 ? { ctx: core.ctx, started } : { started };
}

export function deactivate(): void {
  // Disposables in context.subscriptions stop the language server and the backend.
}
