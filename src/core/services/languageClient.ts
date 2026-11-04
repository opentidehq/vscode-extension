// One language client per window (#5): `opentide lsp start` (or `opentide-lsp --stdio`) from the runtime.
// Pulled diagnostics stay on and nothing handles `publishDiagnostics`, so each finding shows once; the
// server's refresh requests (diagnostics, semantic tokens, inlay hints, code lenses) are honoured by
// vscode-languageclient itself.
import * as vscode from "vscode";
import {
  type Executable,
  LanguageClient,
  type LanguageClientOptions,
  RevealOutputChannelOn,
} from "vscode-languageclient/node";
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

  constructor(private readonly log: Logger) {
    this.disposables.push(
      vscode.commands.registerCommand("opentide.showReferences", (...args: unknown[]) =>
        this.showReferences(args),
      ),
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
    const starting = this.doStart(runtime, cwd);
    this.starting = starting;
    void starting.finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    return starting;
  }

  private async doStart(
    runtime: Runtime | undefined,
    cwd: string | undefined,
  ): Promise<LanguageClient | undefined> {
    await this.stop();
    if (!runtime) return undefined;
    const clientOptions: LanguageClientOptions = {
      documentSelector: DOCUMENT_SELECTOR,
      outputChannel: this.outputChannel,
      traceOutputChannel: this.traceChannel,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      synchronize: { fileEvents: this.watcher() },
    };
    const executable = serverExecutable(runtime, cwd);
    const client = new LanguageClient("opentide", "opentide Language Server", executable, clientOptions);
    this.log.info(`language server: ${executable.command} ${(executable.args ?? []).join(" ")}`);
    try {
      await client.start();
    } catch (error) {
      this.log.error(
        `language server failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
      await client.dispose().then(undefined, () => undefined);
      this.emitter.fire(undefined);
      return undefined;
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

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.info = undefined;
    if (!client) return;
    this.emitter.fire(undefined);
    try {
      await client.stop(5000);
    } catch (error) {
      this.log.warn(`language server did not stop cleanly: ${String(error)}`);
    }
    await client.dispose().then(undefined, () => undefined);
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
    for (const disposable of this.disposables) disposable.dispose();
    await this.stop();
    this.outputChannel.dispose();
    this.traceChannel.dispose();
    this.emitter.dispose();
    this.catalogChanged.dispose();
  }
}
