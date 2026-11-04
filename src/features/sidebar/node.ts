// The sidebar's tree nodes, as plain data: every view's model builds these and index.ts turns them
// into TreeItems. vscode-free.
import type { ActivityEntry } from "../../core/activity";
import type { ObjectType } from "../../core/catalog/types";
import type { DoctorCheck } from "./health";

/** What a node is about; commands on a node read it. */
export type NodeRef =
  | {
      readonly kind: "object";
      readonly folder: string;
      readonly uuid: string;
      readonly type: ObjectType;
      readonly name: string;
      /** Absolute. */
      readonly file: string;
    }
  | {
      readonly kind: "signal";
      readonly folder: string;
      readonly uuid: string;
      readonly name: string;
      /** The objective that owns it, when known. */
      readonly objective: string | null;
    }
  | { readonly kind: "technique"; readonly folder: string; readonly id: string }
  | { readonly kind: "platform"; readonly folder: string; readonly id: string; readonly enabled: boolean }
  | {
      readonly kind: "tenant";
      readonly folder: string;
      readonly platform: string;
      readonly tenant: string;
      readonly variables: readonly string[];
    }
  | {
      readonly kind: "variable";
      readonly folder: string;
      readonly platform: string;
      readonly tenant: string;
      readonly name: string;
    }
  | { readonly kind: "check"; readonly folder: string; readonly check: DoctorCheck }
  | { readonly kind: "run"; readonly entry: ActivityEntry }
  | { readonly kind: "retry"; readonly view: string };

/** A place to open: a file path (absolute) or a URI string, at a 0-based line. */
export interface OpenTarget {
  readonly path?: string;
  readonly uri?: string;
  readonly line: number;
  readonly character?: number;
}

export interface TreeNode {
  /** Stable across refreshes, so expansion and selection survive them. */
  readonly id: string;
  readonly label: string;
  description?: string;
  readonly tooltip?: string;
  /** A Markdown tooltip (theme icons on), in place of `tooltip`. */
  readonly tooltipMarkdown?: string;
  /** A codicon id (`shield`, `loading~spin`). */
  readonly icon?: string;
  /** A theme colour id for the icon. */
  readonly iconColor?: string;
  readonly contextValue?: string;
  /** Undefined: a leaf. */
  readonly collapsed?: "collapsed" | "expanded";
  readonly open?: OpenTarget;
  /** `false`: no file decorations (problem and SCM colours) on the label, the open target aside. */
  readonly decorate?: boolean;
  /** A command a click runs (instead of opening). */
  readonly command?: { readonly command: string; readonly title: string; readonly args?: readonly unknown[] };
  readonly ref?: NodeRef;
  children?: TreeNode[];
  /** A synthetic group whose description is its child count. */
  readonly group?: boolean;
  /** What the filter matches against (lower case). */
  readonly search?: string;
  /** How a model orders the node among its siblings (not shown). */
  readonly sortKey?: string;
}

/** A view's content: its nodes, the message above them, and its badge. */
export interface ViewModel {
  readonly nodes: TreeNode[];
  readonly message?: string;
  readonly description?: string;
  readonly badge?: { readonly value: number; readonly tooltip: string };
}

/** A node with children. */
export function branch(
  node: Omit<TreeNode, "children" | "collapsed">,
  children: TreeNode[],
  collapsed: "collapsed" | "expanded" = "collapsed",
): TreeNode {
  return { ...node, children, collapsed: children.length > 0 ? collapsed : undefined };
}

/** A one-line message node (loading, error, needs a newer opentide). */
export function messageNode(
  id: string,
  label: string,
  icon: string,
  extra: Partial<TreeNode> = {},
): TreeNode {
  return { id: `message:${id}`, label, icon, ...extra };
}

/**
 * Keep the nodes that match `query` (or have a descendant that does); a matching branch keeps all its
 * children. Groups then show how many children they kept. Case-insensitive.
 */
export function filterNodes(nodes: readonly TreeNode[], query: string | undefined): TreeNode[] {
  const q = query?.trim().toLowerCase();
  if (!q) return nodes.map(countGroups);
  const keep = (node: TreeNode): TreeNode | undefined => {
    if (node.search?.includes(q)) return countGroups(node);
    const children = (node.children ?? []).map(keep).filter((child): child is TreeNode => !!child);
    if (children.length === 0) return undefined;
    return countGroups({ ...node, children, collapsed: "expanded" });
  };
  return nodes.map(keep).filter((node): node is TreeNode => !!node);
}

function countGroups(node: TreeNode): TreeNode {
  if (!node.group) return node;
  return { ...node, description: String(node.children?.length ?? 0) };
}

/** Every node, depth first, with its parent. */
export function walk(
  nodes: readonly TreeNode[],
  visit: (node: TreeNode, parent: TreeNode | undefined) => void,
  parent?: TreeNode,
): void {
  for (const node of nodes) {
    visit(node, parent);
    if (node.children) walk(node.children, visit, node);
  }
}

/**
 * The nodes with every id unique: a repeat gets `#2`, `#3`, … VS Code refuses a tree with two elements of
 * one id ("already registered") and stops drawing it, so a configuration mistake must never reach it.
 */
export function uniqueIds(nodes: readonly TreeNode[]): TreeNode[] {
  const seen = new Map<string, number>();
  const visit = (node: TreeNode): TreeNode => {
    const count = (seen.get(node.id) ?? 0) + 1;
    seen.set(node.id, count);
    const id = count === 1 ? node.id : `${node.id}#${count}`;
    const children = node.children?.map(visit);
    if (id === node.id && children === undefined) return node;
    return { ...node, id, ...(children ? { children } : {}) };
  };
  return nodes.map(visit);
}

/** What a node shows, without its children: two nodes that agree on this draw the same row. */
function face(node: TreeNode): string {
  return JSON.stringify([
    node.label,
    node.description,
    node.tooltip,
    node.tooltipMarkdown,
    node.icon,
    node.iconColor,
    node.contextValue,
    node.collapsed === undefined,
    node.open,
    node.command,
    node.ref,
  ]);
}

/**
 * The nodes to refresh so the tree shows `next` instead of `previous`, for
 * `onDidChangeTreeData(element)`: "all" when the top level changed, else the highest nodes whose row or
 * children differ (the tree maps each, by id, to the object VS Code holds, and then reads its row and
 * children by id). A refreshed node redraws its subtree. Ids must be unique.
 */
export function changedNodes(previous: readonly TreeNode[], next: readonly TreeNode[]): TreeNode[] | "all" {
  const ids = (nodes: readonly TreeNode[] | undefined) => (nodes ?? []).map((n) => n.id).join("\n");
  if (ids(previous) !== ids(next)) return "all";
  const before = new Map<string, TreeNode>();
  walk(previous, (node) => before.set(node.id, node));
  const changed: TreeNode[] = [];
  const visit = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      const old = before.get(node.id);
      if (!old) continue; // its parent's children differ, so the parent is refreshed already
      if (face(old) !== face(node) || ids(old.children) !== ids(node.children)) changed.push(old);
      else if (node.children) visit(node.children);
    }
  };
  visit(next);
  return changed;
}
