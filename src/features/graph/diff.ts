// The catalogue reaches the graph webview as a full model once, then as patches: the nodes and edges
// that changed since the revision the webview has, so a save in a 5,000-object repository posts a few
// nodes, not all of them. vscode-free and DOM-free: the webview applies the patches with applyPatch.
import type { GraphEdge, GraphModel, GraphNode } from "./model";

export interface ModelPatch {
  /** The revision the patch applies to. */
  readonly from: number;
  /** The revision it makes. */
  readonly to: number;
  /** New or changed nodes, whole. */
  readonly nodes: readonly GraphNode[];
  readonly removedNodes: readonly string[];
  readonly edges: readonly GraphEdge[];
  readonly removedEdges: readonly string[];
}

function changes<T extends { readonly id: string }>(
  previous: readonly T[],
  next: readonly T[],
): { upsert: T[]; removed: string[] } {
  const before = new Map<string, string>();
  for (const item of previous) before.set(item.id, JSON.stringify(item));
  const upsert: T[] = [];
  const seen = new Set<string>();
  for (const item of next) {
    seen.add(item.id);
    if (before.get(item.id) !== JSON.stringify(item)) upsert.push(item);
  }
  const removed = previous.filter((item) => !seen.has(item.id)).map((item) => item.id);
  return { upsert, removed };
}

/** What changed from `previous` (revision `from`) to `next` (revision `to`). */
export function diffModels(previous: GraphModel, next: GraphModel, from: number, to: number): ModelPatch {
  const nodes = changes(previous.nodes, next.nodes);
  const edges = changes(previous.edges, next.edges);
  return {
    from,
    to,
    nodes: nodes.upsert,
    removedNodes: nodes.removed,
    edges: edges.upsert,
    removedEdges: edges.removed,
  };
}

export function patchSize(patch: ModelPatch): number {
  return patch.nodes.length + patch.removedNodes.length + patch.edges.length + patch.removedEdges.length;
}

export function isEmptyPatch(patch: ModelPatch): boolean {
  return patchSize(patch) === 0;
}

function apply<T extends { readonly id: string }>(
  items: readonly T[],
  upsert: readonly T[],
  removed: readonly string[],
): T[] {
  const gone = new Set(removed);
  const replaced = new Map(upsert.map((item) => [item.id, item]));
  const result: T[] = [];
  for (const item of items) {
    if (gone.has(item.id)) continue;
    const next = replaced.get(item.id);
    result.push(next ?? item);
    replaced.delete(item.id);
  }
  // New items go last, in the order the host sent them.
  for (const item of replaced.values()) result.push(item);
  return result;
}

/** `model` with `patch` applied; existing nodes and edges keep their order. */
export function applyPatch(model: GraphModel, patch: ModelPatch): GraphModel {
  return {
    nodes: apply(model.nodes, patch.nodes, patch.removedNodes),
    edges: apply(model.edges, patch.edges, patch.removedEdges),
  };
}

/** What to post to a webview for a model: the whole model, a patch, or nothing new. */
export type ModelMessage =
  | { readonly kind: "full"; readonly revision: number; readonly model: GraphModel }
  | { readonly kind: "patch"; readonly revision: number; readonly patch: ModelPatch }
  | { readonly kind: "same"; readonly revision: number };

/**
 * The host's memory of what one webview has: the model and revision it was last sent. A patch larger
 * than half the model is sent as the model instead.
 */
export class ModelSender {
  private sent: GraphModel | undefined;
  private revision = 0;

  next(model: GraphModel): ModelMessage {
    const previous = this.sent;
    this.sent = model;
    if (previous === model) return { kind: "same", revision: this.revision };
    if (!previous) {
      this.revision += 1;
      return { kind: "full", revision: this.revision, model };
    }
    const patch = diffModels(previous, model, this.revision, this.revision + 1);
    if (isEmptyPatch(patch)) return { kind: "same", revision: this.revision };
    this.revision += 1;
    if (patchSize(patch) * 2 > model.nodes.length + model.edges.length)
      return { kind: "full", revision: this.revision, model };
    return { kind: "patch", revision: this.revision, patch };
  }

  /** Forget what was sent: a new webview, another folder, or a webview that lost track (`resync`). */
  reset(): void {
    this.sent = undefined;
  }
}
