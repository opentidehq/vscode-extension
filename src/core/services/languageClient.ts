// One language client per window (#5): `opentide lsp start` (or `opentide-lsp --stdio`) from the runtime,
// the same command in the WASI module under @vscode/wasm-wasi (tier 4), or the engine built for WebAssembly
// in a worker thread, fed the workspace through VS Code (tier 5).
// Pulled diagnostics stay on and nothing handles `publishDiagnostics`, so each finding shows once; the
// server's refresh requests (diagnostics, semantic tokens, inlay hints, code lenses) are honoured by
// vscode-languageclient itself.
import * as fs from "node:fs";

import * as vscode from "vscode";
import type {
  ErrorHandler,
  Executable,
  LanguageClient,
  LanguageClientOptions,
  MessageTransports,
} from "vscode-languageclient/node";

import { type FeedFolder, WorkspaceFeed } from "../../engine/feed";
import { DID_CHANGE_WORKSPACE, takesWorkspaceUpdates } from "../../engine/protocol";
import { directThenHost } from "../../engine/reader";
import { EngineSync, initializationOptions, type SyncAction } from "../../engine/sync";
import type { EnginePort } from "../../engine/transport";
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
import { disposeBounded, startBounded, stopBounded } from "../lsp/bounds";
import { CrashSupervisor } from "../lsp/crashSupervisor";
import { type LspModule, loadLsp } from "../lsp/load";
import { CRASH_WINDOW_MS } from "../lsp/restartPolicy";
import { skipWorkspacePull, workspacePullSetting } from "../runtime/diagnostics";
import { processEnv } from "../runtime/env";
import { type Fallback, type ServerStart, startWithFallback } from "../runtime/fallback";
import { languageServerCommand, type Runtime } from "../runtime/types";
import { Emitter } from "../util/event";
import { SerialQueue } from "../util/serial";
import { startEngineWorker } from "./engine";
import { RecentFileEvents } from "./fileEventDedupe";
import { FirstPullGuard } from "./firstPull";
import { TraceChannel } from "./traceChannel";
import type { WasiHost, WasiLanguageServer } from "./wasi";
import { SERVER_WATCH_GLOBS } from "./watchGlobs";

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

/** One start of a server: `givenUp` once the manager has abandoned it or its time ran out. */
interface Attempt {
  givenUp: boolean;
}

export class LanguageClientManager implements LanguageClientService, vscode.Disposable {
  private client: LanguageClient | undefined;
  private info: OpentideServerInfo | undefined;
  private starting: Promise<LanguageClient | undefined> | undefined;
  private readonly emitter = new Emitter<LanguageClient | undefined>();
  private readonly outputChannel = vscode.window.createOutputChannel("opentide Language Server", {
    log: true,
  });
  // Its level follows `opentide.trace.server` (traceChannel.ts): a plain log channel left the trace empty.
  private readonly traceChannel = new TraceChannel("opentide Language Server Trace");
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * One watcher for every client this manager starts: vscode-languageclient disposes only the listeners
   * it hooks on `synchronize.fileEvents`, never the watcher, so one per start leaked a recursive watcher
   * on each restart.
   */
  private fileEvents: vscode.FileSystemWatcher[] | undefined;

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
  /** The WASI module's language server, while it runs. */
  private wasiServer: WasiLanguageServer | undefined;
  /** The crashes of the running start, and the waits before its restarts (restartPolicy.ts). */
  private supervisor: CrashSupervisor | undefined;
  /** Gives up on the start that is going (a stop or a new start was asked for), so the queue is not held by it. */
  private abandonStart: (() => void) | undefined;
  private readonly fellBack = new Emitter<void>();
  /**
   * Fires when the engine (WASM) took over from a language server that kept crashing, or could not: read
   * `fallback` and `serverRuntime` then. A start that falls back at once (`start`) does not fire it.
   */
  readonly onDidFallBack = this.fellBack.event;

  constructor(
    private readonly log: Logger,
    engineFolders: () => readonly FeedFolder[] = () => [],
    /** The engine's runtime, when the extension carries one: the fallback for a server that does not start. */
    private readonly engineRuntime: (restricted: boolean) => Runtime | undefined = () => undefined,
    /** Runs `opentide lsp start` for a WASI runtime, in the extension host. */
    private readonly wasi: WasiHost | undefined = undefined,
  ) {
    this.feed = new WorkspaceFeed(
      engineFolders,
      (message) => this.log.warn(message),
      // Desktop: a `file:` folder is read from the disk directly, not through the host's per-file round trip.
      directThenHost(
        (fsPath) => fs.promises.readFile(fsPath),
        (uri) => vscode.workspace.fs.readFile(uri),
      ),
    );
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

  /**
   * What the server reads from disk: the object files, `.opentide/configurations` and the deployment state shards
   * (watchGlobs.ts). Not the rest of `.opentide/`, which the extension's own runs write by the thousand.
   */
  private watcher(): vscode.FileSystemWatcher[] {
    if (!this.fileEvents) {
      this.fileEvents = SERVER_WATCH_GLOBS.map((glob) => vscode.workspace.createFileSystemWatcher(glob));
      this.disposables.push(...this.fileEvents);
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
    // A start still going is stale: this one replaces it. Waiting for it (it may never answer) would hold this one.
    this.abandonStart?.();
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

  /**
   * `workspace/diagnostic` answered with nothing, for a server older than the fix (diagnostics.ts) or when
   * `opentide.diagnostics.workspacePull` says never. Read at each pull, so the setting needs no restart.
   */
  private diagnosticsMiddleware(runtime: Runtime): LanguageClientOptions["middleware"] {
    let said = false;
    const recent = new RecentFileEvents();
    const firstPull = new FirstPullGuard();
    return {
      // A pull for a document can overtake its didOpen after a restart; the server answers empty and the client keeps it
      // (firstPull.ts). The guard learns from these two and asks once more after the didOpen.
      didOpen: async (document, next) => {
        await next(document);
        firstPull.opened(document.uri.toString());
      },
      didClose: async (document, next) => {
        await next(document);
        firstPull.closed(document.uri.toString());
      },
      provideDiagnostics: (document, previousResultId, token, next) =>
        firstPull.provide(
          ("uri" in document ? document.uri : document).toString(),
          async () => (await next(document, previousResultId, token)) ?? undefined,
          (report) => report?.kind === "full" && report.items.length === 0,
          async () => (await next(document, undefined, token)) ?? undefined,
          () => token.isCancellationRequested,
        ),
      // The client's own watchers and any the server registers can cover the same file: one event reaches the server.
      workspace: {
        didChangeWatchedFile: (event, next) =>
          recent.isDuplicate(event.uri, event.type) ? Promise.resolve() : next(event),
      },
      provideWorkspaceDiagnostics: (resultIds, token, reporter, next) => {
        const setting = workspacePullSetting(
          vscode.workspace.getConfiguration("opentide.diagnostics").get<string>("workspacePull"),
        );
        if (!skipWorkspacePull(setting, runtime.version)) return next(resultIds, token, reporter);
        if (!said) {
          said = true;
          this.log.info(
            `language server: not pulling the diagnostics of closed files (opentide ${runtime.version}, ` +
              `opentide.diagnostics.workspacePull ${setting}): ${
                setting === "never"
                  ? "the setting is never"
                  : "that version re-analyses every closed file on each pull; fixed in 1.0.0rc3"
              }`,
          );
        }
        return { items: [] };
      },
    };
  }

  /** Start one runtime's language server: the process's, or the engine's in a worker thread. */
  private async startServer(
    runtime: Runtime,
    cwd: string | undefined,
    reuseWorkspace: boolean,
  ): Promise<ServerStart> {
    // The package comes from dist/lsp.js, on the first start (lsp/load.ts).
    let lsp: LspModule;
    try {
      lsp = loadLsp();
    } catch (error) {
      const message = `the language client could not be loaded (${error instanceof Error ? error.message : String(error)})`;
      this.log.error(`language server failed to start: ${message}`);
      return { ok: false, error: message };
    }
    this.supervisor?.cancel();
    const supervisor = new CrashSupervisor();
    this.supervisor = supervisor;
    const started: { client?: LanguageClient } = {};
    // Set when this start is given up on: a server that comes up after that (the WASI host starts asynchronously) is ended.
    const attempt: Attempt = { givenUp: false };
    const clientOptions: LanguageClientOptions = {
      documentSelector: DOCUMENT_SELECTOR,
      errorHandler: this.errorHandler(lsp, runtime, cwd, supervisor, started),
      outputChannel: this.outputChannel,
      traceOutputChannel: this.traceChannel,
      revealOutputChannelOn: lsp.RevealOutputChannelOn.Never,
      synchronize: { fileEvents: this.watcher() },
      middleware: this.diagnosticsMiddleware(runtime),
    };
    const began = Date.now();
    const client =
      runtime.kind === "engine"
        ? await this.engineClient(runtime, clientOptions, reuseWorkspace, attempt)
        : runtime.wasi && this.wasi
          ? this.wasiClient(this.wasi, runtime, clientOptions, attempt)
          : this.processClient(runtime, cwd, clientOptions);
    started.client = client;
    const abandoned = new Promise<void>((resolve) => {
      this.abandonStart = resolve;
    });
    const result = await startBounded(client, { abandoned });
    this.abandonStart = undefined;
    if (!result.ok) {
      // No restart of a client that is being given up on: its closed connection is no crash (errorHandler).
      supervisor.cancel();
      attempt.givenUp = true;
      if (result.abandoned)
        this.log.info("language server: the start was abandoned: a stop or a new start was asked for");
      else this.log.error(`language server failed to start: ${result.error}`);
      await this.disposeClient(client);
      this.endEngine();
      this.endWasi();
      return { ok: false, error: result.error, ...(result.abandoned ? { abandoned: true } : {}) };
    }
    this.client = client;
    // A server that stops on its own (an engine trap ends its worker; a process that exits) is not
    // running: the status says so, with Restart. The client restarts it under its crash ceiling.
    client.onDidChangeState(({ newState }) => {
      if (newState === lsp.State.Stopped && this.client === client) {
        this.serverDown(client, "stopped; the client restarts it, or use opentide: Restart Server");
      } else if (newState === lsp.State.Running && this.client === client && !this.running) {
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

  /** The server is not answering: the status says so, and what changed while it was away is kept for its return. */
  private serverDown(client: LanguageClient, why: string): void {
    if (this.client !== client || !this.running) return;
    this.log.warn(`language server: ${why}`);
    this.running = false;
    this.sync.down();
    this.emitter.fire(undefined);
  }

  /**
   * The client's handler for a connection that errors or closes. `error` is vscode-languageclient's own: carry on
   * through the first three errors in a row, then shut down. `closed` replaces its restart at once and its five
   * crashes in three minutes (the server then stays dead, whatever tier it was) with a growing wait before each
   * restart (restartPolicy.ts) and, at the ceiling, the engine (WASM) in its place when the extension carries one.
   */
  private errorHandler(
    lsp: LspModule,
    runtime: Runtime,
    cwd: string | undefined,
    supervisor: CrashSupervisor,
    started: { client?: LanguageClient },
  ): ErrorHandler {
    return {
      error: (_error, _message, count) =>
        count && count <= 3 ? { action: lsp.ErrorAction.Continue } : { action: lsp.ErrorAction.Shutdown },
      closed: async () => {
        // Stopped or replaced on purpose, or a start given up on: nothing to restart, and no crash to count.
        if (supervisor.isCancelled) return { action: lsp.CloseAction.DoNotRestart, handled: true };
        const decision = supervisor.crashed();
        const minutes = CRASH_WINDOW_MS / 60_000;
        if ("giveUp" in decision) {
          const engine = runtime.kind === "engine" ? undefined : this.engineRuntime(runtime.restricted);
          const reason = `crashed ${decision.crashes} times in ${minutes} minutes`;
          this.log.error(
            `language server: ${reason}; it is not restarted` +
              (engine ? "; the opentide engine (WASM) serves the editor features instead" : ""),
          );
          if (started.client) this.serverDown(started.client, `stopped (${reason})`);
          // Not from inside this call: the client finishes handling the close before it can be stopped and replaced.
          if (engine && started.client)
            this.fallBackToEngine(started.client, { from: runtime, reason, crashed: true }, engine, cwd);
          return {
            action: lsp.CloseAction.DoNotRestart,
            message: `The ${runtime.kind === "engine" ? "opentide engine (WASM)" : "opentide language server"} ${reason}. It will not be restarted: use opentide: Restart Server.`,
            // The core says so itself when the engine takes over.
            handled: engine !== undefined,
          };
        }
        this.log.warn(
          `language server: the connection closed (crash ${decision.crashesInWindow} in ${minutes} minutes); ` +
            `restarting in ${decision.restartAfterMs / 1000} s`,
        );
        if (started.client) this.serverDown(started.client, "stopped; restarting");
        // A stop or a new start meanwhile cancels the wait: the client must not bring back a server that was dropped.
        if (!(await supervisor.wait(decision.restartAfterMs)))
          return { action: lsp.CloseAction.DoNotRestart, handled: true };
        return { action: lsp.CloseAction.Restart, handled: true };
      },
    };
  }

  /** After the ceiling: stop the crashed client and start the engine's language server in its place. */
  private fallBackToEngine(
    crashed: LanguageClient,
    fallback: Fallback,
    engine: Runtime,
    cwd: string | undefined,
  ): void {
    setTimeout(() => {
      void this.lifecycle
        .run(async () => {
          if (this.client !== crashed) return; // a start or a stop got there first
          await this.doStop();
          const started = await this.startServer(engine, cwd, false);
          if (started.ok) {
            this.lastFallback = fallback;
            this.last = { runtime: engine, cwd };
            this.emitter.fire(this.client);
          } else {
            this.log.error(
              `language server: the opentide engine (WASM) did not start either (${started.error})`,
            );
            this.emitter.fire(undefined);
          }
          this.fellBack.fire();
        })
        .catch((error: unknown) => this.log.error(`language server: falling back failed: ${String(error)}`));
    }, 0);
  }

  /**
   * Why the runtime's own language server did not start or kept crashing, when the engine (WASM) serves the
   * editor features in its place; undefined otherwise.
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
    return new (loadLsp().LanguageClient)("opentide", "opentide Language Server", executable, clientOptions);
  }

  /**
   * `opentide lsp start` in the WASI module, in the extension host: the workspace is the module's file
   * system, so the watcher's events go to the server as they do to a native one, and the transports map
   * the folders' URIs to guest URIs and back (src/core/wasi/paths.ts).
   */
  private wasiClient(
    wasi: WasiHost,
    runtime: Runtime,
    clientOptions: LanguageClientOptions,
    attempt: Attempt,
  ): LanguageClient {
    this.log.info(`language server: opentide lsp start in the WASI module (${runtime.version})`);
    const transports = async (): Promise<MessageTransports> => {
      this.endWasi();
      const server = await wasi.startLanguageServer((text) => {
        for (const line of text.split(/\r?\n/)) if (line) this.outputChannel.debug(line);
      });
      if (attempt.givenUp) {
        // The start was given up on while the module was starting: nothing waits for this server, and it must not
        // be taken for the next start's.
        server.terminate();
        throw new Error("the start was given up on");
      }
      this.wasiServer = server;
      return server.transports;
    };
    return new (loadLsp().LanguageClient)("opentide", "opentide Language Server", transports, clientOptions);
  }

  private endWasi(): void {
    this.wasiServer?.terminate();
    this.wasiServer = undefined;
  }

  /**
   * The engine (WASM) in a worker thread, given the workspace on `initialize`: it has no filesystem. The
   * watcher's events go to the feed, not the server, which could only read them from a disk it has not.
   */
  private async engineClient(
    runtime: Runtime,
    clientOptions: LanguageClientOptions,
    reuseWorkspace: boolean,
    attempt: Attempt,
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
      if (attempt.givenUp) throw new Error("the start was given up on");
      const port = startEngineWorker(runtime.command);
      engine.port = port;
      return loadLsp().engineTransports(port);
    };
    return new (loadLsp().LanguageClient)("opentide", "opentide Language Server", transports, {
      ...clientOptions,
      synchronize: {},
      // Read at each initialize, the client's own restarts included: the workspace as it stands then.
      initializationOptions: initializationOptions(() => this.feed.snapshot(), this.sync),
      middleware: {
        ...clientOptions.middleware,
        workspace: { didChangeWatchedFile: () => Promise.resolve() },
      },
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
    this.abandonStart?.();
    return this.lifecycle.run(() => this.doStop());
  }

  private async doStop(): Promise<void> {
    // A client waiting to restart has its connection closed already: let it finish handling that (it then reports
    // Stopped) before it is stopped, or the stop waits for a shutdown reply that cannot come.
    if (this.supervisor?.cancel()) await new Promise<void>((resolve) => setImmediate(resolve));
    this.supervisor = undefined;
    const client = this.client;
    this.client = undefined;
    this.running = false;
    this.sync.down();
    this.info = undefined;
    if (!client) {
      this.endEngine();
      this.endWasi();
      return;
    }
    this.emitter.fire(undefined);
    // The server's exit that `stop` brings about is expected (a WASI host may report a code of 1 for it, #99).
    this.wasiServer?.expectExit();
    // Bounded: a server that cannot answer `shutdown` must not hold every restart behind this stop. Whatever the
    // client did, the process or worker behind it is ended below.
    for (const problem of await stopBounded(client)) this.log.warn(`language server ${problem}`);
    this.endEngine();
    this.endWasi();
  }

  /** Dispose a client that did not start, within a limit; the caller ends the process or worker behind it. */
  private async disposeClient(client: LanguageClient): Promise<void> {
    for (const problem of await disposeBounded(client)) this.log.warn(`language server ${problem}`);
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
    this.fellBack.dispose();
  }
}
