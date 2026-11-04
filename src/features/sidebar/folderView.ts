// The model of a view whose data comes from one opentide command per folder (Platforms: `info`, Health:
// `doctor`): loading, error and per-folder states around the view's own nodes. vscode-free.
import type { LoadState } from "./loader";
import { branch, messageNode, type TreeNode, type ViewModel } from "./node";

export interface FolderResult<T> {
  readonly folder: string;
  readonly name: string;
  readonly value?: T;
  /** Why this folder has no value (a failure's message). */
  readonly error?: string;
}

export type Availability =
  | { readonly available: true }
  | { readonly available: false; readonly code: "no-runtime" | "untrusted" | "editor-only" };

export interface FolderViewOptions<T> {
  readonly view: string;
  readonly state: LoadState<readonly FolderResult<T>[]>;
  readonly availability: Availability;
  /** Folders the view is about (an empty list: the welcome view explains). */
  readonly folders: readonly { readonly path: string; readonly name: string }[];
  readonly loadingLabel: string;
  nodes(value: T, folder: string, prefix: string): TreeNode[];
  extra?(results: readonly FolderResult<T>[]): Pick<ViewModel, "description" | "badge" | "message">;
}

export function folderViewModel<T>(options: FolderViewOptions<T>): ViewModel {
  const { state, view } = options;
  // Untrusted, no runtime, no folder: the view is empty and its welcome content says what to do.
  if (!options.availability.available || options.folders.length === 0) return { nodes: [] };
  const retry = (id: string, label: string, detail?: string): TreeNode =>
    messageNode(id, label, "error", {
      ...(detail ? { description: detail, tooltip: detail } : {}),
      iconColor: "problemsErrorIcon.foreground",
      command: { command: "opentide.sidebar.refresh", title: "Retry", args: [view] },
      ref: { kind: "retry", view },
    });
  const results = state.value;
  if (!results) {
    if (state.status === "error")
      return { nodes: [retry(`${view}:error`, "Did not load. Retry", state.error)] };
    return { nodes: [messageNode(`${view}:loading`, options.loadingLabel, "loading~spin")] };
  }
  const multi = results.length > 1;
  const nodes: TreeNode[] = [];
  for (const result of results) {
    const prefix = multi ? `${result.folder}|` : "";
    const inner =
      result.value !== undefined
        ? options.nodes(result.value, result.folder, prefix)
        : [retry(`${prefix}${view}:folder-error`, "Did not load. Retry", result.error)];
    if (multi)
      nodes.push(
        branch(
          { id: `folder:${result.folder}`, label: result.name, icon: "root-folder", tooltip: result.folder },
          inner,
          "expanded",
        ),
      );
    else nodes.push(...inner);
  }
  const extra = options.extra?.(results) ?? {};
  const message =
    state.status === "error"
      ? `The last refresh failed (${state.error ?? "unknown error"}).`
      : (extra.message ?? undefined);
  return {
    nodes,
    ...(extra.description ? { description: extra.description } : {}),
    ...(extra.badge ? { badge: extra.badge } : {}),
    ...(message ? { message } : {}),
  };
}
