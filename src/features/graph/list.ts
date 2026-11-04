// "View as list" (SPEC §10.1, §14): the same nodes and edges as the canvas, as a tree for keyboard and
// screen-reader users. Groups by kind, then nodes, then each node's links. vscode-free and DOM-free.
import {
  ALL_KINDS,
  edgeLabel,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type ProblemMap,
} from "./model";
import type { GraphView } from "./view";

export interface ListLink {
  /** The node at the other end. */
  readonly target: string;
  readonly text: string;
  readonly missing: boolean;
}

export interface ListNode {
  readonly node: GraphNode;
  readonly description: string;
  readonly links: readonly ListLink[];
}

export interface ListGroup {
  readonly kind: NodeKind;
  readonly label: string;
  readonly nodes: readonly ListNode[];
}

const PLURALS: Readonly<Record<NodeKind, string>> = {
  threat: "Threats",
  objective: "Objectives",
  signal: "Signals",
  rule: "Rules",
  technique: "ATT&CK techniques",
  actor: "Actors",
  logsource: "Log sources",
  platform: "Platforms",
  missing: "Missing references",
};

/** How an edge reads from its target: "implements" seen from the objective is "implemented by". */
export function incomingLabel(edge: Pick<GraphEdge, "kind" | "relation">): string {
  switch (edge.kind) {
    case "covers":
      return "covered by";
    case "implements":
      return "implemented by";
    case "parent":
      return "child signal";
    case "chains":
      return `${edgeLabel(edge)} (from)`;
    case "technique":
    case "logsource":
      return "used by";
    case "signal":
      return "signal of";
    case "actor":
      return "named by";
    case "platform":
      return "rule";
    default:
      return `${edge.kind} (from)`;
  }
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A short description of a node: platforms and status, techniques, problems. */
export function describe(node: GraphNode, problems: ProblemMap): string {
  const parts: string[] = [];
  if (node.kind === "missing") parts.push("no object has this UUID");
  if (node.loadError) parts.push(`failed to load: ${node.loadError}`);
  const counts = problems[node.id];
  if (counts?.errors) parts.push(plural(counts.errors, "error"));
  if (counts?.warnings) parts.push(plural(counts.warnings, "warning"));
  if (node.platforms.length > 0)
    parts.push(node.platforms.map((p) => (p.status ? `${p.id} ${p.status}` : p.id)).join(", "));
  if (node.kind !== "technique" && node.techniques.length > 0) parts.push(node.techniques.join(", "));
  return parts.join(" · ");
}

export function listGroups(view: GraphView, problems: ProblemMap): ListGroup[] {
  const labels = new Map(view.nodes.map((node) => [node.id, node.label]));
  const links = new Map<string, ListLink[]>();
  const push = (id: string, link: ListLink): void => {
    const list = links.get(id);
    if (list) list.push(link);
    else links.set(id, [link]);
  };
  for (const edge of view.edges) {
    push(edge.source, {
      target: edge.target,
      text: `${edgeLabel(edge)} ${labels.get(edge.target) ?? edge.target}`,
      missing: edge.missing,
    });
    push(edge.target, {
      target: edge.source,
      text: `${incomingLabel(edge)} ${labels.get(edge.source) ?? edge.source}`,
      missing: edge.missing,
    });
  }
  const groups: ListGroup[] = [];
  for (const kind of ALL_KINDS) {
    const nodes = view.nodes
      .filter((node) => node.kind === kind)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((node) => ({ node, description: describe(node, problems), links: links.get(node.id) ?? [] }));
    if (nodes.length > 0) groups.push({ kind, label: `${PLURALS[kind]} (${nodes.length})`, nodes });
  }
  return groups;
}

/** Whether a key press opens a list item's or a node's menu: the ContextMenu key or Shift+F10. */
export function opensMenu(event: { readonly key: string; readonly shiftKey: boolean }): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

/**
 * The list item that keeps the focus after the list is drawn again (new data, new problems): the same
 * item, else the closest one still there (a link's node, a node's group), else the first. Item keys are
 * `group:<kind>`, `node:<id>` and `link:<id>:<index>`; `kindOf` names a node's kind.
 */
export function keptFocus(
  key: string,
  present: readonly string[],
  kindOf: (id: string) => string | undefined,
): string | undefined {
  const has = new Set(present);
  let candidate: string | undefined = key;
  while (candidate) {
    if (has.has(candidate)) return candidate;
    if (candidate.startsWith("link:")) candidate = `node:${candidate.slice(5, candidate.lastIndexOf(":"))}`;
    else if (candidate.startsWith("node:")) {
      const kind = kindOf(candidate.slice(5));
      candidate = kind ? `group:${kind}` : undefined;
    } else candidate = undefined;
  }
  return present[0];
}
