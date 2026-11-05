// The engine (WASM) session of the web extension: vscode.dev, github.dev, VS Code for the Web, and a
// desktop virtual workspace (Remote Repositories). It finds the opentide folders through VS Code's file
// system (any scheme: `vscode-vfs:`, `vscode-test-web:`), feeds the engine their object files, starts the
// language client on it, and keeps the workspace current. The bundle's entry hands in how to start the
// worker and the client: a Web Worker and vscode-languageclient/browser in the browser, a worker thread
// and the node client on the desktop. No Node built-ins.
import * as vscode from "vscode";
import type { BaseLanguageClient, LanguageClientOptions, MessageTransports } from "vscode-languageclient";
import {
  parseServerCatalog,
  SERVER_CATALOG,
  SERVER_CATALOG_CHANGED,
  type ServerObject,
} from "../engine/catalog";
import { type FeedFolder, relativeTo, WorkspaceFeed } from "../engine/feed";
import { WEB_DOCUMENT_SELECTOR } from "../engine/languages";
import { convertShowReferencesArgs } from "../engine/lsp";
import { objectFolders } from "../engine/pathsToml";
import { DID_CHANGE_WORKSPACE, takesWorkspaceUpdates } from "../engine/protocol";
import { type EnginePort, engineTransports } from "../engine/transport";
import { isSuppliedPath, objectRoots, planDelta } from "../engine/workspace";

/** What the entry provides: the worker, and the client for this extension host. */
export interface EngineHost {
  /** Start a worker serving the engine. */
  startEngine(): EnginePort;
  createClient(
    serverOptions: () => Promise<MessageTransports>,
    clientOptions: LanguageClientOptions,
  ): BaseLanguageClient;
}

/** The events the session fires for the views. */
type Listener = () => void;

const RESTART_MS = 1000;
const BATCH_MS = 300;

/** Whether a folder is an opentide repository: it has `.opentide/` or `objects/`. */
async function isOpentideFolder(folder: vscode.Uri): Promise<boolean> {
  for (const name of [".opentide", "objects"]) {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, name));
      if (stat.type & vscode.FileType.Directory) return true;
    } catch {
      // not there
    }
  }
  return false;
}

async function readPathsToml(folder: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(folder, ".opentide", "configurations", "paths.toml"),
    );
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return undefined;
  }
}

/** The workspace's opentide folders, with their paths.toml object folders. */
export async function findFolders(): Promise<FeedFolder[]> {
  const folders: FeedFolder[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (!(await isOpentideFolder(folder.uri))) continue;
    folders.push({ uri: folder.uri, objectFolders: objectFolders(await readPathsToml(folder.uri)) });
  }
  return folders;
}

export class EngineSession implements vscode.Disposable {
  private client: BaseLanguageClient | undefined;
  private port: EnginePort | undefined;
  private updates = false;
  private folders: FeedFolder[] = [];
  private readonly feed = new WorkspaceFeed(
    () => this.folders,
    (message) => this.output.warn(message),
  );
  private watchers: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly listeners = new Set<Listener>();
  private pending = new Map<string, vscode.Uri>();
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly staleWhileOpen = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private catalogCache: Promise<readonly ServerObject[]> | undefined;
  readonly output: vscode.LogOutputChannel;

  constructor(private readonly host: EngineHost) {
    this.output = vscode.window.createOutputChannel("opentide Language Server", { log: true });
    this.disposables.push(
      this.output,
      vscode.commands.registerCommand("opentide.showReferences", (...args: unknown[]) =>
        this.showReferences(args),
      ),
      vscode.workspace.onDidChangeWorkspaceFolders(
        () => void this.restart("workspace folders changed", false),
      ),
      vscode.workspace.onDidOpenTextDocument((document) => this.associate(document)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.staleWhileOpen.delete(document.uri.toString()))
          this.scheduleRestart("a file the engine had an older text of was closed");
      }),
    );
  }

  /**
   * Give YAML in a paths.toml object folder the `opentide-yaml` language, as the desktop core does: the
   * manifest's pattern only knows `objects/`.
   */
  private associate(document: vscode.TextDocument): void {
    if (document.languageId !== "yaml") return;
    for (const folder of this.folders) {
      const relative = relativeTo(folder.uri, document.uri);
      if (relative === undefined) continue;
      if (isSuppliedPath(relative, folder.objectFolders))
        void vscode.languages.setTextDocumentLanguage(document, "opentide-yaml");
      return;
    }
  }

  get current(): BaseLanguageClient | undefined {
    return this.client;
  }

  get hasWorkspace(): boolean {
    return this.folders.length > 0;
  }

  /** The views listen: the client started or stopped, or the index changed. */
  onDidChange(listener: Listener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private fire(): void {
    this.catalogCache = undefined;
    for (const listener of this.listeners) listener();
  }

  /** Start, or start again (`reuse`: the workspace the feed already has). Calls run one after another. */
  restart(reason: string, reuse: boolean): Promise<void> {
    const run = this.chain.then(() => this.doStart(reason, reuse));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doStart(reason: string, reuse: boolean): Promise<void> {
    this.output.info(`engine: start (${reason})`);
    await this.stop();
    const started = Date.now();
    if (!reuse) {
      this.folders = await findFolders();
      this.watch();
      for (const document of vscode.workspace.textDocuments) this.associate(document);
    }
    void vscode.commands.executeCommand("setContext", "opentide.hasWorkspace", this.folders.length > 0);
    let workspace = reuse ? this.feed.snapshot() : undefined;
    if (!workspace) {
      const { workspace: collected, report } = await this.feed.collect();
      workspace = collected;
      this.output.info(
        `engine: read ${report.files} object file(s) of ${this.folders.length} folder(s), ` +
          `${Math.round(report.bytes / 1024)} KiB, in ${report.ms} ms`,
      );
    }
    const client = this.host.createClient(
      async () => {
        this.port = this.host.startEngine();
        return engineTransports(this.port);
      },
      {
        documentSelector: WEB_DOCUMENT_SELECTOR,
        outputChannel: this.output,
        initializationOptions: { workspace },
        // The engine has no files to read again: the session feeds it instead.
        middleware: { workspace: { didChangeWatchedFile: () => Promise.resolve() } },
      },
    );
    try {
      await client.start();
    } catch (error) {
      this.output.error(`engine: did not start: ${error instanceof Error ? error.message : String(error)}`);
      this.port?.terminate();
      this.port = undefined;
      this.fire();
      return;
    }
    this.client = client;
    this.updates = takesWorkspaceUpdates(client.initializeResult?.capabilities.experimental);
    client.onNotification(SERVER_CATALOG_CHANGED, () => this.fire());
    this.output.info(`engine: initialized in ${Date.now() - started} ms`);
    this.fire();
  }

  /** Watch each folder's object folders and `.opentide/`, batched. */
  private watch(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    for (const folder of this.folders) {
      for (const root of new Set([...objectRoots(folder.objectFolders), ".opentide/"])) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder.uri, `${root}**`),
        );
        const queue = (uri: vscode.Uri) => this.queue(uri);
        this.watchers.push(
          watcher,
          watcher.onDidCreate(queue),
          watcher.onDidChange(queue),
          watcher.onDidDelete(queue),
        );
      }
    }
  }

  private queue(uri: vscode.Uri): void {
    this.pending.set(uri.toString(), uri);
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => void this.flush(), BATCH_MS);
  }

  private async flush(): Promise<void> {
    this.batchTimer = undefined;
    const uris = [...this.pending.values()];
    this.pending = new Map();
    if (uris.some((uri) => uri.path.endsWith("/.opentide/configurations/paths.toml"))) {
      await this.restart("paths.toml changed", false);
      return;
    }
    const client = this.client;
    if (!client) return;
    const delta = await this.feed.changed(uris);
    if (!delta) return;
    const open = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()));
    const plan = planDelta(delta, this.updates, open);
    if (plan.kind === "notify") await client.sendNotification(DID_CHANGE_WORKSPACE, delta);
    else if (plan.kind === "after-close") for (const uri of plan.uris) this.staleWhileOpen.add(uri);
    else this.scheduleRestart("object files changed");
  }

  private scheduleRestart(reason: string): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.staleWhileOpen.clear();
      void this.restart(reason, true);
    }, RESTART_MS);
  }

  /** Every object of the index (each root's), once per index version. */
  catalog(): Promise<readonly ServerObject[]> {
    const client = this.client;
    if (!client) return Promise.resolve([]);
    this.catalogCache ??= client.sendRequest(SERVER_CATALOG, {}).then(
      (value) => parseServerCatalog(value)?.roots.flatMap((root) => root.objects) ?? [],
      (error: unknown) => {
        this.output.warn(`opentide/catalog: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      },
    );
    return this.catalogCache;
  }

  private async showReferences(args: unknown[]): Promise<void> {
    const client = this.client;
    if (!client) return;
    const converted = convertShowReferencesArgs(args, {
      asUri: (value) => client.protocol2CodeConverter.asUri(value),
      asPosition: (value) => client.protocol2CodeConverter.asPosition(value),
      asLocation: (value) => client.protocol2CodeConverter.asLocation(value),
    });
    if (converted) await vscode.commands.executeCommand("editor.action.showReferences", ...converted);
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      this.fire();
      await client.stop(5000).catch(() => undefined);
      await client.dispose().catch(() => undefined);
    }
    this.port?.terminate();
    this.port = undefined;
  }

  dispose(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const disposable of [...this.watchers, ...this.disposables]) disposable.dispose();
    void this.stop();
  }
}
