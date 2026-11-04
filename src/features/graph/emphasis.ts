// What a selected or hovered node emphasises (SPEC §10.1 "In and out"): its outgoing edges and their
// targets in one colour, its incoming edges and their sources in another, everything else dimmed. The
// webview applies it as Cytoscape classes, and only the difference from what it applied last, so a
// hover costs the node's degree, not the size of the graph. vscode-free and DOM-free.

export interface IndexedEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

/** Each drawn node's edges, both ways, built once per view. */
export class Incidence {
  private readonly outgoing = new Map<string, IndexedEdge[]>();
  private readonly incoming = new Map<string, IndexedEdge[]>();

  constructor(edges: readonly IndexedEdge[]) {
    for (const edge of edges) {
      push(this.outgoing, edge.source, edge);
      push(this.incoming, edge.target, edge);
    }
  }

  out(id: string): readonly IndexedEdge[] {
    return this.outgoing.get(id) ?? [];
  }

  in(id: string): readonly IndexedEdge[] {
    return this.incoming.get(id) ?? [];
  }

  /** The nodes one edge away, either way. */
  neighbours(id: string): Set<string> {
    const found = new Set<string>();
    for (const edge of this.out(id)) found.add(edge.target);
    for (const edge of this.in(id)) found.add(edge.source);
    found.delete(id);
    return found;
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The emphasis classes. `em-both`: a node the centre points to and that points back. */
export type EmphasisClass = "em-center" | "em-out" | "em-in" | "em-both";

/** The class every element outside the emphasis gets while one is shown. */
export const DIM_CLASS = "em-dim";

export const EMPHASIS_CLASSES: readonly EmphasisClass[] = ["em-center", "em-out", "em-in", "em-both"];

/** Element id → its emphasis class, for the node `id`; empty when no node is emphasised. */
export function emphasisOf(incidence: Incidence, id: string | undefined): Map<string, EmphasisClass> {
  const classes = new Map<string, EmphasisClass>();
  if (id === undefined) return classes;
  const mark = (element: string, cls: "em-out" | "em-in"): void => {
    const known = classes.get(element);
    if (known === "em-center" || known === "em-both") return;
    classes.set(element, known && known !== cls ? "em-both" : cls);
  };
  classes.set(id, "em-center");
  for (const edge of incidence.out(id)) {
    classes.set(edge.id, "em-out");
    mark(edge.target, "em-out");
  }
  for (const edge of incidence.in(id)) {
    // A self-loop is drawn as outgoing.
    if (!classes.has(edge.id)) classes.set(edge.id, "em-in");
    mark(edge.source, "em-in");
  }
  return classes;
}

/** What to change to go from one emphasis to the next. */
export interface EmphasisPlan {
  /** Element id and class to remove. */
  readonly remove: readonly (readonly [string, EmphasisClass])[];
  readonly add: readonly (readonly [string, EmphasisClass])[];
  /**
   * `all`: dim every element first, then undim `undim` (no emphasis before); `none`: undim every
   * element (no emphasis after); `diff`: dim `dim` and undim `undim` only.
   */
  readonly dimming: "all" | "none" | "diff";
  readonly dim: readonly string[];
  readonly undim: readonly string[];
}

/**
 * The changes from `previous` to `next`. Moving the emphasis from one node to another touches only the
 * two neighbourhoods; showing or clearing it dims or undims everything once.
 */
export function planEmphasis(
  previous: ReadonlyMap<string, EmphasisClass>,
  next: ReadonlyMap<string, EmphasisClass>,
): EmphasisPlan {
  const remove: [string, EmphasisClass][] = [];
  const add: [string, EmphasisClass][] = [];
  for (const [id, cls] of previous) if (next.get(id) !== cls) remove.push([id, cls]);
  for (const [id, cls] of next) if (previous.get(id) !== cls) add.push([id, cls]);
  if (next.size === 0)
    return { remove, add, dimming: previous.size === 0 ? "diff" : "none", dim: [], undim: [] };
  if (previous.size === 0) return { remove, add, dimming: "all", dim: [], undim: [...next.keys()] };
  const dim = [...previous.keys()].filter((id) => !next.has(id));
  const undim = [...next.keys()].filter((id) => !previous.has(id));
  return { remove, add, dimming: "diff", dim, undim };
}

/** `items` in slices of at most `size`, to spread a large restyle over several frames. */
export function slices<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  const step = Math.max(1, Math.floor(size));
  for (let at = 0; at < items.length; at += step) result.push(items.slice(at, at + step));
  return result;
}

/**
 * Above this many drawn elements (nodes and edges), dimming everything at once costs more than a frame
 * (~30 ms for 14,000 elements): a hover then only colours the neighbourhood, and a selection dims the
 * rest in slices of DIM_SLICE, one per frame.
 */
export const DIM_LIMIT = 1200;
export const DIM_SLICE = 800;
