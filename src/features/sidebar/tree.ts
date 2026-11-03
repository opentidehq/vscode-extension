// A TreeDataProvider over the plain nodes the view models build, and the TreeView around it.
import * as vscode from "vscode";
import { type TreeNode, type ViewModel, walk } from "./node";

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
  if (node.tooltip) item.tooltip = node.tooltip;
  if (node.icon)
    item.iconPath = new vscode.ThemeIcon(
      node.icon,
      node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined,
    );
  if (node.contextValue) item.contextValue = node.contextValue;
  const uri = openTargetUri(node);
  if (uri) item.resourceUri = uri;
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

export class NodeTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private model: ViewModel = { nodes: [] };
  private parents = new Map<string, TreeNode | undefined>();
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
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

  set(model: ViewModel): void {
    this.model = model;
    this.parents = new Map();
    walk(model.nodes, (node, parent) => this.parents.set(node.id, parent));
    this.view.message = model.message;
    this.view.description = model.description;
    this.view.badge = model.badge;
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return toTreeItem(node);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return node ? (node.children ?? []) : this.model.nodes;
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return this.parents.get(node.id);
  }

  dispose(): void {
    this.view.dispose();
    this.emitter.dispose();
  }
}
