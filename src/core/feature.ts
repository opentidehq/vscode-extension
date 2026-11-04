// The feature contract. Each feature lives in src/features/<id>/index.ts and default-exports
// `defineFeature({ id, activate })`; scripts/features-index.mjs lists them in index.generated.ts.
import type * as vscode from "vscode";
import type { FeatureContext } from "./context";

export interface Feature {
  /** Equal to the folder name under src/features/. */
  readonly id: string;
  /**
   * Called once, after the core. Register commands, views and listeners here and push their disposables
   * onto `ctx.subscriptions` (or return one). Never block on a process: start work in the background.
   * Runs in Restricted Mode too; check `ctx.trust.isTrusted` and degrade.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: activate may return nothing, or a Disposable
  activate(ctx: FeatureContext): void | vscode.Disposable | Promise<void | vscode.Disposable>;
}

export function defineFeature(feature: Feature): Feature {
  return feature;
}
