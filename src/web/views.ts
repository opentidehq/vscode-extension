// The web extension's Catalogue and Relations views and Find Detection, from the engine's index
// (src/web/catalogueModel.ts). The same view and command ids as the desktop's, so the activity bar and
// the palette are the ones people know.
import * as vscode from "vscode";
import type { ServerObject } from "../engine/catalog";
import {
  type Family,
  filterNodes,
  objectOf,
  WebIndex,
  type WebNode,
  type WebRelation,
} from "./catalogueModel";
import type { EngineSession } from "./session";

const ICONS: Record<Family, string> = {
  threat: "flame",
  objective: "target",
  rule: "shield",
  signal: "pulse",
  missing: "warning",
  other: "symbol-misc",
};

const VERBS: Record<string, [string, string]> = {
  implements: ["Implements", "Implemented by"],
  covers: ["Covers", "Covered by"],
  chains: ["Chains to", "Chained from"],
  parent: ["Child of", "Parent of"],
};

/** `vscode.open` on the object's file, at its name. */
function openCommand(uri: string, line = 0): vscode.Command {
  const position = new vscode.Position(line, 0);
  return {
    command: "vscode.open",
    title: "Open",
    arguments: [vscode.Uri.parse(uri), { selection: new vscode.Range(position, position), preview: true }],
  };
}

function nodeItem(node: WebNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.label,
    node.children.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
  );
  item.id = node.id;
  if (node.description) item.description = node.description;
  if (node.tooltip) item.tooltip = node.tooltip;
  item.iconPath = new vscode.ThemeIcon(node.uuid ? ICONS[node.family] : "folder");
  if (node.uri) {
    item.resourceUri = vscode.Uri.parse(node.uri);
    item.command = openCommand(node.uri, node.line);
    item.contextValue = `object.${node.family}`;
  }
  return item;
}

/** A Relations row: the object itself, a heading, or a related object. */
type RelationRow =
  | { kind: "object"; object: ServerObject }
  | { kind: "heading"; label: string; rows: WebRelation[] }
  | { kind: "relation"; relation: WebRelation };

class CatalogueProvider implements vscode.TreeDataProvider<WebNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  /** The Catalogue's Filter and Group By, as on the desktop (the web groups by chain or by type). */
  filter: string | undefined;
  groupBy: "chain" | "type" = "chain";

  constructor(private readonly session: EngineSession) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(node: WebNode): vscode.TreeItem {
    const item = nodeItem(node);
    if (this.filter && node.children.length > 0)
      item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    return item;
  }

  async getChildren(node?: WebNode): Promise<WebNode[]> {
    if (node) return [...node.children];
    const index = new WebIndex(await this.session.catalog());
    return filterNodes(this.groupBy === "type" ? index.byType() : index.catalogue(), this.filter);
  }
}

class RelationsProvider implements vscode.TreeDataProvider<RelationRow> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  target: vscode.Uri | undefined;

  constructor(private readonly session: EngineSession) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(row: RelationRow): vscode.TreeItem {
    if (row.kind === "object") {
      const item = new vscode.TreeItem(row.object.name, vscode.TreeItemCollapsibleState.None);
      item.description = row.object.object_type;
      item.iconPath = new vscode.ThemeIcon(
        ICONS[(row.object.object_type as Family) ?? "other"] ?? "symbol-misc",
      );
      item.command = openCommand(row.object.uri, row.object.range.start.line);
      item.contextValue = `object.${row.object.object_type}`;
      return item;
    }
    if (row.kind === "heading") {
      const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(row.rows.length);
      item.iconPath = new vscode.ThemeIcon(row.rows[0]?.direction === "in" ? "arrow-left" : "arrow-right");
      return item;
    }
    const { relation } = row;
    const item = new vscode.TreeItem(relation.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(ICONS[relation.family]);
    if (relation.missing) {
      item.description = "no object has this UUID";
      item.tooltip = relation.uuid;
    } else if (relation.uri) {
      item.description = relation.family;
      item.command = openCommand(relation.uri, relation.line);
      item.contextValue = `object.${relation.family}`;
    }
    return item;
  }

  async getChildren(row?: RelationRow): Promise<RelationRow[]> {
    if (row?.kind === "heading") return row.rows.map((relation) => ({ kind: "relation", relation }));
    if (row) return [];
    const target = this.target;
    if (!target) return [];
    const index = new WebIndex(await this.session.catalog());
    const object = index.objectAt(target.toString());
    if (!object) return [];
    const groups = new Map<string, WebRelation[]>();
    for (const relation of index.relations(object.uuid)) {
      const verbs = VERBS[relation.kind] ?? [relation.kind, relation.kind];
      const label = `${relation.direction === "out" ? verbs[0] : verbs[1]} ${relation.direction === "out" ? "→" : "←"}`;
      groups.set(label, [...(groups.get(label) ?? []), relation]);
    }
    return [
      { kind: "object", object },
      ...[...groups].map(([label, rows]): RelationRow => ({ kind: "heading", label, rows })),
    ];
  }
}

/** Register the views and Find Detection; they follow the session's index. */
export function registerViews(session: EngineSession): vscode.Disposable {
  const catalogue = new CatalogueProvider(session);
  const relations = new RelationsProvider(session);
  const catalogueView = vscode.window.createTreeView("opentide.sidebar.catalogue", {
    treeDataProvider: catalogue,
  });
  const relationsView = vscode.window.createTreeView("opentide.sidebar.relations", {
    treeDataProvider: relations,
  });
  const message =
    "From the opentide engine (WASM)'s index: names, files and references. Platforms, techniques and deployment need opentide in VS Code Desktop.";
  const update = () => {
    catalogueView.message = session.current
      ? message
      : session.hasWorkspace
        ? "Starting the opentide engine…"
        : undefined;
    catalogue.refresh();
    relations.refresh();
  };
  // Follow an editor whose file is an object of the index; another editor leaves the view as it is. Not
  // by language: a paths.toml object file gets `opentide-yaml` only after it opened.
  const follow = (editor: vscode.TextEditor | undefined) => {
    const uri = editor?.document.uri;
    if (!uri || uri.scheme === "output") return;
    void session.catalog().then((objects) => {
      if (!new WebIndex(objects).objectAt(uri.toString())) return;
      relations.target = uri;
      relationsView.description = `Following: ${uri.path.split("/").pop() ?? ""}`;
      relations.refresh();
    });
  };
  follow(vscode.window.activeTextEditor);
  update();
  return vscode.Disposable.from(
    catalogueView,
    relationsView,
    session.onDidChange(() => {
      update();
      follow(vscode.window.activeTextEditor);
    }),
    vscode.window.onDidChangeActiveTextEditor(follow),
    vscode.commands.registerCommand("opentide.sidebar.refreshCatalogue", update),
    vscode.commands.registerCommand("opentide.relations.show", async (arg?: unknown) => {
      const object = objectOf(arg);
      if (object) {
        relations.target = vscode.Uri.parse(object.uri);
        relationsView.description = `Following: ${relations.target.path.split("/").pop() ?? ""}`;
        relations.refresh();
      } else follow(vscode.window.activeTextEditor);
      await vscode.commands.executeCommand("opentide.sidebar.relations.focus");
    }),
    vscode.commands.registerCommand("opentide.relations.openToSide", async (arg?: unknown) => {
      const object = objectOf(arg);
      if (!object) return;
      const position = new vscode.Position(object.line, 0);
      await vscode.window.showTextDocument(vscode.Uri.parse(object.uri), {
        viewColumn: vscode.ViewColumn.Beside,
        selection: new vscode.Range(position, position),
        preview: true,
      });
    }),
    vscode.commands.registerCommand("opentide.sidebar.copyUuid", async (arg?: unknown) => {
      const uuid = objectOf(arg)?.uuid;
      if (uuid) await vscode.env.clipboard.writeText(uuid);
    }),
    vscode.commands.registerCommand("opentide.sidebar.revealInExplorer", async (arg?: unknown) => {
      const object = objectOf(arg);
      if (object) await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.parse(object.uri));
    }),
    vscode.commands.registerCommand("opentide.sidebar.filter", async (text?: unknown) => {
      const value =
        typeof text === "string"
          ? text
          : await vscode.window.showInputBox({
              title: "Filter the Catalogue",
              prompt: "Words in an object's name or UUID",
              value: catalogue.filter ?? "",
            });
      if (value === undefined) return;
      catalogue.filter = value.trim() || undefined;
      catalogueView.description = catalogue.filter ? `filter: ${catalogue.filter}` : undefined;
      void vscode.commands.executeCommand(
        "setContext",
        "opentide.sidebar.filtered",
        Boolean(catalogue.filter),
      );
      catalogue.refresh();
    }),
    vscode.commands.registerCommand("opentide.sidebar.clearFilter", () =>
      vscode.commands.executeCommand("opentide.sidebar.filter", ""),
    ),
    vscode.commands.registerCommand("opentide.sidebar.groupBy", async (choice?: unknown) => {
      const picked =
        choice === "chain" || choice === "type"
          ? choice
          : (
              await vscode.window.showQuickPick(
                [
                  { label: "Threat chain", value: "chain" as const },
                  { label: "Type", value: "type" as const },
                ],
                { title: "Group the Catalogue by" },
              )
            )?.value;
      if (!picked) return;
      catalogue.groupBy = picked;
      catalogue.refresh();
    }),
    vscode.commands.registerCommand("opentide.search.open", () => findDetection(session)),
  );
}

/** Find Detection: every object of the index, by name, type, UUID and file. */
async function findDetection(session: EngineSession): Promise<void> {
  const index = new WebIndex(await session.catalog());
  type Item = vscode.QuickPickItem & { object: ServerObject };
  const items: Item[] = index.objects.map((object) => ({
    label: `$(${ICONS[(object.object_type as Family) ?? "other"] ?? "symbol-misc"}) ${object.name || object.uuid}`,
    description: object.object_type,
    detail: `${vscode.workspace.asRelativePath(vscode.Uri.parse(object.uri))} · ${object.uuid}`,
    object,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "Find Detection",
    placeHolder:
      items.length > 0 ? "A threat, objective or rule, by name, UUID or file" : "No objects in the index yet",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (picked) {
    const open = openCommand(picked.object.uri, picked.object.range.start.line);
    await vscode.commands.executeCommand(open.command, ...(open.arguments ?? []));
  }
}
