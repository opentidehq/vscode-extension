// Expanding and collapsing a node's neighbours in place (the "+" and "−" on the selected node), and
// placing nodes that join a drawn graph next to what they link to, without laying the graph out again.
// vscode-free and DOM-free: the webview imports it.
import { Incidence } from "./emphasis";
import { layoutDirection, NODE_BOX, type Point } from "./layout";
import type { GraphEdge, GraphModel, GraphNode } from "./model";
import type { GraphView } from "./view";

/** What the user added to and took from the computed view, until the mode, focus or filters change. */
export interface Overrides {
  readonly added: ReadonlySet<string>;
  readonly removed: ReadonlySet<string>;
}

export const NO_OVERRIDES: Overrides = { added: new Set(), removed: new Set() };

/**
 * The computed view with the user's expansions and collapses: `added` nodes that pass the filters join
 * it, `removed` nodes leave it, and the edges are those of the model between the nodes that remain.
 */
export function withOverrides(
  model: GraphModel,
  base: GraphView,
  overrides: Overrides,
  passes: (node: GraphNode) => boolean,
): GraphView {
  if (overrides.added.size === 0 && overrides.removed.size === 0) return base;
  const ids = new Set(base.nodes.map((node) => node.id));
  const nodes = base.nodes.filter((node) => !overrides.removed.has(node.id));
  for (const id of overrides.removed) ids.delete(id);
  for (const node of model.nodes) {
    if (
      overrides.added.has(node.id) &&
      !ids.has(node.id) &&
      !overrides.removed.has(node.id) &&
      passes(node)
    ) {
      nodes.push(node);
      ids.add(node.id);
    }
  }
  const edges = model.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  return { nodes, edges, unknownFocus: base.unknownFocus };
}

/** The model's neighbours of `id` that are not drawn and that the filters let in, sorted. */
export function hiddenNeighbours(
  model: Incidence,
  drawn: { has(id: string): boolean },
  id: string,
  passes: (id: string) => boolean,
): string[] {
  return [...model.neighbours(id)].filter((other) => !drawn.has(other) && passes(other)).sort();
}

/**
 * The drawn neighbours of `id` that "−" takes away: those linked to nothing else drawn (so collapsing
 * never cuts the graph in two), apart from the nodes in `keep` (the focus).
 */
export function collapsibleNeighbours(view: Incidence, id: string, keep: ReadonlySet<string>): string[] {
  return [...view.neighbours(id)]
    .filter((other) => !keep.has(other) && [...view.neighbours(other)].every((n) => n === id))
    .sort();
}

const COLUMN_GAP = NODE_BOX.width + 70;

/**
 * Positions for `added` nodes, each next to a drawn neighbour: in a column left of it when the layout
 * puts it upstream (a threat of an objective), else right, stacked from the neighbour's height down
 * past the slots already taken. A node with no drawn neighbour goes below everything.
 */
export function placeNear(
  positions: ReadonlyMap<string, Point>,
  added: readonly string[],
  edges: readonly Pick<GraphEdge, "kind" | "source" | "target">[],
): Map<string, Point> {
  const placed = new Map<string, Point>();
  const taken = new Occupancy();
  let bottom = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  for (const point of positions.values()) {
    taken.add(point);
    bottom = Math.max(bottom, point.y);
    left = Math.min(left, point.x);
  }
  const wanted = new Set(added);
  const anchors = new Map<string, { anchor: Point; side: number }>();
  for (const edge of edges) {
    const [from, to] = layoutDirection(edge);
    for (const [node, other, side] of [
      [to, from, 1],
      [from, to, -1],
    ] as const) {
      if (!wanted.has(node) || anchors.has(node)) continue;
      const anchor = positions.get(other);
      if (anchor) anchors.set(node, { anchor, side });
    }
  }
  let orphanX = Number.isFinite(left) ? left : 0;
  const orphanY = Number.isFinite(bottom) ? bottom + NODE_BOX.height * 2 : 0;
  for (const id of added) {
    const found = anchors.get(id);
    if (!found) {
      const point = taken.free({ x: orphanX, y: orphanY }, 0);
      placed.set(id, point);
      taken.add(point);
      orphanX = point.x + NODE_BOX.width;
      continue;
    }
    const point = taken.free({ x: found.anchor.x + found.side * COLUMN_GAP, y: found.anchor.y }, 1);
    placed.set(id, point);
    taken.add(point);
  }
  return placed;
}

/** Which node boxes are taken, in a grid of node boxes. */
class Occupancy {
  private readonly cells = new Set<string>();

  private key(point: Point): string {
    return `${Math.round(point.x / NODE_BOX.width)},${Math.round(point.y / NODE_BOX.height)}`;
  }

  add(point: Point): void {
    this.cells.add(this.key(point));
  }

  /** The first free box from `start`: alternately below and above (`vertical`), else to the right. */
  free(start: Point, vertical: number): Point {
    for (let step = 0; step < 10_000; step += 1) {
      const offset = vertical ? (step % 2 ? -1 : 1) * Math.ceil(step / 2) : step;
      const point = vertical
        ? { x: start.x, y: start.y + offset * NODE_BOX.height }
        : { x: start.x + offset * NODE_BOX.width, y: start.y };
      if (!this.cells.has(this.key(point))) return point;
    }
    return start;
  }
}

/** An index of the model's edges, for "+" (built once per model). */
export function modelIncidence(model: GraphModel): Incidence {
  return new Incidence(model.edges);
}
