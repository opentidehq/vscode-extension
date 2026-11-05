// Keeping the engine's workspace in step with the mirror across its starts and restarts. A change the
// mirror takes while no server answers (it starts, restarts, or the client restarts it) is queued and
// replayed once one does: sent to an engine that takes `opentide/didChangeWorkspace`, else one more
// restart. vscode-free, no Node built-ins: the desktop and the web share it.
import type { SuppliedWorkspace, WorkspaceDelta } from "./workspace";

/** What to do with a change. */
export type SyncAction =
  | { readonly kind: "notify"; readonly delta: WorkspaceDelta }
  | { readonly kind: "restart" }
  | { readonly kind: "after-close"; readonly uris: readonly string[] };

/**
 * An engine that takes `opentide/didChangeWorkspace` is sent the delta. Another (0.10.0) is restarted
 * with the new workspace, unless every file it touches is open in an editor: the server reads those
 * buffers, so their new text matters only once they are closed.
 */
export function planDelta(delta: WorkspaceDelta, updates: boolean, open: ReadonlySet<string>): SyncAction {
  if (updates) return { kind: "notify", delta };
  const touched = [...delta.documents.map((document) => document.uri), ...delta.removed];
  if (delta.visibility === undefined && touched.length > 0 && touched.every((uri) => open.has(uri)))
    return { kind: "after-close", uris: touched };
  return { kind: "restart" };
}

export class EngineSync {
  private live = false;
  private updates = false;
  private queued: WorkspaceDelta[] = [];

  /** A server is being given the mirror as it stands (its `initialize`): what was queued is in it. */
  given(): void {
    this.live = false;
    this.queued = [];
  }

  /** The server answered `initialize`: what to do with what changed since it was given the workspace. */
  ready(updates: boolean): SyncAction[] {
    this.live = true;
    this.updates = updates;
    const queued = this.queued.splice(0);
    if (queued.length === 0) return [];
    return updates ? queued.map((delta) => ({ kind: "notify", delta })) : [{ kind: "restart" }];
  }

  /** No server answers: it stopped, is stopping, or stopped on its own. */
  down(): void {
    this.live = false;
  }

  /** A change the mirror took: what to do with it now, or nothing until a server answers. */
  changed(delta: WorkspaceDelta, open: ReadonlySet<string>): SyncAction | undefined {
    if (!this.live) {
      this.queued.push(delta);
      return undefined;
    }
    return planDelta(delta, this.updates, open);
  }
}

/**
 * `initializationOptions` as the language client takes it, a function: read at each `initialize`, the
 * client's own restarts after a crash included, so each gets the workspace as it stands then, and the
 * sync knows the server has it.
 */
export function initializationOptions(
  snapshot: () => SuppliedWorkspace | undefined,
  sync: EngineSync,
): () => { workspace: SuppliedWorkspace } {
  return () => {
    sync.given();
    return { workspace: snapshot() ?? { documents: [] } };
  };
}
