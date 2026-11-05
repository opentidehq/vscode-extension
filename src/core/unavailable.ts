// What a feature says when opentide cannot run its command: one line, the same wherever it is said, and
// the two ways out (install opentide, or switch the runtime). vscode-free.
import { ENGINE_LABEL, type Runtime } from "./runtime/types";

export type UnavailableCode = "no-runtime" | "untrusted" | "editor-only";

/** Where installing opentide is explained. */
export const INSTALL_URL = "https://opentide.org/docs/usage/installation/";
export const INSTALL_ACTION = "Install opentide";
export const SWITCH_ACTION = "Switch Runtime…";

/**
 * Why `needs` (a noun phrase: "this command", "the catalogue", "setup") cannot run on an editor-only
 * runtime: the engine (WASM), or an `opentide-lsp` named by opentide.path.
 */
export function editorOnlyText(runtime: Runtime | undefined, needs: string): string {
  if (runtime?.kind === "engine")
    return `The ${ENGINE_LABEL} runs editor features only: ${needs} needs opentide. Install opentide, or switch the runtime.`;
  return `opentide.path names opentide-lsp, which runs editor features only: ${needs} needs opentide. Point it at opentide.`;
}

/** The actions a message about `code` offers. */
export function unavailableActions(code: UnavailableCode): string[] {
  return code === "untrusted" ? [] : [INSTALL_ACTION, SWITCH_ACTION];
}
