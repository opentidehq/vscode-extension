// Which nodes and edges a graph view shows: the mode (focus, catalogue, threat chains), the focus and
// its N-hop neighbourhood, and the filters. vscode-free and DOM-free: the webview imports it.
import type { GraphEdge, GraphModel, GraphNode, NodeKind, ProblemMap } from "./model";

export type GraphMode = "focus" | "catalogue" | "chains";

export interface ViewOptions {
  readonly mode: GraphMode;
  /** Node ids to focus on (focus mode). Several when opened from a search. */
  readonly focus: readonly string[];
  /** Hops around the focus, 1–3. */
  readonly depth: number;
  /** Node kinds to show. */
  readonly kinds: ReadonlySet<NodeKind>;
  /** Rule platforms to keep; empty keeps every rule. */
  readonly platforms: ReadonlySet<string>;
  /** Rule statuses to keep (case-insensitive); empty keeps every rule. */
  readonly statuses: ReadonlySet<string>;
  /** Only nodes with problems, missing references and what they touch. */
  readonly problemsOnly: boolean;
}

export interface GraphView {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Focus ids the model does not have (after a delete, or a filter that hides them). */
  readonly unknownFocus: readonly string[];
}

/** Edges that lead from a node towards what it serves: rule → objective/signal → objective → threat. */
const UPWARD = new Set(["implements", "parent", "covers"]);

export const MIN_DEPTH = 1;
export const MAX_DEPTH = 3;

export function clampDepth(depth: number): number {
  return Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, Math.round(Number.isFinite(depth) ? depth : 2)));
}

export function hasProblems(node: GraphNode, problems: ProblemMap): boolean {
  if (node.kind === "missing" || node.loadError) return true;
  const counts = problems[node.id];
  return Boolean(counts && counts.errors + counts.warnings > 0);
}

export function hasErrors(node: GraphNode, problems: ProblemMap): boolean {
  if (node.kind === "missing" || node.loadError) return true;
  return (problems[node.id]?.errors ?? 0) > 0;
}

/** Does a rule pass the platform and status filters? Both must hold on the same platform block. */
function passesRuleFilters(node: GraphNode, options: ViewOptions): boolean {
  if (node.kind !== "rule") return true;
  if (options.platforms.size === 0 && options.statuses.size === 0) return true;
  return node.platforms.some(
    (platform) =>
      (options.platforms.size === 0 || options.platforms.has(platform.id)) &&
      (options.statuses.size === 0 || options.statuses.has(platform.status.toLowerCase())),
  );
}

/**
 * Whether the mode's kinds and the platform and status filters let `node` be drawn (not the focus, the
 * depth or "problems only"): what an expanded neighbour must pass.
 */
export function passesFilters(node: GraphNode, options: ViewOptions): boolean {
  const kind =
    options.mode === "chains"
      ? node.kind === "threat" || node.kind === "missing"
      : options.kinds.has(node.kind) || node.kind === "missing";
  return kind && passesRuleFilters(node, options);
}

interface Adjacency {
  readonly all: Map<string, string[]>;
  readonly up: Map<string, string[]>;
}

function adjacency(edges: readonly GraphEdge[]): Adjacency {
  const all = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, from: string, to: string): void => {
    const list = map.get(from);
    if (list) list.push(to);
    else map.set(from, [to]);
  };
  for (const edge of edges) {
    push(all, edge.source, edge.target);
    push(all, edge.target, edge.source);
    if (UPWARD.has(edge.kind)) push(up, edge.source, edge.target);
    // A signal belongs to its objective: walking up from a signal reaches it.
    if (edge.kind === "signal") push(up, edge.target, edge.source);
  }
  return { all, up };
}

/**
 * The focus, everything within `depth` hops of it, and the chain it serves (its objective or signal,
 * their objective and that objective's threats), whatever the depth.
 */
export function neighbourhood(
  edges: readonly GraphEdge[],
  focus: readonly string[],
  depth: number,
): Set<string> {
  const { all, up } = adjacency(edges);
  const seen = new Set<string>(focus);
  let frontier = [...focus];
  for (let hop = 0; hop < clampDepth(depth) && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of all.get(id) ?? []) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }
  const stack = [...focus];
  const climbed = new Set<string>(focus);
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const parent of up.get(id) ?? []) {
      if (!climbed.has(parent)) {
        climbed.add(parent);
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return seen;
}

export function computeView(model: GraphModel, problems: ProblemMap, options: ViewOptions): GraphView {
  let nodes = model.nodes.filter((node) => {
    if (options.mode === "chains") return node.kind === "threat" || node.kind === "missing";
    return options.kinds.has(node.kind) || node.kind === "missing";
  });
  nodes = nodes.filter((node) => passesRuleFilters(node, options));
  let ids = new Set(nodes.map((node) => node.id));
  let edges = model.edges.filter(
    (edge) =>
      ids.has(edge.source) && ids.has(edge.target) && (options.mode !== "chains" || edge.kind === "chains"),
  );
  if (options.mode === "chains") {
    // A missing node shows only when a chaining edge points at it.
    const touched = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
    nodes = nodes.filter((node) => node.kind !== "missing" || touched.has(node.id));
    ids = new Set(nodes.map((node) => node.id));
  }

  if (options.problemsOnly) {
    const keep = new Set(nodes.filter((node) => hasProblems(node, problems)).map((node) => node.id));
    for (const edge of edges) {
      if (edge.missing) {
        keep.add(edge.source);
        keep.add(edge.target);
      }
    }
    nodes = nodes.filter((node) => keep.has(node.id));
    ids = keep;
    edges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  }

  const unknownFocus = options.focus.filter((id) => !ids.has(id));
  if (options.mode === "focus") {
    const focus = options.focus.filter((id) => ids.has(id));
    if (focus.length === 0) return { nodes: [], edges: [], unknownFocus };
    const keep = neighbourhood(edges, focus, options.depth);
    nodes = nodes.filter((node) => keep.has(node.id));
    edges = edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target));
  } else {
    // Missing nodes only make sense next to the reference that dangles.
    const touched = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
    nodes = nodes.filter((node) => node.kind !== "missing" || touched.has(node.id));
  }
  return { nodes, edges, unknownFocus };
}

/** Nodes whose label, UUID, path or techniques contain the text (case-insensitive). */
export function searchNodes(nodes: readonly GraphNode[], text: string): Set<string> {
  const needle = text.trim().toLowerCase();
  const found = new Set<string>();
  if (!needle) return found;
  for (const node of nodes) {
    if (
      node.label.toLowerCase().includes(needle) ||
      node.uuid?.toLowerCase().startsWith(needle) ||
      node.path?.toLowerCase().includes(needle) ||
      node.techniques.some((technique) => technique.toLowerCase() === needle)
    ) {
      found.add(node.id);
    }
  }
  return found;
}

/** The mode a graph opens in: above `limit` nodes, focus (SPEC §10.1 "Scale"). */
export function initialMode(model: GraphModel, hasFocus: boolean, limit = 1000): GraphMode {
  if (hasFocus) return "focus";
  return model.nodes.length > limit ? "focus" : "catalogue";
}
