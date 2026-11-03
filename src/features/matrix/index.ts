// The ATT&CK matrix (#20, SPEC §10.2): coverage per tactic and technique from `info catalog`.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CatalogState } from "../../core/catalog/store";
import type { FeatureContext, OpentideFolder } from "../../core/context";
import { defineFeature } from "../../core/feature";
import type { OpentidePanel } from "../../core/webview/panel";
import { buildMatrix, cellDetail, DEFAULT_FILTERS, type MatrixFilters } from "./model";
import { hostValidators, isFilters, type MatrixProtocol, type MatrixState } from "./protocol";

/** Owned by other features; used only when the window has them. */
export const SEARCH_COMMAND = "opentide.search.open";
export const NEW_OBJECTIVE_COMMAND = "opentide.new.objective";
const FILTERS_KEY = "opentide.matrix.filters";

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
      title: "ATT&CK Coverage",
      entry: "matrix",
      validators: hostValidators,
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
        await vscode.commands.executeCommand(SEARCH_COMMAND, {
          query: `technique:${technique}`,
          folder: this.folder?.path,
        });
      }),
      channel.on("newObjective", async (technique) => {
        await vscode.commands.executeCommand(NEW_OBJECTIVE_COMMAND, { technique, folder: this.folder?.path });
      }),
      channel.on("exportNavigator", () => this.exportNavigator()),
      channel.on("folder", (folder) => {
        this.folder = this.chooseFolder(folder);
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
          this.folder = this.chooseFolder();
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
      this.folder = this.chooseFolder(args.folder);
      this.post();
    }
    this.view.panel.reveal(undefined, false);
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
    if (catalog.catalog) {
      return {
        ...base,
        status: "ready",
        folder: named,
        view: buildMatrix(catalog.catalog, this.filters),
        refreshing: catalog.refreshing || catalog.status === "loading",
        message:
          catalog.status === "error" ? `The last refresh failed: ${catalog.error ?? "unknown error"}` : null,
      };
    }
    if (catalog.status === "unavailable") {
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
  }

  private select(technique: string): void {
    const catalog = this.folder ? this.ctx.catalog.get(this.folder.path).catalog : undefined;
    if (catalog) void this.view.channel.post("detail", cellDetail(catalog, technique, this.filters));
  }

  private async openObject(uuid: string): Promise<void> {
    const object = this.folder
      ? this.ctx.catalog.get(this.folder.path).catalog?.objects.find((o) => o.uuid === uuid)
      : undefined;
    if (!object) return;
    const line = Math.max(0, object.line - 1);
    await vscode.window.showTextDocument(vscode.Uri.file(object.file_path), {
      selection: new vscode.Range(line, 0, line, 0),
      viewColumn: vscode.ViewColumn.Beside,
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
