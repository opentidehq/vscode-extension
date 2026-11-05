// The ATT&CK matrix (#20, SPEC §10.2): coverage per tactic and technique from `info catalog`.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { loadedObjects } from "../../core/catalog/rows";
import type { CatalogState } from "../../core/catalog/store";
import type { CatalogDocument } from "../../core/catalog/types";
import type { FeatureContext, OpentideFolder } from "../../core/context";
import { defineFeature } from "../../core/feature";
import type { OpentidePanel } from "../../core/webview/panel";
import { fileColumnFrom, panelTitle } from "../../core/webview/placement";
import {
  buildMatrix,
  cellDetail,
  cleanFilters,
  DEFAULT_FILTERS,
  filterChoices,
  type MatrixFilters,
} from "./model";
import { hostValidators, isFilters, type MatrixProtocol, type MatrixState } from "./protocol";

/** Owned by other features; used only when the window has them. */
export const SEARCH_COMMAND = "opentide.search.open";
/** The new-object feature's objective flow. `opentide new objective` takes no technique, so only the folder. */
export const NEW_OBJECTIVE_COMMAND = "opentide.newObject.objective";
const FILTERS_KEY = "opentide.matrix.filters";

/** Find Detection on one technique, in the matrix's folder (search's `t:` filter). */
export function searchArgs(
  technique: string,
  folder: string | undefined,
): { query: string; folder?: string } {
  return { query: `t:${technique}`, ...(folder ? { folder } : {}) };
}

/** What the new-object flow accepts (`NewObjectArgs`): the folder to create the objective in. */
export function newObjectiveArgs(folder: string | undefined): { kind: "objective"; folder?: string } {
  return { kind: "objective", ...(folder ? { folder } : {}) };
}

export interface OpenArgs {
  readonly folder?: string;
  readonly technique?: string;
}

/** `opentide.matrix.open`'s argument: nothing, a folder path or URI, or `{ folder?, technique? }`. */
export function parseOpenArgs(arg: unknown): OpenArgs {
  if (typeof arg === "string")
    return /^T\d{4}(\.\d{3})?$/i.test(arg) ? { technique: arg.toUpperCase() } : { folder: arg };
  if (arg instanceof vscode.Uri) return { folder: arg.fsPath };
  if (typeof arg === "object" && arg !== null) {
    const { folder, technique } = arg as { folder?: unknown; technique?: unknown };
    return {
      ...(typeof folder === "string" ? { folder } : {}),
      ...(typeof technique === "string" ? { technique: technique.toUpperCase() } : {}),
    };
  }
  return {};
}

export default defineFeature({
  id: "matrix",
  activate(ctx) {
    let matrix: MatrixPanel | undefined;
    ctx.subscriptions.push(
      vscode.commands.registerCommand("opentide.matrix.open", async (arg?: unknown) => {
        const args = parseOpenArgs(arg);
        if (matrix) matrix.reveal(args);
        else {
          matrix = new MatrixPanel(ctx, args, () => {
            matrix = undefined;
          });
        }
      }),
      { dispose: () => matrix?.dispose() },
    );
  },
});

class MatrixPanel implements vscode.Disposable {
  private readonly view: OpentidePanel<MatrixProtocol>;
  private readonly disposables: vscode.Disposable[] = [];
  private folder: OpentideFolder | undefined;
  private filters: MatrixFilters;
  private features = { search: false, newObjective: false, navigator: false };
  private pendingFocus: string | undefined;
  /** The technique the detail aside lists, re-listed whenever filters, folder or catalogue change. */
  private selected: string | undefined;

  constructor(
    private readonly ctx: FeatureContext,
    args: OpenArgs,
    onDispose: () => void,
  ) {
    const saved = ctx.extension.workspaceState.get<unknown>(FILTERS_KEY);
    this.filters = isFilters(saved) ? saved : DEFAULT_FILTERS;
    this.folder = this.chooseFolder(args.folder);
    this.pendingFocus = args.technique;
    this.view = ctx.webview.createPanel<MatrixProtocol>({
      viewType: "opentide.matrix",
      title: matrixTitle(this.folder?.folder.name, ctx.folders.all.length),
      entry: "matrix",
      validators: hostValidators,
      // Opened on a technique from an editor (a hover, a lens), it goes beside it; otherwise it is a
      // page of its own in the active group.
      beside: args.technique !== undefined,
      kit: true,
      retainContextWhenHidden: true,
    });
    const { channel, panel } = this.view;
    this.disposables.push(
      channel.on("ready", async () => {
        await this.detectFeatures();
        this.post();
        if (this.pendingFocus) this.focus(this.pendingFocus);
      }),
      channel.on("filters", (filters) => {
        this.filters = filters;
        void ctx.extension.workspaceState.update(FILTERS_KEY, filters);
        this.post();
      }),
      channel.on("select", (technique) => this.select(technique)),
      channel.on("open", (uuid) => this.openObject(uuid)),
      channel.on("search", async (technique) => {
        await vscode.commands.executeCommand(SEARCH_COMMAND, searchArgs(technique, this.folder?.path));
      }),
      channel.on("newObjective", async () => {
        await vscode.commands.executeCommand(NEW_OBJECTIVE_COMMAND, newObjectiveArgs(this.folder?.path));
      }),
      channel.on("exportNavigator", () => this.exportNavigator()),
      channel.on("folder", (folder) => {
        this.setFolder(this.chooseFolder(folder));
        this.post();
      }),
      channel.on("action", async (id) => {
        if (id === "trust") await vscode.commands.executeCommand("workbench.trust.manage");
        else if (id === "switchRuntime") await vscode.commands.executeCommand("opentide.switchRuntime");
        else if (id === "output") ctx.log.show();
        else if (id === "refresh" && this.folder)
          await ctx.catalog.refresh(this.folder.path, { immediate: true });
      }),
      ctx.catalog.onDidChange((state) => {
        if (state.folder === this.folder?.path) this.post();
      }),
      ctx.folders.onDidChange(() => {
        if (!this.folder || !ctx.folders.all.some((f) => f.path === this.folder?.path))
          this.setFolder(this.chooseFolder());
        this.post();
      }),
      ctx.capabilities.onDidChange(async () => {
        await this.detectFeatures();
        this.post();
      }),
      panel.onDidDispose(() => {
        for (const d of this.disposables) d.dispose();
        onDispose();
      }),
    );
  }

  /** A new folder clears the selection: the detail would list another folder's objects. */
  private setFolder(folder: OpentideFolder | undefined): void {
    if (folder?.path !== this.folder?.path && this.selected) {
      this.selected = undefined;
      void this.view.channel.post("detail", null);
    }
    this.folder = folder;
    this.view.panel.title = matrixTitle(folder?.folder.name, this.ctx.folders.all.length);
  }

  /** The saved filters, less a platform or tenant the catalogue does not have. */
  private filtersFor(catalog: CatalogDocument): MatrixFilters {
    return cleanFilters(this.filters, filterChoices(catalog));
  }

  private chooseFolder(wanted?: string): OpentideFolder | undefined {
    const all = this.ctx.folders.all;
    const active = vscode.window.activeTextEditor?.document.uri;
    return (
      all.find((f) => f.path === wanted) ??
      (active ? this.ctx.folders.folderOf(active) : undefined) ??
      this.folder ??
      all[0]
    );
  }

  reveal(args: OpenArgs): void {
    if (args.folder) {
      this.setFolder(this.chooseFolder(args.folder));
      this.post();
    }
    // Asked for a technique from an editor: forward where it is, the focus stays in the editor.
    this.view.panel.reveal(
      undefined,
      args.technique !== undefined && vscode.window.activeTextEditor !== undefined,
    );
    if (args.technique) this.focus(args.technique);
  }

  private focus(technique: string): void {
    this.pendingFocus = undefined;
    void this.view.channel.post("focus", technique);
    this.select(technique);
  }

  private async detectFeatures(): Promise<void> {
    await this.ctx.capabilities.ready();
    const commands = new Set(await vscode.commands.getCommands(true));
    this.features = {
      search: commands.has(SEARCH_COMMAND),
      newObjective: commands.has(NEW_OBJECTIVE_COMMAND),
      navigator: this.ctx.capabilities.hasCommand("generate exports navigator"),
    };
  }

  private state(): MatrixState {
    const folders = this.ctx.folders.all.map((f) => ({ path: f.path, name: f.folder.name }));
    const base = {
      folders,
      filters: this.filters,
      features: this.features,
      view: null,
      message: null,
      action: null,
      refreshing: false,
    };
    const folder = this.folder;
    if (!folder) {
      return {
        ...base,
        status: "no-folder",
        folder: null,
        message: "Open a folder with objects/ or .opentide/.",
      };
    }
    const named = { path: folder.path, name: folder.folder.name };
    const catalog: CatalogState = this.ctx.catalog.get(folder.path);
    // A catalogue from the language server's index has no techniques: the matrix needs opentide.
    if (catalog.catalog && catalog.source !== "server") {
      const filters = this.filtersFor(catalog.catalog);
      return {
        ...base,
        filters,
        status: "ready",
        folder: named,
        view: buildMatrix(catalog.catalog, filters),
        refreshing: catalog.refreshing || catalog.status === "loading",
        message:
          catalog.status === "error" ? `The last refresh failed: ${catalog.error ?? "unknown error"}` : null,
      };
    }
    if (catalog.status === "unavailable" || catalog.source === "server") {
      const reason = catalog.unavailable?.reason;
      if (reason === "untrusted")
        return {
          ...base,
          status: "unavailable",
          folder: named,
          message: "Coverage comes from opentide, which runs only in a trusted folder.",
          action: { id: "trust", label: "Trust this folder…" },
        };
      if (reason === "needs-command") {
        const version = this.ctx.runtime.current?.version;
        return {
          ...base,
          status: "unavailable",
          folder: named,
          message: `The ATT&CK matrix needs a newer opentide: ${version ? `opentide ${version}` : "this one"} has no info catalog command. Upgrade opentide, or switch to a runtime that has it.`,
          action: { id: "switchRuntime", label: "Switch runtime…" },
        };
      }
      return {
        ...base,
        status: "unavailable",
        folder: named,
        message: catalog.unavailable?.message ?? "opentide is not available.",
        action: { id: "switchRuntime", label: "Switch runtime…" },
      };
    }
    if (catalog.status === "error") {
      return {
        ...base,
        status: "error",
        folder: named,
        message: catalog.error ?? "opentide info catalog failed.",
        action: { id: "refresh", label: "Retry" },
      };
    }
    return { ...base, status: "loading", folder: named };
  }

  private post(): void {
    void this.view.channel.post("state", this.state());
    // The detail follows the filters, the folder and the catalogue, like the cells do.
    if (this.selected) this.postDetail(this.selected);
  }

  private select(technique: string): void {
    this.selected = technique;
    this.postDetail(technique);
  }

  private postDetail(technique: string): void {
    const catalog = this.folder ? this.ctx.catalog.get(this.folder.path).catalog : undefined;
    if (catalog)
      void this.view.channel.post("detail", cellDetail(catalog, technique, this.filtersFor(catalog)));
  }

  private async openObject(uuid: string): Promise<void> {
    const object = this.folder
      ? loadedObjects(this.ctx.catalog.get(this.folder.path).catalog?.objects ?? []).find(
          (o) => o.uuid === uuid,
        )
      : undefined;
    if (!object) {
      void vscode.window.showWarningMessage(
        "That object is no longer in this folder's catalogue. Select the technique again.",
      );
      return;
    }
    const line = Math.max(0, object.line - 1);
    // Beside the matrix (or in the group left of it), in preview: the matrix stays in view.
    await vscode.window.showTextDocument(vscode.Uri.file(object.file_path), {
      selection: new vscode.Range(line, 0, line, 0),
      viewColumn: fileColumnFrom(this.view.panel.viewColumn) ?? vscode.ViewColumn.Beside,
      preview: true,
    });
  }

  private async exportNavigator(): Promise<void> {
    const folder = this.folder;
    if (!folder) return;
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Exporting the ATT&CK Navigator layer",
          cancellable: true,
        },
        (_progress, token) =>
          this.ctx.backend.run(folder.path, ["generate", "exports", "navigator"], { cancellation: token }),
      );
      if (result.cancelled) return;
      if (result.exitCode !== 0) {
        void vscode.window.showWarningMessage(`Export failed: ${result.document.message}`);
        return;
      }
      const file = navigatorFile(folder.path, result.document);
      if (!file) {
        void vscode.window.showInformationMessage(result.document.message);
        return;
      }
      const uri = vscode.Uri.file(file);
      await vscode.commands.executeCommand("revealInExplorer", uri);
      const open = await vscode.window.showInformationMessage(
        `Exported ${path.relative(folder.path, file)}. Load it in ATT&CK Navigator.`,
        "Open",
      );
      if (open) await vscode.window.showTextDocument(uri);
    } catch (error) {
      void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
    }
  }

  dispose(): void {
    this.view.dispose();
  }
}

/** The matrix's tab title: the folder's name in a multi-root window. */
export function matrixTitle(folder: string | undefined, folders: number): string {
  return panelTitle("ATT&CK Coverage", folders > 1 ? folder : null);
}

/** The layer file `generate exports navigator` wrote: a step's `where`, else the documented path. */
export function navigatorFile(
  folder: string,
  document: Readonly<Record<string, unknown>>,
): string | undefined {
  const steps = Array.isArray(document.steps) ? document.steps : [];
  const candidates: string[] = [];
  for (const step of steps) {
    const where = (step as { where?: unknown }).where;
    if (typeof where === "string" && where.endsWith(".json"))
      candidates.push(path.isAbsolute(where) ? where : path.join(folder, where));
  }
  candidates.push(path.join(folder, ".opentide", "exports", "attack-navigator.json"));
  return candidates.find((file) => fs.existsSync(file));
}
