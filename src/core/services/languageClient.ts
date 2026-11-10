// One language client per window (#5): `opentide lsp start` (or `opentide-lsp --stdio`) from the runtime,
// or the engine built for WebAssembly in a worker thread, fed the workspace through VS Code (tier 4).
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
  State,
} from "vscode-languageclient/node";
import { type FeedFolder, WorkspaceFeed } from "../../engine/feed";
import { DID_CHANGE_WORKSPACE, takesWorkspaceUpdates } from "../../engine/protocol";
import { EngineSync, initializationOptions, type SyncAction } from "../../engine/sync";
import { type EnginePort, engineTransports } from "../../engine/transport";
import type { WorkspaceDelta } from "../../engine/workspace";
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
import { type Fallback, type ServerStart, startWithFallback } from "../runtime/fallback";
import { languageServerCommand, type Runtime } from "../runtime/types";
import { Emitter } from "../util/event";
import { SerialQueue } from "../util/serial";
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

  /**
   * Starts and stops run one after another: a stop the core asks for while the engine starts (or
   * restarts for a file change) waits for that start, rather than tearing down a client mid-start.
   */
  private readonly lifecycle = new SerialQueue();
  private last: { runtime: Runtime | undefined; cwd: string | undefined } | undefined;
  /** The engine's worker, its workspace and whether it takes workspace updates, while it runs. */
  private engine: { port: EnginePort | undefined; updates: boolean } | undefined;
  private readonly feed: WorkspaceFeed;
  /** What changed while no engine answered, replayed once one does. */
  private readonly sync = new EngineSync();
  private engineTimer: NodeJS.Timeout | undefined;
  /** Files whose new text the engine lacks, open in an editor: the server reads the buffer until closed. */
  private readonly staleWhileOpen = new Set<string>();

  private lastFallback: Fallback | undefined;

  constructor(
    private readonly log: Logger,
    engineFolders: () => readonly FeedFolder[] = () => [],
    /** The engine's runtime, when the extension carries one: the fallback for a server that does not start. */
    private readonly engineRuntime: (restricted: boolean) => Runtime | undefined = () => undefined,
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

  /** Whether the server answers: false between an unexpected stop and the client's restart of it. */
  private running = false;

  get current(): LanguageClient | undefined {
    return this.running ? this.client : undefined;
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
    const starting = this.lifecycle.run(() => this.doStart(runtime, cwd, reuseWorkspace));
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
    await this.doStop();
    this.last = { runtime, cwd };
    this.lastFallback = undefined;
    if (!runtime) return undefined;
    const started = await startWithFallback(
      runtime,
      (server) => this.startServer(server, cwd, reuseWorkspace),
      (restricted) => this.engineRuntime(restricted),
    );
    if (started.fallback) {
      this.log.error(
        `language server: ${started.fallback.from.command} did not start (${started.fallback.reason})` +
          (started.server ? "; the opentide engine (WASM) serves the editor features instead" : ""),
      );
      if (started.server) {
        this.lastFallback = started.fallback;
        this.last = { runtime: started.server, cwd };
      }
    }
    if (!started.server) {
      this.emitter.fire(undefined);
      return undefined;
    }
    this.emitter.fire(this.client);
    return this.client;
  }

  /** Start one runtime's language server: the process's, or the engine's in a worker thread. */
  private async startServer(
    runtime: Runtime,
    cwd: string | undefined,
    reuseWorkspace: boolean,
  ): Promise<ServerStart> {
    const clientOptions: LanguageClientOptions = {
      documentSelector: DOCUMENT_SELECTOR,
      outputChannel: this.outputChannel,
      traceOutputChannel: this.traceChannel,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      synchronize: { fileEvents: this.watcher() },
    };
    const began = Date.now();
    const client =
      runtime.kind === "engine"
        ? await this.engineClient(runtime, clientOptions, reuseWorkspace)
        : this.processClient(runtime, cwd, clientOptions);
    try {
      await client.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`language server failed to start: ${message}`);
      await client.dispose().then(undefined, () => undefined);
      this.endEngine();
      return { ok: false, error: message };
    }
    this.client = client;
    // A server that stops on its own (an engine trap ends its worker; a process that exits) is not
    // running: the status says so, with Restart. The client restarts it under its crash ceiling.
    client.onDidChangeState(({ newState }) => {
      if (newState === State.Stopped && this.client === client) {
        this.log.warn("language server: stopped; the client restarts it, or use opentide: Restart Server");
        this.running = false;
        this.sync.down();
        this.emitter.fire(undefined);
      } else if (newState === State.Running && this.client === client && !this.running) {
        this.running = true;
        this.log.info("language server: running again");
        if (this.engine) void this.apply(this.sync.ready(this.engine.updates));
        this.emitter.fire(client);
      }
    });
    this.running = true;
    if (this.engine) {
      this.engine.updates = takesWorkspaceUpdates(client.initializeResult?.capabilities.experimental);
      this.log.info(
        `engine: initialized in ${Date.now() - began} ms; ` +
          (this.engine.updates
            ? "file changes are sent as opentide/didChangeWorkspace"
            : "this engine reads its workspace only on initialize: a file changed on disk restarts it"),
      );
      await this.apply(this.sync.ready(this.engine.updates));
    }
    // The client's one handler for it, for every feature; disposed with the client.
    forwardNotification(client, SERVER_CATALOG_CHANGED, (params) => this.catalogChanged.fire(params));
    this.info = readServerInfo(client.initializeResult?.capabilities.experimental);
    this.log.info(
      this.info
        ? `language server: host ${this.info.host?.name ?? "none"} ${this.info.host?.version ?? ""}, engine ${this.info.engine}, catalog ${this.info.catalog}`
        : "language server: started (it reports no capabilities.experimental.opentide)",
    );
    return { ok: true };
  }

  /**
   * Why the runtime's own language server did not start, when the engine (WASM) serves the editor
   * features in its place; undefined otherwise.
   */
  get fallback(): Fallback | undefined {
    return this.lastFallback;
  }

  /** The runtime whose language server runs (the engine after a fallback). */
  get serverRuntime(): Runtime | undefined {
    return this.client ? this.last?.runtime : undefined;
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
    if (!reuseWorkspace || !this.feed.snapshot()) {
      const { report } = await this.feed.collect();
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
      // Read at each initialize, the client's own restarts included: the workspace as it stands then.
      initializationOptions: initializationOptions(() => this.feed.snapshot(), this.sync),
      middleware: { workspace: { didChangeWatchedFile: () => Promise.resolve() } },
    });
  }

  private endEngine(): void {
    this.engine?.port?.terminate();
    this.engine = undefined;
  }

  /**
   * Object files or `.opentide/` changed on disk: the mirror takes the change at once, even while no
   * engine answers (it starts or restarts), and the engine gets it now or once it answers.
   */
  async filesChanged(uris: readonly vscode.Uri[]): Promise<void> {
    if (this.last?.runtime?.kind !== "engine") return;
    const delta = await this.feed.changed(uris);
    if (!delta) return;
    const open = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()));
    const action = this.sync.changed(delta, open);
    if (action) await this.apply([action]);
  }

  private async apply(actions: readonly SyncAction[]): Promise<void> {
    for (const action of actions) {
      if (action.kind === "notify") await this.notify(action.delta);
      else if (action.kind === "after-close") for (const uri of action.uris) this.staleWhileOpen.add(uri);
      else this.scheduleEngineRestart("object files changed on disk");
    }
  }

  private async notify(delta: WorkspaceDelta): Promise<void> {
    await this.client?.sendNotification(DID_CHANGE_WORKSPACE, delta).catch((error: unknown) => {
      this.log.warn(`engine: opentide/didChangeWorkspace: ${String(error)}`);
      this.scheduleEngineRestart("a workspace change could not be sent");
    });
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

  /** Stop the running client, after any start or stop queued before. */
  stop(): Promise<void> {
    return this.lifecycle.run(() => this.doStop());
  }

  private async doStop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.running = false;
    this.sync.down();
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
