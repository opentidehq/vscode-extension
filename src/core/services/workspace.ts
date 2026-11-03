// The window's opentide folders, `opentide-yaml` for paths.toml object folders (#4), and batched file
// events that keep `opentide serve` and the catalogue fresh.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FileChangeEvent, FolderService, OpentideFolder } from "../context";
import { isObjectFile, isOpentideFolder, objectFolders, pathsTomlFile } from "../folders";
import { Emitter } from "../util/event";

function readPathsToml(folder: string): string | undefined {
  try {
    return fs.readFileSync(pathsTomlFile(folder), "utf8");
  } catch {
    return undefined;
  }
}

export class FolderManager implements FolderService, vscode.Disposable {
  private folders: OpentideFolder[] = [];
  private readonly emitter = new Emitter<readonly OpentideFolder[]>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChange = this.emitter.event;

  constructor() {
    this.recompute(false);
    const watcher = vscode.workspace.createFileSystemWatcher("**/.opentide/configurations/paths.toml");
    const layout = vscode.workspace.createFileSystemWatcher("*/{.opentide,objects}", false, true, false);
    const rootLayout = vscode.workspace.createFileSystemWatcher("{.opentide,objects}", false, true, false);
    this.disposables.push(
      watcher,
      layout,
      rootLayout,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.recompute(true)),
      ...[watcher, layout, rootLayout].flatMap((w) => [
        w.onDidCreate(() => this.recompute(true)),
        w.onDidDelete(() => this.recompute(true)),
      ]),
      watcher.onDidChange(() => this.recompute(true)),
    );
  }

  get all(): readonly OpentideFolder[] {
    return this.folders;
  }

  private recompute(fire: boolean): void {
    const next: OpentideFolder[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") continue;
      const fsPath = folder.uri.fsPath;
      if (!isOpentideFolder(fsPath)) continue;
      next.push({ folder, path: fsPath, objectFolders: objectFolders(readPathsToml(fsPath)) });
    }
    const changed =
      JSON.stringify(next.map((f) => [f.path, f.objectFolders])) !==
      JSON.stringify(this.folders.map((f) => [f.path, f.objectFolders]));
    this.folders = next;
    void vscode.commands.executeCommand("setContext", "opentide.hasWorkspace", next.length > 0);
    if (fire && changed) this.emitter.fire(next);
  }

  folderOf(uri: vscode.Uri): OpentideFolder | undefined {
    if (uri.scheme !== "file") return undefined;
    let best: OpentideFolder | undefined;
    for (const folder of this.folders) {
      const relative = path.relative(folder.path, uri.fsPath);
      const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      if (inside && (!best || folder.path.length > best.path.length)) best = folder;
    }
    return best;
  }

  async pick(placeHolder = "Pick an opentide folder"): Promise<OpentideFolder | undefined> {
    const active = vscode.window.activeTextEditor?.document.uri;
    const fromEditor = active ? this.folderOf(active) : undefined;
    if (fromEditor) return fromEditor;
    if (this.folders.length <= 1) return this.folders[0];
    const picked = await vscode.window.showQuickPick(
      this.folders.map((folder) => ({ label: folder.folder.name, description: folder.path, folder })),
      { placeHolder },
    );
    return picked?.folder;
  }

  isObjectFile(uri: vscode.Uri): boolean {
    const folder = this.folderOf(uri);
    return folder ? isObjectFile(folder.path, uri.fsPath, folder.objectFolders) : false;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.emitter.dispose();
  }
}

/** Give YAML files in paths.toml object folders the `opentide-yaml` language, and `.opentide` TOML `opentide-config`. */
export function registerLanguageAssociation(folders: FolderManager): vscode.Disposable {
  const apply = (document: vscode.TextDocument): void => {
    if (document.uri.scheme !== "file") return;
    if (document.languageId === "yaml" && folders.isObjectFile(document.uri)) {
      void vscode.languages.setTextDocumentLanguage(document, "opentide-yaml");
    } else if (document.languageId === "toml") {
      const folder = folders.folderOf(document.uri);
      const relative = folder
        ? path.relative(folder.path, document.uri.fsPath).split(path.sep).join("/")
        : "";
      if (relative.startsWith(".opentide/configurations/")) {
        void vscode.languages.setTextDocumentLanguage(document, "opentide-config");
      }
    }
  };
  for (const document of vscode.workspace.textDocuments) apply(document);
  return vscode.Disposable.from(
    vscode.workspace.onDidOpenTextDocument(apply),
    folders.onDidChange(() => {
      for (const document of vscode.workspace.textDocuments) apply(document);
    }),
  );
}

const IGNORED = /(^|\/)\.opentide\/(exports|lsp)\//;

/**
 * Watch every opentide folder's object folders and `.opentide/`, and fire batched changes 300 ms after the
 * last event. Saves arrive through the same watcher.
 */
export class FileEvents implements vscode.Disposable {
  private readonly emitter = new Emitter<FileChangeEvent>();
  private watchers: vscode.Disposable[] = [];
  private readonly pending = new Map<string, { folder: OpentideFolder; uris: Map<string, vscode.Uri> }>();
  private timer: NodeJS.Timeout | undefined;
  private readonly subscription: vscode.Disposable;

  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly folders: FolderManager,
    private readonly debounceMs = 300,
  ) {
    this.rewatch();
    this.subscription = folders.onDidChange(() => this.rewatch());
  }

  private rewatch(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    for (const folder of this.folders.all) {
      const dirs = new Set(["objects/", ".opentide/", ...Object.values(folder.objectFolders)]);
      for (const dir of dirs) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder.folder, `${dir}**`),
        );
        const on = (uri: vscode.Uri) => this.queue(folder, uri);
        this.watchers.push(
          watcher,
          watcher.onDidCreate(on),
          watcher.onDidChange(on),
          watcher.onDidDelete(on),
        );
      }
    }
  }

  private queue(folder: OpentideFolder, uri: vscode.Uri): void {
    const relative = path.relative(folder.path, uri.fsPath).split(path.sep).join("/");
    if (IGNORED.test(relative)) return;
    let entry = this.pending.get(folder.path);
    if (!entry) {
      entry = { folder, uris: new Map() };
      this.pending.set(folder.path, entry);
    }
    entry.uris.set(uri.toString(), uri);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    this.timer = undefined;
    const batches = [...this.pending.values()];
    this.pending.clear();
    for (const { folder, uris } of batches) this.emitter.fire({ folder, uris: [...uris.values()] });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.dispose();
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
