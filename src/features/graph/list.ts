// "View as list" (SPEC §10.1, §14): the same nodes as the canvas, as a tree for keyboard and
// screen-reader users, structured as the details pane is: kind, then node, then its Outgoing and
// Incoming relation groups ("Implements 1 →", "← Implemented by 3"), then the related nodes.
// vscode-free and DOM-free.
import type { DetailGroup, DetailsIndex } from "./details";
import { ALL_KINDS, type GraphNode, type NodeKind, type ProblemMap } from "./model";
import type { GraphView } from "./view";

export interface ListNode {
  readonly node: GraphNode;
  readonly description: string;
  /** Outgoing groups, then incoming ones. */
  readonly relations: readonly DetailGroup[];
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

/** Separates the parts of a list item key (node ids hold `:` and `/`). */
export const KEY_SEPARATOR = "\u001f";

export const listKey = {
  group: (kind: string): string => `group:${kind}`,
  node: (id: string): string => `node:${id}`,
  relation: (id: string, group: Pick<DetailGroup, "direction" | "kind" | "relation">): string =>
    `rel:${[id, group.direction, group.kind, group.relation ?? ""].join(KEY_SEPARATOR)}`,
  link: (id: string, group: Pick<DetailGroup, "direction" | "kind" | "relation">, index: number): string =>
    `link:${[id, group.direction, group.kind, group.relation ?? "", String(index)].join(KEY_SEPARATOR)}`,
};

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

export function listGroups(view: GraphView, problems: ProblemMap, details: DetailsIndex): ListGroup[] {
  const groups: ListGroup[] = [];
  for (const kind of ALL_KINDS) {
    const nodes = view.nodes
      .filter((node) => node.kind === kind)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((node) => {
        const found = details.details(node.id);
        return {
          node,
          description: describe(node, problems),
          relations: found ? [...found.outgoing, ...found.incoming] : [],
        };
      });
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
 * item, else the closest one still there (a link's relation group, a group's node, a node's kind), else
 * the first. Keys are listKey's; `kindOf` names a node's kind.
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
    candidate = parentKey(candidate, kindOf);
  }
  return present[0];
}

/** The key of the item that holds `key`'s item; undefined for a kind group. */
export function parentKey(key: string, kindOf: (id: string) => string | undefined): string | undefined {
  if (key.startsWith("link:")) {
    const parts = key.slice(5).split(KEY_SEPARATOR);
    return `rel:${parts.slice(0, 4).join(KEY_SEPARATOR)}`;
  }
  if (key.startsWith("rel:")) return listKey.node(key.slice(4).split(KEY_SEPARATOR)[0] ?? "");
  if (key.startsWith("node:")) {
    const kind = kindOf(key.slice(5));
    return kind ? listKey.group(kind) : undefined;
  }
  return undefined;
}
