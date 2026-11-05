// The Relations view and the relations CodeLens (SPEC §9): glue only, the model is relationsModel.ts.
// The view follows the active opentide editor (debounced, never taking focus) unless pinned, and
// reads the cached catalogue: following an editor never runs opentide.
import * as vscode from "vscode";
import {
  isMethodNotFound,
  parseServerCatalog,
  rootOf,
  SERVER_CATALOG,
} from "../../core/catalog/serverCatalog";
import type { FeatureContext } from "../../core/context";
import { debounce } from "./loader";
import type { NodeRef, TreeNode } from "./node";
import {
  explicitTarget,
  FollowGuard,
  RenderTurns,
  ServerCatalogCache,
  type ServerFetch,
} from "./relationsFlow";
import {
  graphFromCatalog,
  graphFromServer,
  History,
  lensText,
  nameLine,
  type RelationGraph,
  type RelationsOpen,
  type RelationsState,
  relationsViewModel,
  showOptions,
} from "./relationsModel";
import { NodeTree } from "./tree";

export const RELATIONS_VIEW = "opentide.sidebar.relations";
export const SHOW_RELATIONS = "opentide.relations.show";
export const CODE_LENS_SETTING = "opentide.relations.codeLens";
const FOLLOW_MS = 150;

/** What the view is about: an object by UUID, or the object a file holds (resolved per render). */
type Target =
  | { readonly folder: string; readonly uuid: string }
  | { readonly folder: string; readonly file: string };

interface Shown {
  readonly folder: string;
  readonly uuid: string;
}

const setContext = (key: string, value: unknown) =>
  void vscode.commands.executeCommand("setContext", key, value);

/** A `{uuid, folder}` argument (the CodeLens, another feature). */
function uuidArg(arg: unknown): Shown | undefined {
  if (typeof arg !== "object" || arg === null || "ref" in arg || arg instanceof vscode.Uri) return undefined;
  const { uuid, folder } = arg as { uuid?: unknown; folder?: unknown };
  return typeof uuid === "string" && typeof folder === "string" ? { uuid, folder } : undefined;
}

function refOf(arg: unknown): NodeRef | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  if ("ref" in arg) return (arg as TreeNode).ref;
  if ("kind" in arg) return arg as NodeRef;
  return undefined;
}

export class RelationsView implements vscode.Disposable {
  readonly tree = new NodeTree(RELATIONS_VIEW);
  private readonly disposables: vscode.Disposable[] = [this.tree];
  private target: Target | undefined;
  private pinned = false;
  private readonly history = new History<Shown>(
    (a, b) => a.folder === b.folder && a.uuid.toLowerCase() === b.uuid.toLowerCase(),
  );
  /** The editor group the target shows in: rows open in the group beside it. */
  private column: vscode.ViewColumn | undefined;
  /** The view does not follow the editor one of its rows opened. */
  private readonly guard = new FollowGuard();
  private readonly server = new ServerCatalogCache<unknown>();
  private readonly renders = new RenderTurns();
  private stale = false;
  private readonly lensChanged = new vscode.EventEmitter<void>();
  private readonly follow = debounce(() => this.followEditor(), FOLLOW_MS);
  private readonly renderSoon = debounce(() => void this.render(), 50);
  private readonly lensSoon = debounce(() => this.lensChanged.fire(), 300);

  constructor(private readonly ctx: FeatureContext) {
    this.disposables.push(
      this.lensChanged,
      { dispose: () => this.follow.cancel() },
      { dispose: () => this.renderSoon.cancel() },
      { dispose: () => this.lensSoon.cancel() },
    );
    this.wire();
    this.registerCommands();
    this.registerLens();
    setContext("opentide.relations.pinned", false);
    // No I/O on activation: the first render reads in-memory state on the next tick.
    const first = setTimeout(() => {
      const editor = vscode.window.activeTextEditor;
      if (editor) this.retargetFromEditor(editor);
      else void this.render();
    }, 0);
    this.disposables.push({ dispose: () => clearTimeout(first) }, { dispose: () => this.renders.dispose() });
  }

  // ── following ───────────────────────────────────────────────────────────────────────────────────────

  private wire(): void {
    const ctx = this.ctx;
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.guard.editorChanged();
        this.follow();
      }),
      ctx.catalog.onDidChange(() => {
        this.renderSoon();
        this.lensSoon();
      }),
      ctx.client.onDidChange(() => {
        this.dropServer();
        this.renderSoon();
      }),
      ctx.client.onCatalogChanged(() => {
        if (!this.server.held) return;
        this.server.drop();
        this.renderSoon();
      }),
      ctx.folders.onDidChange(() => this.renderSoon()),
      ctx.onDidChangeFiles(() => {
        // The server says when its index changed; this covers a server that has no notification.
        if (this.server.held && this.isServerSourced()) {
          this.server.drop();
          this.renderSoon();
        }
      }),
      this.tree.view.onDidChangeVisibility(({ visible }) => {
        if (visible && this.stale) void this.render();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CODE_LENS_SETTING)) this.lensChanged.fire();
      }),
    );
  }

  private followEditor(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (!this.guard.shouldFollow(editor.document.uri.fsPath)) return;
    if (this.pinned) return;
    this.retargetFromEditor(editor);
  }

  /** Retarget on the editor's object; an editor that holds none leaves the view as it is. */
  private retargetFromEditor(editor: vscode.TextEditor): boolean {
    const uri = editor.document.uri;
    if (uri.scheme !== "file") return false;
    const folder = this.ctx.folders.folderOf(uri);
    if (!folder) return false;
    if (editor.document.languageId !== "opentide-yaml" && !this.ctx.folders.isObjectFile(uri)) return false;
    this.column = editor.viewColumn;
    const current = this.target;
    if (current && "file" in current && current.file === uri.fsPath && current.folder === folder.path)
      return true;
    this.target = { folder: folder.path, file: uri.fsPath };
    void this.render();
    return true;
  }

  private retarget(target: Shown): void {
    this.target = target;
    void this.render();
  }

  // ── data ────────────────────────────────────────────────────────────────────────────────────────────

  private isServerSourced(): boolean {
    return this.ctx.folders.all.some((f) => !this.ctx.catalog.get(f.path).catalog);
  }

  private dropServer(): void {
    this.server.drop();
  }

  /** `opentide/catalog` from the running server, once per index version. */
  private fetchServer(): Promise<ServerFetch> | undefined {
    const client = this.ctx.client.current;
    if (!client) return undefined;
    const promise = this.server.get(client, () =>
      client.sendRequest(SERVER_CATALOG, {}).then(
        (value): ServerFetch => {
          const catalog = parseServerCatalog(value);
          return catalog
            ? { kind: "ok", catalog }
            : { kind: "failed", message: "opentide/catalog sent no roots" };
        },
        (error: unknown): ServerFetch => {
          if (isMethodNotFound(error)) return { kind: "unsupported" };
          return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
        },
      ),
    );
    return promise;
  }

  /** The folder's graph, or the state to show instead. */
  private async graphOf(folder: string): Promise<RelationGraph | RelationsState> {
    const state = this.ctx.catalog.get(folder);
    // A catalogue built from the server's index is read from the index itself, with what it lacks said.
    if (state.catalog && state.source !== "server") return graphFromCatalog(state.catalog, folder);
    if (state.status === "empty" || state.status === "loading") return { kind: "loading" };
    const fetched = this.fetchServer();
    if (!fetched) {
      if (state.unavailable?.reason === "untrusted") return { kind: "unavailable", reason: "untrusted" };
      return {
        kind: "unavailable",
        reason: "no-server",
        ...(state.unavailable ? { detail: state.unavailable.message } : {}),
      };
    }
    const result = await fetched;
    if (result.kind === "ok") {
      const root = rootOf(result.catalog, folder);
      if (root) return graphFromServer(root.objects, folder);
      return {
        kind: "unavailable",
        reason: "failed",
        detail: "The language server has no index of this folder.",
      };
    }
    if (result.kind === "unsupported")
      return state.unavailable?.reason === "untrusted"
        ? { kind: "unavailable", reason: "untrusted" }
        : {
            kind: "unavailable",
            reason: "needs-newer",
            detail:
              "This opentide has no `info catalog`, and its language server has no `opentide/catalog`. Switch to a newer opentide.",
          };
    return { kind: "unavailable", reason: "failed", detail: result.message };
  }

  private async resolve(): Promise<RelationsState> {
    const target = this.target;
    if (!target) return { kind: "none" };
    if (!this.ctx.folders.all.some((f) => f.path === target.folder)) return { kind: "none" };
    const graph = await this.graphOf(target.folder);
    const multi = this.ctx.folders.all.length > 1;
    const folderName = multi
      ? this.ctx.folders.all.find((f) => f.path === target.folder)?.folder.name
      : undefined;
    if ("kind" in graph) {
      if (graph.kind !== "unavailable" || !("file" in target)) return graph;
      // Say which object the view is about, by name, from the server's workspace symbols.
      const symbols = this.ctx.catalog.get(target.folder).symbols ?? [];
      const symbol = symbols.find((s) => vscode.Uri.parse(s.uri).fsPath === target.file);
      return symbol ? { ...graph, name: symbol.name, family: symbol.family, file: target.file } : graph;
    }
    const uuid = "uuid" in target ? target.uuid : graph.objectAt(target.file)?.uuid;
    if (!uuid || (!graph.object(uuid) && !graph.signal(uuid))) {
      const file = "file" in target ? target.file : undefined;
      if (!file) return { kind: "none" };
      const name = file.split(/[\\/]/).pop() ?? file;
      return { kind: "not-indexed", name, file, folder: target.folder };
    }
    return { kind: "ready", graph, uuid, ...(folderName ? { folderName } : {}) };
  }

  private async render(): Promise<void> {
    if (!this.tree.view.visible) {
      // Drawn when shown; the target is kept.
      this.stale = true;
      return;
    }
    this.stale = false;
    const { turn, navigating } = this.renders.begin();
    const state = await this.resolve();
    if (!this.renders.current(turn)) return;
    this.tree.set(relationsViewModel(state, this.pinned));
    if (state.kind === "ready" && !navigating)
      this.history.push({ folder: state.graph.folder, uuid: state.uuid });
    setContext("opentide.relations.hasTarget", state.kind === "ready");
    setContext("opentide.relations.canBack", this.history.canBack);
    setContext("opentide.relations.canForward", this.history.canForward);
  }

  // ── commands ────────────────────────────────────────────────────────────────────────────────────────

  private registerCommands(): void {
    const command = (id: string, fn: (...args: unknown[]) => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(id, fn));
    command(SHOW_RELATIONS, (arg) => this.show(arg));
    command("opentide.relations.open", (arg) => this.open(arg as RelationsOpen));
    command("opentide.relations.openToSide", (arg) => this.openToSide(arg));
    command("opentide.relations.pin", () => this.setPinned(true));
    command("opentide.relations.unpin", () => this.setPinned(false));
    command("opentide.relations.retry", () => {
      this.dropServer();
      return this.render();
    });
    command("opentide.relations.back", () => this.go(this.history.back()));
    command("opentide.relations.forward", () => this.go(this.history.forward()));
    // Integration tests read what the view shows; not contributed, and only in a test host.
    if (this.ctx.extension.extensionMode === vscode.ExtensionMode.Test)
      command("opentide.relations.testState", () => ({
        target: this.target,
        pinned: this.pinned,
        visible: this.tree.view.visible,
        labels: this.tree.nodes.map((n) => n.label),
      }));
  }

  private go(shown: Shown | undefined): void {
    if (!shown) return;
    this.renders.navigate();
    this.retarget(shown);
  }

  private setPinned(pinned: boolean): void {
    this.pinned = pinned;
    setContext("opentide.relations.pinned", pinned);
    if (!pinned) {
      const editor = vscode.window.activeTextEditor;
      if (editor && this.retargetFromEditor(editor)) return;
    }
    void this.render();
  }

  /** Show Relations: of a URI (editor title, context menu), a row, `{uuid, folder}`, or the active editor. */
  private async show(arg: unknown): Promise<void> {
    const ref = refOf(arg);
    const byUuid = uuidArg(arg);
    if (ref?.kind === "object" || ref?.kind === "signal")
      this.retarget({ folder: ref.folder, uuid: ref.uuid });
    else if (byUuid) this.retarget(byUuid);
    else {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === uri?.toString(),
      );
      if (uri && !(editor && this.retargetFromEditor(editor))) {
        const target = explicitTarget({
          path: uri.fsPath,
          scheme: uri.scheme,
          folder: this.ctx.folders.folderOf(uri)?.path,
          isObject: editor?.document.languageId === "opentide-yaml" || this.ctx.folders.isObjectFile(uri),
        });
        if (target.kind === "file") this.target = { folder: target.folder, file: target.file };
        else void vscode.window.setStatusBarMessage(`$(info) ${target.message}`, 5000);
      }
    }
    await this.reveal();
  }

  /** Show the view without taking the focus from the editor. */
  private async reveal(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!this.tree.view.visible) {
      // Opening a collapsed or hidden view takes the focus; give it back to the editor.
      await vscode.commands.executeCommand(`${RELATIONS_VIEW}.focus`);
      await this.render();
      if (editor) await vscode.window.showTextDocument(editor.document, editor.viewColumn, false);
      return;
    }
    await this.render();
    const [first] = this.tree.nodes;
    if (first) await this.tree.view.reveal(first, { select: false, focus: false, expand: false });
  }

  private async open(open: RelationsOpen | undefined): Promise<void> {
    if (!open?.file) return;
    const uri = vscode.Uri.file(open.file);
    const options = showOptions(open, this.column);
    const token = open.inPlace ? undefined : this.guard.open(uri.fsPath);
    const position = new vscode.Position(open.line, 0);
    const editor = await vscode.window.showTextDocument(uri, {
      ...options,
      viewColumn: options.viewColumn as vscode.ViewColumn,
      selection: new vscode.Range(position, position),
    });
    if (token !== undefined) this.guard.opened(token);
    if (open.signal) this.revealText(editor, open.signal);
  }

  /** Put the cursor on `text` (a signal's UUID in its objective), when the catalogue has no line. */
  private revealText(editor: vscode.TextEditor, text: string): void {
    const offset = editor.document.getText().indexOf(text);
    if (offset < 0) return;
    const position = editor.document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  /** Open to the Side: a row of any sidebar view. Relations rows open beside the followed editor. */
  private async openToSide(arg: unknown): Promise<void> {
    const node = typeof arg === "object" && arg !== null && "id" in arg ? (arg as TreeNode) : undefined;
    const ref = refOf(arg);
    if (ref?.kind !== "object") return;
    const line = node?.open?.line ?? 0;
    if (node?.id.startsWith("rel:")) return this.open({ file: ref.file, line, takeFocus: true });
    const position = new vscode.Position(line, 0);
    await vscode.window.showTextDocument(vscode.Uri.file(ref.file), {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
      preview: true,
      selection: new vscode.Range(position, position),
    });
  }

  // ── CodeLens ────────────────────────────────────────────────────────────────────────────────────────

  private registerLens(): void {
    const provider: vscode.CodeLensProvider = {
      onDidChangeCodeLenses: this.lensChanged.event,
      provideCodeLenses: (document) => {
        if (!vscode.workspace.getConfiguration().get<boolean>(CODE_LENS_SETTING, true)) return [];
        const folder = this.ctx.folders.folderOf(document.uri);
        if (!folder) return [];
        // Only from `info catalog`: the language server's own lens covers the rest, a catalogue built
        // from its index included.
        const state = this.ctx.catalog.get(folder.path);
        const catalog = state.source === "cli" ? state.catalog : undefined;
        if (!catalog) return [];
        const graph = graphFromCatalog(catalog, folder.path);
        const object = graph.objectAt(document.uri.fsPath);
        if (!object) return [];
        const line =
          nameLine(Math.min(document.lineCount, 200), (i) => document.lineAt(i).text) ?? object.line;
        const range = new vscode.Range(line, 0, line, 0);
        return [
          new vscode.CodeLens(range, {
            title: lensText(graph, object.uuid),
            tooltip: "Show Relations",
            command: SHOW_RELATIONS,
            arguments: [{ uuid: object.uuid, folder: folder.path }],
          }),
        ];
      },
    };
    this.disposables.push(
      vscode.languages.registerCodeLensProvider({ language: "opentide-yaml", scheme: "file" }, provider),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0).reverse()) disposable.dispose();
  }
}
