// Entry point: the core, then every feature in src/features/ (index.generated.ts), each isolated so one
// failing feature never stops the others.
import type * as vscode from "vscode";
import type { FeatureContext } from "./core/context";
import { createCore } from "./core/core";
import { activateFeatures } from "./core/featureHost";
import { features } from "./features/index.generated";

export interface ExtensionApi {
  /** Only in tests (`ExtensionMode.Test`): the feature context, for integration tests. */
  readonly ctx?: FeatureContext;
  /** Resolves when the first runtime resolution and language server start finished. */
  readonly started: Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
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
