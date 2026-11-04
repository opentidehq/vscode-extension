// The graph panel (SPEC §10.1): how threats, objectives, signals, rules, techniques and log sources
// connect, from `info catalog`. It opens beside the editor it is asked from and follows the active
// editor unless pinned. Glue only; the logic is in model.ts, view.ts, layout.ts, details.ts, diff.ts,
// placement.ts and state.ts, and the drawing in webview/graph/main.ts.
import * as vscode from "vscode";
import type { CatalogState } from "../../core/catalog/store";
import type { FeatureContext, OpentideFolder } from "../../core/context";
import { defineFeature } from "../../core/feature";
import type { OpentidePanel } from "../../core/webview/panel";
import { NODE_ACTION_COMMANDS, NODE_ACTIONS, type NodeAction, nodeCommand } from "./actions";
import { ModelSender } from "./diff";
import { EditorFollow, FOLLOW_DELAY_MS, openColumn, showPlan } from "./placement";
import {
  type ExportRequest,
  type GraphAction,
  type GraphProtocol,
  hostValidators,
  type NodeActionRequest,
} from "./protocol";
import {
  ChangedOnly,
  EXPORT_FILTERS,
  exportBytes,
  type FileProblems,
  folderWithNode,
  type GraphPanelStatus,
  graphData,
  inFolder,
  ModelCache,
  objectAtPath,
  outgoingData,
  parseOpenArgs,
  parseRevealArgs,
  problemsFor,
} from "./state";
import type { GraphMode } from "./view";

class GraphPanel implements vscode.Disposable {
  private opened: OpentidePanel<GraphProtocol> | undefined;
  private folder: OpentideFolder | undefined;
  private readonly cache = new ModelCache();
  private ready = false;
  private pendingFocus: GraphProtocol["toWebview"]["focus"] | undefined;
  private problemsTimer: NodeJS.Timeout | undefined;
  /** The problem map last posted to this webview, so an unchanged one is not posted again. */
  private readonly problemsSent = new ChangedOnly();
  /** The model last posted to this webview, so a catalogue change posts only what changed. */
  private readonly modelSent = new ModelSender();
  /** The node (or, before the catalogue loads, the file) the graph is on. */
  private target: string | undefined;
  /** Follow the active editor, or pinned; the file awaited before the catalogue loads. */
  private readonly follower = new EditorFollow<vscode.TextEditor>(FOLLOW_DELAY_MS, (editor) =>
    this.follow(editor),
  );
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: FeatureContext) {
    this.disposables.push(
      { dispose: ctx.catalog.onDidChange((state) => this.onCatalog(state)).dispose },
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.follower.editorChanged(editor, this.opened !== undefined),
      ),
      vscode.languages.onDidChangeDiagnostics(() => this.scheduleProblems()),
    );
  }

  /** What tests and other features may read: where the panel is and what it shows. */
  status(): GraphPanelStatus {
    return {
      open: this.opened !== undefined,
      ...(this.opened?.panel.viewColumn !== undefined ? { viewColumn: this.opened.panel.viewColumn } : {}),
      following: this.follower.following,
      ...(this.target ? { target: this.target } : {}),
    };
  }

  /** Show the open panel where it is, without changing what it shows. */
  revealAsIs(): GraphPanelStatus {
    this.opened?.panel.reveal(undefined, true);
    return this.status();
  }

  async show(
    folder: OpentideFolder,
    focus?: GraphProtocol["toWebview"]["focus"],
    file?: string,
  ): Promise<GraphPanelStatus> {
    const switched = this.folder?.path !== folder.path;
    this.folder = folder;
    const editor = vscode.window.activeTextEditor;
    const plan = showPlan({
      ...(editor?.viewColumn !== undefined ? { editorColumn: editor.viewColumn } : {}),
      ...(this.opened?.panel.viewColumn !== undefined ? { panelColumn: this.opened.panel.viewColumn } : {}),
    });
    if (!this.opened) {
      this.ready = false;
      this.opened = this.ctx.webview.createPanel<GraphProtocol>({
        viewType: "opentide.graph",
        title: this.title(),
        entry: "graph",
        validators: hostValidators,
        column: plan.column,
        preserveFocus: plan.preserveFocus,
        retainContextWhenHidden: true,
        enableFindWidget: false,
      });
      this.wire(this.opened);
    } else {
      this.opened.panel.title = this.title();
      this.opened.panel.reveal(plan.column, plan.preserveFocus);
    }
    // An explicit request retargets the graph even when it is pinned; the pin then holds the new object,
    // and a follow still waiting for its delay must not move it on.
    if (focus) this.follower.explicitRequest();
    if (focus?.ids[0]) this.target = focus.ids[0];
    if (focus) this.pendingFocus = focus;
    else if (!this.pendingFocus && this.follower.following)
      this.pendingFocus = this.editorFocus(vscode.window.activeTextEditor, false);
    const editorFile = vscode.window.activeTextEditor?.document.uri;
    const wanted = file ?? (editorFile?.scheme === "file" ? editorFile.fsPath : undefined);
    this.follower.awaitFile(
      !this.pendingFocus && !this.state()?.catalog && wanted
        ? { path: wanted, explicit: file !== undefined }
        : undefined,
    );
    const awaited = this.follower.awaiting;
    if (awaited) this.target = awaited.path;
    else if (this.pendingFocus?.ids[0]) this.target = this.pendingFocus.ids[0];
    if (this.ready) {
      if (switched) {
        this.modelSent.reset();
        this.postData();
        this.problemsSent.reset();
        this.postProblems();
      }
      this.flushFocus();
    }
    return this.status();
  }

  private title(): string {
    const many = this.ctx.folders.all.length > 1 && this.folder;
    return many ? `opentide graph: ${this.folder?.folder.name}` : "opentide graph";
  }

  private wire(opened: OpentidePanel<GraphProtocol>): void {
    const { channel, panel } = opened;
    const subscriptions = [
      channel.on("ready", () => {
        this.ready = true;
        this.problemsSent.reset();
        this.modelSent.reset();
        this.postData();
        this.postProblems();
        void opened.channel.post("follow", { following: this.follower.following });
        this.flushFocus();
        void this.postActions(opened);
      }),
      channel.on("resync", () => {
        this.modelSent.reset();
        this.postData();
      }),
      channel.on("follow", (following) => {
        const last = this.follower.setFollowing(following);
        void opened.channel.post("follow", { following });
        // Unpinned: catch up with the editor now. The graph has the focus, so the active editor is
        // undefined: the last one seen, if it is still open.
        const editor =
          vscode.window.activeTextEditor ??
          (last && vscode.window.visibleTextEditors.includes(last) ? last : undefined);
        if (following && editor) this.follow(editor);
      }),
      channel.on("nodeAction", (request) => this.nodeAction(request)),
      channel.on("open", (id) => this.open(id)),
      channel.on("copy", async (text) => {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.setStatusBarMessage(`Copied ${text}`, 2000);
      }),
      channel.on("export", (request) => this.export(request)),
      channel.on("action", (action) => this.action(action)),
      channel.on("log", (message) => this.ctx.log.debug(`graph: ${message}`)),
    ];
    panel.onDidDispose(() => {
      for (const subscription of subscriptions) subscription.dispose();
      this.follower.reset();
      this.opened = undefined;
      this.ready = false;
      this.pendingFocus = undefined;
      this.target = undefined;
    });
  }

  private state(): CatalogState | undefined {
    return this.folder ? this.ctx.catalog.get(this.folder.path) : undefined;
  }

  private postData(): void {
    if (!this.opened || !this.ready) return;
    const state = this.state();
    if (!this.folder || !state) {
      this.modelSent.reset();
      void this.opened.channel.post("data", {
        status: "no-folder",
        folder: "",
        refreshing: false,
        message: "Open a folder with an opentide workspace (.opentide/ or objects/).",
      });
      return;
    }
    void this.opened.channel.post(
      "data",
      outgoingData(graphData(state, this.folder.folder.name, this.cache), this.modelSent),
    );
  }

  private flushFocus(): void {
    if (!this.opened || !this.ready || !this.pendingFocus) return;
    void this.opened.channel.post("focus", this.pendingFocus);
    this.pendingFocus = undefined;
  }

  private onCatalog(state: CatalogState): void {
    if (!this.opened || state.folder !== this.folder?.path) return;
    this.postData();
    this.postProblems();
    const awaited = state.catalog ? this.follower.takeAwaited() : undefined;
    if (awaited && state.catalog) {
      const { path, explicit } = awaited;
      const id = objectAtPath(state.catalog, path, process.platform);
      if (id) {
        this.pendingFocus = { ids: [id], explicit };
        this.flushFocus();
      }
    }
  }

  /** The node of the object open in `editor`, as a focus request. */
  private editorFocus(
    editor: vscode.TextEditor | undefined,
    explicit: boolean,
  ): GraphProtocol["toWebview"]["focus"] | undefined {
    const catalog = this.state()?.catalog;
    if (!editor || !catalog || editor.document.uri.scheme !== "file") return undefined;
    const id = objectAtPath(catalog, editor.document.uri.fsPath, process.platform);
    return id ? { ids: [id], explicit } : undefined;
  }

  private follow(editor: vscode.TextEditor | undefined): void {
    if (!this.opened || !editor || !this.folder || !this.follower.following) return;
    const folder = this.ctx.folders.folderOf(editor.document.uri);
    if (folder?.path !== this.folder.path) return;
    const focus = this.editorFocus(editor, false);
    if (focus) {
      this.target = focus.ids[0];
      this.pendingFocus = focus;
      this.flushFocus();
    } else if (!this.state()?.catalog && editor.document.uri.scheme === "file") {
      // Before the catalogue loads: the file, focused once it arrives.
      this.follower.awaitFile({ path: editor.document.uri.fsPath, explicit: false });
      this.target = editor.document.uri.fsPath;
    }
  }

  private scheduleProblems(): void {
    if (!this.opened) return;
    if (this.problemsTimer) clearTimeout(this.problemsTimer);
    this.problemsTimer = setTimeout(() => this.postProblems(), 500);
  }

  private postProblems(): void {
    const catalog = this.state()?.catalog;
    if (!this.opened || !this.ready || !this.folder) return;
    const root = this.folder.folder.uri.fsPath;
    const files: FileProblems[] = [];
    for (const [uri, diagnostics] of catalog ? vscode.languages.getDiagnostics() : []) {
      if (uri.scheme !== "file" || !inFolder(root, uri.fsPath, process.platform)) continue;
      let errors = 0;
      let warnings = 0;
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity === vscode.DiagnosticSeverity.Error) errors += 1;
        else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) warnings += 1;
      }
      if (errors + warnings > 0) files.push({ file: uri.fsPath, errors, warnings });
    }
    const problems = problemsFor(catalog, files, process.platform);
    // Every diagnostics change schedules this; an unchanged map would only redraw the view as list,
    // and move a screen reader's place in it.
    if (!this.problemsSent.changed(problems)) return;
    void this.opened.channel.post("problems", problems);
  }

  private async open(id: string): Promise<void> {
    const catalog = this.state()?.catalog;
    if (!catalog) return;
    const target = this.cache.get(catalog).nodes.find((candidate) => candidate.id === id);
    if (!target?.filePath) return;
    const line = Math.max(0, (target.line ?? 1) - 1);
    const recent = [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors]
      .map((editor) => editor?.viewColumn)
      .filter((column): column is vscode.ViewColumn => column !== undefined);
    const column = openColumn(this.opened?.panel.viewColumn, recent);
    await vscode.window.showTextDocument(vscode.Uri.file(target.filePath), {
      viewColumn: column,
      selection: new vscode.Range(line, 0, line, 0),
      preview: true,
    });
  }

  /** Which node actions the window has (another feature that failed to start registers nothing). */
  private async postActions(opened: OpentidePanel<GraphProtocol>): Promise<void> {
    const commands = new Set(await vscode.commands.getCommands(true));
    const available = NODE_ACTIONS.filter((action: NodeAction) => commands.has(NODE_ACTION_COMMANDS[action]));
    void opened.channel.post("actions", available);
  }

  private async nodeAction(request: NodeActionRequest): Promise<void> {
    const catalog = this.state()?.catalog;
    if (!catalog || !this.folder) return;
    const node = this.cache.get(catalog).nodes.find((candidate) => candidate.id === request.id);
    const run = node ? nodeCommand(request.action, node, this.folder.path) : undefined;
    if (!run) return;
    const args = run.file ? [vscode.Uri.file(run.file)] : run.args;
    await vscode.commands.executeCommand(run.command, ...args);
  }

  private async export(request: ExportRequest): Promise<void> {
    const filter = EXPORT_FILTERS[request.format];
    const base = this.folder?.folder.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      title: `Export the graph as ${filter.name}`,
      saveLabel: "Export",
      filters: { [filter.name]: [filter.extension] },
      ...(base ? { defaultUri: vscode.Uri.joinPath(base, `opentide-graph.${filter.extension}`) } : {}),
    });
    if (!target) return;
    try {
      await vscode.workspace.fs.writeFile(target, exportBytes(request.format, request.data));
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not export the graph: ${String(error)}`);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Exported the graph to ${vscode.workspace.asRelativePath(target)}.`,
      "Open",
    );
    if (choice === "Open") await vscode.commands.executeCommand("vscode.open", target);
  }

  private async action(action: GraphAction): Promise<void> {
    switch (action) {
      case "refresh":
        if (this.folder) await this.ctx.catalog.refresh(this.folder.path, { immediate: true });
        return;
      case "switchRuntime":
        await vscode.commands.executeCommand("opentide.switchRuntime");
        return;
      case "showOutput":
        this.ctx.log.show();
        return;
      case "manageTrust":
        await vscode.commands.executeCommand("workbench.trust.manage");
        return;
      case "search":
        await vscode.commands.executeCommand(
          "opentide.search.open",
          this.folder ? { folder: this.folder.path } : undefined,
        );
        return;
    }
  }

  dispose(): void {
    this.follower.dispose();
    if (this.problemsTimer) clearTimeout(this.problemsTimer);
    for (const disposable of this.disposables) disposable.dispose();
    this.opened?.dispose();
  }
}

async function folderFor(ctx: FeatureContext, path?: string): Promise<OpentideFolder | undefined> {
  if (path) return ctx.folders.all.find((folder) => folder.path === path);
  return ctx.folders.pick("Show the graph of which folder?");
}

export default defineFeature({
  id: "graph",
  activate(ctx) {
    const graph = new GraphPanel(ctx);

    const reveal = async (
      ids: readonly string[],
      folderPath?: string,
      mode?: GraphMode,
    ): Promise<GraphPanelStatus | undefined> => {
      const states = ctx.catalog.folders().map((folder) => ctx.catalog.get(folder));
      const known = folderPath ?? (ids[0] ? folderWithNode(states, ids[0]) : undefined);
      const folder = await folderFor(ctx, known);
      if (!folder) {
        if (ctx.folders.all.length === 0)
          void vscode.window.showInformationMessage(
            "Open a folder with an opentide workspace to see its graph.",
          );
        return undefined;
      }
      return graph.show(
        folder,
        ids.length > 0 ? { ids, explicit: true, ...(mode ? { mode } : {}) } : undefined,
      );
    };

    ctx.subscriptions.push(
      graph,
      vscode.commands.registerCommand("opentide.graph.open", async (args?: unknown) => {
        const parsed = parseOpenArgs(args);
        return reveal(parsed.uuids ?? [], parsed.folder, parsed.mode);
      }),
      vscode.commands.registerCommand("opentide.graph.reveal", async (args?: unknown) => {
        const uuid = parseRevealArgs(args);
        // No UUID: show the open graph as it is (and say where it is and what it is on).
        if (!uuid) return graph.revealAsIs();
        return reveal([uuid]);
      }),
      vscode.commands.registerCommand("opentide.graph.showInGraph", async (arg?: unknown) => {
        // A file (editor title and context menus, the explorer), or {uuid} / a UUID (a CodeLens).
        const uuid = arg instanceof vscode.Uri ? undefined : parseRevealArgs(arg);
        if (uuid) return reveal([uuid]);
        const target = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
        if (!target) return undefined;
        const folder = ctx.folders.folderOf(target);
        if (!folder) {
          void vscode.window.showInformationMessage("This file is not in an opentide workspace.");
          return undefined;
        }
        const state = ctx.catalog.get(folder.path);
        const id = state.catalog ? objectAtPath(state.catalog, target.fsPath, process.platform) : undefined;
        if (state.catalog && !id) {
          void vscode.window.showInformationMessage(
            "This file is not in the catalogue yet. Save it, then try again.",
          );
        }
        return graph.show(folder, id ? { ids: [id], explicit: true } : undefined, target.fsPath);
      }),
    );
  },
});
