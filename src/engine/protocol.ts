// What the client says to the engine beyond LSP. vscode-free, no Node built-ins.
import type { WorkspaceDelta } from "./workspace";

/** The status bar's and language status item's words for the engine, on the desktop and the web. */
export const ENGINE_LABEL = "opentide engine (WASM)";
export const ENGINE_STATUS = `${ENGINE_LABEL}: editor features only`;

/**
 * The notification that updates the workspace a host supplied on `initialize`, for a server that says
 * it takes it (`capabilities.experimental.opentide.workspaceUpdates`, language-server#212). A server
 * without it is restarted with the new workspace instead: what it was given on `initialize` is all it
 * ever reads.
 */
export const DID_CHANGE_WORKSPACE = "opentide/didChangeWorkspace";

export type DidChangeWorkspaceParams = WorkspaceDelta;

/** Whether the server takes `opentide/didChangeWorkspace` (its `experimental.opentide`). */
export function takesWorkspaceUpdates(experimental: unknown): boolean {
  const opentide = (experimental as { opentide?: { workspaceUpdates?: unknown } } | undefined)?.opentide;
  return opentide?.workspaceUpdates === true;
}
