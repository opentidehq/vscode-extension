// Layered left-to-right layout (dagre), and keeping positions stable across refreshes so the graph does
// not jump while you work (SPEC §10.1 "Layout"). vscode-free and DOM-free: the webview imports it.
import type { GraphEdge, GraphNode } from "./model";

// The part of dagre this uses. dagre ships ESM-only declarations next to the CommonJS build that this
// CommonJS module (and esbuild's bundle of it) loads, so its API is declared here and loaded by require.
interface DagreGraph {
  setGraph(label: Record<string, unknown>): void;
  setDefaultEdgeLabel(label: () => Record<string, unknown>): void;
  setNode(id: string, label: { width: number; height: number }): void;
  setEdge(from: string, to: string, label: Record<string, unknown>, name: string): void;
  hasNode(id: string): boolean;
  nodes(): string[];
  node(id: string): { x?: number; y?: number } | undefined;
}
interface Dagre {
  readonly graphlib: { readonly Graph: new (options: { multigraph: boolean }) => DagreGraph };
  layout(graph: DagreGraph): void;
}
declare const require: (id: string) => unknown;
const dagre = require("@dagrejs/dagre") as Dagre;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Positions = ReadonlyMap<string, Point>;

/** The box dagre reserves per node: the shape plus its label underneath. */
export const NODE_BOX = { width: 170, height: 56 } as const;

/**
 * The direction an edge takes in the layout, so threats sit left, then objectives, signals and rules,
 * and techniques, log sources and platforms to the right of what names them.
 */
export function layoutDirection(edge: Pick<GraphEdge, "kind" | "source" | "target">): [string, string] {
  switch (edge.kind) {
    case "covers":
    case "implements":
    case "parent":
    case "actor":
      return [edge.target, edge.source];
    default:
      return [edge.source, edge.target];
  }
}

export function layout(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Map<string, Point> {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "LR", nodesep: 8, ranksep: 70, marginx: 20, marginy: 20 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: NODE_BOX.width, height: NODE_BOX.height });
  for (const edge of edges) {
    const [from, to] = layoutDirection(edge);
    if (from !== to && graph.hasNode(from) && graph.hasNode(to)) graph.setEdge(from, to, {}, edge.id);
  }
  dagre.layout(graph);
  const positions = new Map<string, Point>();
  for (const id of graph.nodes()) {
    const node = graph.node(id);
    if (node && typeof node.x === "number" && typeof node.y === "number")
      positions.set(id, { x: node.x, y: node.y });
  }
  return wrapRanks(positions);
}

/** The most nodes a column holds before a rank wraps: about a third as wide as it is tall. */
export function columnLimit(count: number): number {
  return Math.max(24, Math.ceil(Math.sqrt(count * 3)));
}

/**
 * Wrap a rank that holds too many nodes (an objective with 500 rules) into side-by-side columns, in
 * order, and push the ranks after it right, so a large fan-out reads as a block instead of one line.
 */
export function wrapRanks(positions: ReadonlyMap<string, Point>): Map<string, Point> {
  const ranks = new Map<number, [string, Point][]>();
  for (const [id, point] of positions) {
    const key = Math.round(point.x);
    const rank = ranks.get(key);
    if (rank) rank.push([id, point]);
    else ranks.set(key, [[id, point]]);
  }
  const result = new Map<string, Point>();
  let shift = 0;
  for (const x of [...ranks.keys()].sort((a, b) => a - b)) {
    const column = (ranks.get(x) ?? []).sort((a, b) => a[1].y - b[1].y);
    const limit = columnLimit(column.length);
    if (column.length <= limit) {
      for (const [id, point] of column) result.set(id, { x: point.x + shift, y: point.y });
      continue;
    }
    const columns = Math.ceil(column.length / limit);
    const rows = Math.ceil(column.length / columns);
    const centre = column.reduce((sum, [, point]) => sum + point.y, 0) / column.length;
    column.forEach(([id, point], index) => {
      const col = Math.floor(index / rows);
      const row = index % rows;
      result.set(id, {
        x: point.x + shift + col * NODE_BOX.width,
        y: centre + (row - (rows - 1) / 2) * NODE_BOX.height,
      });
    });
    shift += (columns - 1) * NODE_BOX.width;
  }
  return result;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * Nodes that were already drawn keep their position. New nodes take their fresh position, moved by the
 * median shift between the fresh and the previous layout of the nodes that stayed, so they land near
 * their neighbours.
 */
export function stabilize(previous: Positions, next: Positions): Map<string, Point> {
  const dx: number[] = [];
  const dy: number[] = [];
  for (const [id, point] of next) {
    const before = previous.get(id);
    if (before) {
      dx.push(before.x - point.x);
      dy.push(before.y - point.y);
    }
  }
  const shift = { x: median(dx), y: median(dy) };
  const result = new Map<string, Point>();
  for (const [id, point] of next) {
    result.set(id, previous.get(id) ?? { x: point.x + shift.x, y: point.y + shift.y });
  }
  return result;
}

/** The bounding box of positioned nodes, padded by half a node box. */
export function bounds(positions: Iterable<Point>): { x: number; y: number; width: number; height: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of positions) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  const padX = NODE_BOX.width / 2;
  const padY = NODE_BOX.height / 2;
  return { x: minX - padX, y: minY - padY, width: maxX - minX + 2 * padX, height: maxY - minY + 2 * padY };
}
