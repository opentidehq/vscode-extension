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

/** Each item's JSON by id: what a later model is compared with. */
type Signatures = ReadonlyMap<string, string>;

function signatures(items: readonly { readonly id: string }[]): Map<string, string> {
  return new Map(items.map((item) => [item.id, JSON.stringify(item)]));
}

/** What changed from the items `before` describes to `next`, and `next`'s own signatures. */
function changesFrom<T extends { readonly id: string }>(
  before: Signatures,
  next: readonly T[],
): { upsert: T[]; removed: string[]; after: Map<string, string> } {
  const upsert: T[] = [];
  const after = new Map<string, string>();
  for (const item of next) {
    const json = JSON.stringify(item);
    after.set(item.id, json);
    if (before.get(item.id) !== json) upsert.push(item);
  }
  const removed = [...before.keys()].filter((id) => !after.has(id));
  return { upsert, removed, after };
}

/** What changed from `previous` (revision `from`) to `next` (revision `to`). */
export function diffModels(previous: GraphModel, next: GraphModel, from: number, to: number): ModelPatch {
  return diffFrom({ nodes: signatures(previous.nodes), edges: signatures(previous.edges) }, next, from, to)
    .patch;
}

interface ModelSignatures {
  readonly nodes: Signatures;
  readonly edges: Signatures;
}

/** diffModels against the signatures of the previous model, which a sender keeps instead of the model. */
function diffFrom(
  previous: ModelSignatures,
  next: GraphModel,
  from: number,
  to: number,
): { patch: ModelPatch; signatures: ModelSignatures } {
  const nodes = changesFrom(previous.nodes, next.nodes);
  const edges = changesFrom(previous.edges, next.edges);
  const patch = {
    from,
    to,
    nodes: nodes.upsert,
    removedNodes: nodes.removed,
    edges: edges.upsert,
    removedEdges: edges.removed,
  };
  return { patch, signatures: { nodes: nodes.after, edges: edges.after } };
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
  /** The sent model's items as JSON, so a change stringifies only the new model, once. */
  private sentSignatures: ModelSignatures | undefined;
  private revision = 0;

  next(model: GraphModel): ModelMessage {
    const previous = this.sent;
    const before = this.sentSignatures;
    this.sent = model;
    if (previous === model && before) return { kind: "same", revision: this.revision };
    if (!previous || !before) {
      this.sentSignatures = { nodes: signatures(model.nodes), edges: signatures(model.edges) };
      this.revision += 1;
      return { kind: "full", revision: this.revision, model };
    }
    const { patch, signatures: after } = diffFrom(before, model, this.revision, this.revision + 1);
    this.sentSignatures = after;
    if (isEmptyPatch(patch)) return { kind: "same", revision: this.revision };
    this.revision += 1;
    if (patchSize(patch) * 2 > model.nodes.length + model.edges.length)
      return { kind: "full", revision: this.revision, model };
    return { kind: "patch", revision: this.revision, patch };
  }

  /** Forget what was sent: a new webview, another folder, or a webview that lost track (`resync`). */
  reset(): void {
    this.sent = undefined;
    this.sentSignatures = undefined;
  }
}

/** What the webview does with a `data` message's model part. */
export type Received =
  /** A new or changed model to draw; `first`: the webview had none. */
  | { readonly kind: "model"; readonly model: GraphModel; readonly first: boolean }
  /** The model it has is the host's: only the status may have changed. */
  | { readonly kind: "same" }
  /** It lost track (a missed or out-of-order message): ask the host for the whole model. */
  | { readonly kind: "resync" }
  /** It lost track and has asked already: wait for the whole model, do not ask again. */
  | { readonly kind: "waiting" }
  /** The host's status is not `ready`: the model is gone. */
  | { readonly kind: "cleared" };

/**
 * The webview's end of ModelSender: the model and revision it holds. A patch applies only to the
 * revision it was made from, and a message without a model or patch only confirms the revision held;
 * anything else is a resync, so the webview never claims a revision whose model it does not have.
 */
export class ModelReceiver {
  private held: GraphModel | undefined;
  private at: number | undefined;
  /** A resync was asked for and the whole model has not come yet: one desync, one resend. */
  private resyncRequested = false;

  get model(): GraphModel | undefined {
    return this.held;
  }

  get revision(): number | undefined {
    return this.at;
  }

  receive(data: {
    readonly status: string;
    readonly model?: GraphModel;
    readonly patch?: ModelPatch;
    readonly revision?: number;
  }): Received {
    if (data.status !== "ready") {
      this.clear();
      return { kind: "cleared" };
    }
    const first = this.held === undefined;
    if (data.model) {
      this.held = data.model;
      this.at = data.revision;
      this.resyncRequested = false;
      return { kind: "model", model: data.model, first };
    }
    if (data.patch) {
      if (!this.held || this.at !== data.patch.from) return this.lost();
      this.held = applyPatch(this.held, data.patch);
      this.at = data.patch.to;
      return { kind: "model", model: this.held, first: false };
    }
    if (this.held && data.revision !== undefined && data.revision === this.at) return { kind: "same" };
    return this.lost();
  }

  private lost(): Received {
    if (this.resyncRequested) return { kind: "waiting" };
    this.resyncRequested = true;
    return { kind: "resync" };
  }

  clear(): void {
    this.held = undefined;
    this.at = undefined;
    this.resyncRequested = false;
  }
}
