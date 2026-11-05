// One language client per window (#5): `opentide lsp start` (or `opentide-lsp --stdio`) from the runtime,
// or the engine built for WebAssembly in a worker thread, fed the workspace through VS Code (tier 5).
// Pulled diagnostics stay on and nothing handles `publishDiagnostics`, so each finding shows once; the
// server's refresh requests (diagnostics, semantic tokens, inlay hints, code lenses) are honoured by
// vscode-languageclient itself.
import * as vscode from "vscode";
import {
  type Executable,
  LanguageClient,
  type LanguageClientOptions,
  type MessageTransports,
  RevealOutputChannelOn,
} from "vscode-languageclient/node";
import { type FeedFolder, WorkspaceFeed } from "../../engine/feed";
import { DID_CHANGE_WORKSPACE, takesWorkspaceUpdates } from "../../engine/protocol";
import { type EnginePort, engineTransports } from "../../engine/transport";
import { planDelta, type SuppliedWorkspace } from "../../engine/workspace";
import { SERVER_CATALOG_CHANGED } from "../catalog/serverCatalog";
import type { LanguageClientService, Logger, OpentideServerInfo } from "../context";
import {
  type CatalogChanged,
  convertShowReferencesArgs,
  DOCUMENT_SELECTOR,
  forwardNotification,
  readServerInfo,
} from "../lsp";
import { processEnv } from "../runtime/env";
import { languageServerCommand, type Runtime } from "../runtime/types";
import { Emitter } from "../util/event";
import { startEngineWorker } from "./engine";

/** How long after the last file change the engine is restarted with the new workspace. */
const ENGINE_RESTART_MS = 1000;

/** The `executable` server options for a runtime. */
export function serverExecutable(
  runtime: Runtime,
  cwd: string | undefined,
  platform = process.platform,
): Executable {
  const { command, args } = languageServerCommand(runtime);
  return {
    command,
    args,
    options: {
      env: processEnv(process.env, runtime, platform),
      ...(cwd ? { cwd } : {}),
    },
  };
}

export class LanguageClientManager implements LanguageClientService, vscode.Disposable {
  private client: LanguageClient | undefined;
  private info: OpentideServerInfo | undefined;
  private starting: Promise<LanguageClient | undefined> | undefined;
  private readonly emitter = new Emitter<LanguageClient | undefined>();
  private readonly outputChannel = vscode.window.createOutputChannel("opentide Language Server", {
    log: true,
  });
  private readonly traceChannel = vscode.window.createOutputChannel("opentide Language Server Trace", {
    log: true,
  });
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * One watcher for every client this manager starts: vscode-languageclient disposes only the listeners
   * it hooks on `synchronize.fileEvents`, never the watcher, so one per start leaked a recursive watcher
   * on each restart.
   */
  private fileEvents: vscode.FileSystemWatcher | undefined;

  readonly onDidChange = this.emitter.event;
  private readonly catalogChanged = new Emitter<CatalogChanged>();
  readonly onCatalogChanged = this.catalogChanged.event;

  /** Starts and stops run one after another. */
  private chain: Promise<unknown> = Promise.resolve();
  private last: { runtime: Runtime | undefined; cwd: string | undefined } | undefined;
  /** The engine's worker, its workspace and whether it takes workspace updates, while it runs. */
  private engine: { port: EnginePort | undefined; updates: boolean } | undefined;
  private readonly feed: WorkspaceFeed;
  private engineTimer: NodeJS.Timeout | undefined;
  /** Files whose new text the engine lacks, open in an editor: the server reads the buffer until closed. */
  private readonly staleWhileOpen = new Set<string>();

  constructor(
    private readonly log: Logger,
    engineFolders: () => readonly FeedFolder[] = () => [],
  ) {
    this.feed = new WorkspaceFeed(engineFolders, (message) => this.log.warn(message));
    this.disposables.push(
      vscode.commands.registerCommand("opentide.showReferences", (...args: unknown[]) =>
        this.showReferences(args),
      ),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.staleWhileOpen.delete(document.uri.toString()))
          this.scheduleEngineRestart("a file the engine had an older text of was closed");
      }),
    );
  }

  private watcher(): vscode.FileSystemWatcher {
    if (!this.fileEvents) {
      this.fileEvents = vscode.workspace.createFileSystemWatcher("**/{objects,.opentide}/**");
      this.disposables.push(this.fileEvents);
    }
    return this.fileEvents;
  }

  get current(): LanguageClient | undefined {
    return this.client;
  }

  get serverInfo(): OpentideServerInfo | undefined {
    return this.info;
  }

  ready(): Promise<LanguageClient | undefined> {
    return this.starting ?? Promise.resolve(this.client);
  }

  /** Start the window's client on `runtime` (stopping any running one first). */
  start(runtime: Runtime | undefined, cwd: string | undefined): Promise<LanguageClient | undefined> {
    return this.queue(runtime, cwd, false);
  }

  private queue(
    runtime: Runtime | undefined,
    cwd: string | undefined,
    reuseWorkspace: boolean,
  ): Promise<LanguageClient | undefined> {
    const starting = this.chain.then(() => this.doStart(runtime, cwd, reuseWorkspace));
    this.chain = starting.catch(() => undefined);
    this.starting = starting;
    void starting.finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    return starting;
  }

  private async doStart(
    runtime: Runtime | undefined,
    cwd: string | undefined,
    reuseWorkspace = false,
  ): Promise<LanguageClient | undefined> {
    await this.stop();
    this.last = { runtime, cwd };
    if (!runtime) return undefined;
    const clientOptions: LanguageClientOptions = {
      documentSelector: DOCUMENT_SELECTOR,
      outputChannel: this.outputChannel,
      traceOutputChannel: this.traceChannel,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      synchronize: { fileEvents: this.watcher() },
    };
    const started = Date.now();
    const client =
      runtime.kind === "engine"
        ? await this.engineClient(runtime, clientOptions, reuseWorkspace)
        : this.processClient(runtime, cwd, clientOptions);
    try {
      await client.start();
    } catch (error) {
      this.log.error(
        `language server failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
      await client.dispose().then(undefined, () => undefined);
      this.endEngine();
      this.emitter.fire(undefined);
      return undefined;
    }
    if (this.engine) {
      this.engine.updates = takesWorkspaceUpdates(client.initializeResult?.capabilities.experimental);
      this.log.info(
        `engine: initialized in ${Date.now() - started} ms; ` +
          (this.engine.updates
            ? "file changes are sent as opentide/didChangeWorkspace"
            : "this engine reads its workspace only on initialize: a file changed on disk restarts it"),
      );
    }
    this.client = client;
    // The client's one handler for it, for every feature; disposed with the client.
    forwardNotification(client, SERVER_CATALOG_CHANGED, (params) => this.catalogChanged.fire(params));
    this.info = readServerInfo(client.initializeResult?.capabilities.experimental);
    this.log.info(
      this.info
        ? `language server: host ${this.info.host?.name ?? "none"} ${this.info.host?.version ?? ""}, engine ${this.info.engine}, catalog ${this.info.catalog}`
        : "language server: started (it reports no capabilities.experimental.opentide)",
    );
    this.emitter.fire(client);
    return client;
  }

  private processClient(
    runtime: Runtime,
    cwd: string | undefined,
    clientOptions: LanguageClientOptions,
  ): LanguageClient {
    const executable = serverExecutable(runtime, cwd);
    this.log.info(`language server: ${executable.command} ${(executable.args ?? []).join(" ")}`);
    return new LanguageClient("opentide", "opentide Language Server", executable, clientOptions);
  }

  /**
   * The engine (WASM) in a worker thread, given the workspace on `initialize`: it has no filesystem. The
   * watcher's events go to the feed, not the server, which could only read them from a disk it has not.
   */
  private async engineClient(
    runtime: Runtime,
    clientOptions: LanguageClientOptions,
    reuseWorkspace: boolean,
  ): Promise<LanguageClient> {
    let workspace: SuppliedWorkspace | undefined = reuseWorkspace ? this.feed.snapshot() : undefined;
    if (!workspace) {
      const { workspace: collected, report } = await this.feed.collect();
      workspace = collected;
      this.log.info(
        `engine: read ${report.files} object file(s), ${Math.round(report.bytes / 1024)} KiB, in ${report.ms} ms` +
          (report.skipped.length > 0 ? `; left out ${report.skipped.length}` : ""),
      );
    }
    const engine: { port: EnginePort | undefined; updates: boolean } = { port: undefined, updates: false };
    this.engine = engine;
    this.log.info(`language server: ${runtime.command} in a worker thread (engine ${runtime.version})`);
    const transports = async (): Promise<MessageTransports> => {
      const port = startEngineWorker(runtime.command);
      engine.port = port;
      return engineTransports(port);
    };
    return new LanguageClient("opentide", "opentide Language Server", transports, {
      ...clientOptions,
      synchronize: {},
      initializationOptions: { workspace },
      middleware: { workspace: { didChangeWatchedFile: () => Promise.resolve() } },
    });
  }

  private endEngine(): void {
    this.engine?.port?.terminate();
    this.engine = undefined;
  }

  /** Object files or `.opentide/` changed on disk: give the engine the new workspace. */
  async filesChanged(uris: readonly vscode.Uri[]): Promise<void> {
    const engine = this.engine;
    const client = this.client;
    if (!engine || !client) return;
    const delta = await this.feed.changed(uris);
    if (!delta) return;
    const open = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()));
    const plan = planDelta(delta, engine.updates, open);
    if (plan.kind === "notify") await client.sendNotification(DID_CHANGE_WORKSPACE, delta);
    else if (plan.kind === "after-close") for (const uri of plan.uris) this.staleWhileOpen.add(uri);
    else this.scheduleEngineRestart("object files changed on disk");
  }

  private scheduleEngineRestart(reason: string): void {
    if (this.engineTimer) clearTimeout(this.engineTimer);
    this.engineTimer = setTimeout(() => {
      this.engineTimer = undefined;
      const last = this.last;
      if (!this.engine || last?.runtime?.kind !== "engine") return;
      this.log.info(`engine: restarting with the new workspace (${reason})`);
      this.staleWhileOpen.clear();
      void this.queue(last.runtime, last.cwd, true);
    }, ENGINE_RESTART_MS);
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.info = undefined;
    if (!client) {
      this.endEngine();
      return;
    }
    this.emitter.fire(undefined);
    try {
      await client.stop(5000);
    } catch (error) {
      this.log.warn(`language server did not stop cleanly: ${String(error)}`);
    }
    await client.dispose().then(undefined, () => undefined);
    this.endEngine();
  }

  private async showReferences(args: unknown[]): Promise<void> {
    const client = this.client;
    if (!client) return;
    const converted = convertShowReferencesArgs(args, {
      asUri: (value) => client.protocol2CodeConverter.asUri(value),
      asPosition: (value) => client.protocol2CodeConverter.asPosition(value),
      asLocation: (value) => client.protocol2CodeConverter.asLocation(value),
    });
    if (!converted) {
      this.log.warn(`opentide.showReferences: unexpected arguments ${JSON.stringify(args).slice(0, 200)}`);
      return;
    }
    await vscode.commands.executeCommand("editor.action.showReferences", ...converted);
  }

  async dispose(): Promise<void> {
    if (this.engineTimer) clearTimeout(this.engineTimer);
    for (const disposable of this.disposables) disposable.dispose();
    await this.stop();
    this.outputChannel.dispose();
    this.traceChannel.dispose();
    this.emitter.dispose();
    this.catalogChanged.dispose();
  }
}
