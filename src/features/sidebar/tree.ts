// A TreeDataProvider over the plain nodes the view models build, and the TreeView around it.
import * as vscode from "vscode";
import { changedNodes, type TreeNode, uniqueIds, type ViewModel, walk } from "./node";

export function openTargetUri(node: TreeNode): vscode.Uri | undefined {
  if (!node.open) return undefined;
  if (node.open.uri) return vscode.Uri.parse(node.open.uri);
  return node.open.path ? vscode.Uri.file(node.open.path) : undefined;
}

export function toTreeItem(node: TreeNode): vscode.TreeItem {
  const state =
    node.collapsed === "expanded"
      ? vscode.TreeItemCollapsibleState.Expanded
      : node.collapsed === "collapsed"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
  const item = new vscode.TreeItem(node.label, state);
  item.id = node.id;
  if (node.description) item.description = node.description;
  if (node.tooltipMarkdown) {
    const markdown = new vscode.MarkdownString(node.tooltipMarkdown, true);
    item.tooltip = markdown;
  } else if (node.tooltip) item.tooltip = node.tooltip;
  if (node.icon)
    item.iconPath = new vscode.ThemeIcon(
      node.icon,
      node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined,
    );
  if (node.contextValue) item.contextValue = node.contextValue;
  const uri = openTargetUri(node);
  if (uri && node.decorate !== false) item.resourceUri = uri;
  // The file's decorations (problems, SCM) colour the label; the ThemeIcon stays the icon.
  if (node.command) {
    item.command = {
      command: node.command.command,
      title: node.command.title,
      arguments: [...(node.command.args ?? [])],
    };
  } else if (node.open && uri) {
    item.command = { command: "opentide.sidebar.open", title: "Open", arguments: [node] };
  }
  item.accessibilityInformation = {
    label: [node.label, node.description].filter(Boolean).join(", "),
  };
  return item;
}

/** Above this many changed rows a whole-tree refresh is cheaper than one per row. */
const MAX_PARTIAL = 100;

export class NodeTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private model: ViewModel = { nodes: [] };
  private parents = new Map<string, TreeNode | undefined>();
  /** The latest node of each id: VS Code may hold an older object of an id it has not refreshed. */
  private byId = new Map<string, TreeNode>();
  /**
   * The object of each id VS Code was last handed (getChildren): it finds a refreshed element by
   * identity, and a model rebuilt without changes has new objects it never saw.
   */
  private readonly handed = new Map<string, TreeNode>();
  private readonly emitter = new vscode.EventEmitter<TreeNode | TreeNode[] | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly view: vscode.TreeView<TreeNode>;

  constructor(viewId: string) {
    this.view = vscode.window.createTreeView(viewId, {
      treeDataProvider: this,
      showCollapseAll: true,
    });
  }

  get nodes(): readonly TreeNode[] {
    return this.model.nodes;
  }

  /**
   * Show `model`. Only the rows that changed are refreshed (`onDidChangeTreeData` with those
   * elements), so a catalogue refresh or a diagnostics change does not redraw the whole tree.
   */
  set(model: ViewModel): void {
    const previous = this.model.nodes;
    this.model = { ...model, nodes: uniqueIds(model.nodes) };
    this.parents = new Map();
    this.byId = new Map();
    walk(this.model.nodes, (node, parent) => {
      this.parents.set(node.id, parent);
      this.byId.set(node.id, node);
    });
    if (this.view.message !== model.message) this.view.message = model.message;
    if (this.view.description !== model.description) this.view.description = model.description;
    if (this.view.badge?.value !== model.badge?.value || this.view.badge?.tooltip !== model.badge?.tooltip)
      this.view.badge = model.badge;
    const changed = changedNodes(previous, this.model.nodes);
    if (changed === "all" || changed.length > MAX_PARTIAL) {
      this.handed.clear();
      this.emitter.fire(undefined);
      return;
    }
    // A row VS Code never drew is read fresh when it is.
    const known = changed.map((node) => this.handed.get(node.id)).filter((n): n is TreeNode => !!n);
    if (known.length > 0) this.emitter.fire(known);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return toTreeItem(this.byId.get(node.id) ?? node);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    const children = node ? ((this.byId.get(node.id) ?? node).children ?? []) : this.model.nodes;
    for (const child of children) this.handed.set(child.id, child);
    return children;
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return this.parents.get(node.id);
  }

  dispose(): void {
    this.view.dispose();
    this.emitter.dispose();
  }
}
