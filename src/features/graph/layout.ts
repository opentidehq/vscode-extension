// Layered left-to-right layout (dagre), and keeping positions stable across refreshes so the graph does
// not jump while you work (SPEC §10.1 "Layout"). vscode-free and DOM-free: the webview imports it.
import type { GraphEdge, GraphNode, NodeKind } from "./model";

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

/**
 * Kinds laid out in fixed columns right of the objects, not by dagre, in this order. Each links to many
 * objects, and those edges make dagre's crossing reduction take seconds, then minutes, at ~1,000 nodes.
 */
export const SATELLITE_KINDS: readonly NodeKind[] = ["technique", "logsource", "platform"];

/** Above this many laid-out nodes dagre ranks with `longest-path`, far cheaper than network simplex. */
export const LARGE_LAYOUT = 600;

/**
 * Above this many laid-out nodes dagre is skipped: even with `longest-path`, its ordering takes 10–17 s
 * at 5,000 objects, on the webview's thread. `layeredLayout` ranks and orders them in well under one.
 */
export const HUGE_LAYOUT = 1500;

const RANK_SEP = 70;
const NODE_SEP = 8;
const MARGIN = 20;

export function layout(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Map<string, Point> {
  const satellite = new Set<NodeKind>(SATELLITE_KINDS);
  const core = nodes.filter((node) => !satellite.has(node.kind));
  const positions = core.length > HUGE_LAYOUT ? layeredLayout(core, edges) : dagreLayout(core, edges);
  placeSatellites(
    positions,
    nodes.filter((node) => satellite.has(node.kind)),
    edges,
  );
  return wrapRanks(positions);
}

function dagreLayout(core: readonly GraphNode[], edges: readonly GraphEdge[]): Map<string, Point> {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: "LR",
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    marginx: MARGIN,
    marginy: MARGIN,
    ...(core.length > LARGE_LAYOUT ? { ranker: "longest-path" } : {}),
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of core) graph.setNode(node.id, { width: NODE_BOX.width, height: NODE_BOX.height });
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
  return positions;
}

/**
 * dagre's layering without dagre, for very large graphs: longest-path ranks along the layout direction
 * (a cycle is broken where it is met), then each rank ordered by the barycentre of its predecessors, one
 * sweep left to right. Linear in nodes and edges, apart from the sort per rank.
 */
export function layeredLayout(core: readonly GraphNode[], edges: readonly GraphEdge[]): Map<string, Point> {
  const index = new Map(core.map((node, i) => [node.id, i]));
  const successors: number[][] = core.map(() => []);
  const predecessors: number[][] = core.map(() => []);
  const seen = new Set<string>();
  for (const edge of edges) {
    const [from, to] = layoutDirection(edge);
    const a = index.get(from);
    const b = index.get(to);
    if (a === undefined || b === undefined || a === b || seen.has(`${a}>${b}`)) continue;
    seen.add(`${a}>${b}`);
    successors[a]?.push(b);
    predecessors[b]?.push(a);
  }
  // Kahn's algorithm; what a cycle leaves unranked starts from the lowest-index node left, as a source.
  const rank = new Array<number>(core.length).fill(-1);
  const waiting = predecessors.map((list) => list.length);
  const queue: number[] = [];
  for (let i = 0; i < core.length; i++) if (waiting[i] === 0) queue.push(i);
  let ranked = 0;
  let next = 0;
  for (;;) {
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head] as number;
      if (rank[node] !== -1) continue;
      let r = 0;
      for (const p of predecessors[node] ?? []) {
        const pr = rank[p] as number;
        if (pr >= 0) r = Math.max(r, pr + 1);
      }
      rank[node] = r;
      ranked++;
      for (const s of successors[node] ?? []) {
        waiting[s] = (waiting[s] as number) - 1;
        if (waiting[s] === 0) queue.push(s);
      }
    }
    if (ranked === core.length) break;
    while (next < core.length && rank[next] !== -1) next++;
    queue.length = 0;
    queue.push(next);
  }
  const ranks: number[][] = [];
  for (let i = 0; i < core.length; i++) {
    const r = rank[i] as number;
    const members = ranks[r];
    if (members) members.push(i);
    else ranks[r] = [i];
  }
  const order = new Array<number>(core.length).fill(0);
  const positions = new Map<string, Point>();
  const step = NODE_BOX.height + NODE_SEP;
  ranks.forEach((members, r) => {
    const keyed = members.map((node) => {
      const ps = (predecessors[node] ?? []).filter((p) => (rank[p] as number) < r);
      const centre = ps.length ? ps.reduce((sum, p) => sum + (order[p] as number), 0) / ps.length : node;
      return { node, centre };
    });
    keyed.sort((a, b) => a.centre - b.centre || a.node - b.node);
    const x = MARGIN + NODE_BOX.width / 2 + r * (NODE_BOX.width + RANK_SEP);
    keyed.forEach(({ node }, i) => {
      order[node] = i;
      positions.set(core[node]?.id as string, { x, y: (i - (keyed.length - 1) / 2) * step });
    });
  });
  return positions;
}

/**
 * Put technique, log-source and platform nodes in one column per kind right of everything else, each
 * at the mean height of the objects that reference it, moved down where it would overlap the one above.
 */
export function placeSatellites(
  positions: Map<string, Point>,
  satellites: readonly GraphNode[],
  edges: readonly GraphEdge[],
): void {
  if (satellites.length === 0) return;
  const sums = new Map<string, { y: number; count: number }>();
  const add = (id: string, other: string) => {
    const point = positions.get(other);
    if (!point) return;
    const sum = sums.get(id) ?? { y: 0, count: 0 };
    sums.set(id, { y: sum.y + point.y, count: sum.count + 1 });
  };
  for (const edge of edges) {
    add(edge.source, edge.target);
    add(edge.target, edge.source);
  }
  let x = 20 + NODE_BOX.width / 2;
  let top = 20 + NODE_BOX.height / 2;
  for (const point of positions.values()) {
    x = Math.max(x, point.x);
    top = Math.min(top, point.y);
  }
  for (const kind of SATELLITE_KINDS) {
    const column = satellites
      .filter((node) => node.kind === kind)
      .map((node) => {
        const sum = sums.get(node.id);
        return { id: node.id, want: sum ? sum.y / sum.count : Number.POSITIVE_INFINITY };
      })
      .sort((a, b) => a.want - b.want || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (column.length === 0) continue;
    x += NODE_BOX.width + RANK_SEP;
    let previous = Number.NEGATIVE_INFINITY;
    for (const { id, want } of column) {
      const floor = previous + NODE_BOX.height;
      const y = Number.isFinite(want) ? Math.max(want, floor) : Number.isFinite(floor) ? floor : top;
      positions.set(id, { x, y });
      previous = y;
    }
  }
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
