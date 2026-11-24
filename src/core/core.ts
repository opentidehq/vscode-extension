// Creates and wires the core services, registers the core commands, and builds the FeatureContext.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { ActivityLog } from "./activity";
import { Backend } from "./backend/backend";
import { spawnRun } from "./backend/spawn";
import { Capabilities, type CommandsCache } from "./capabilities/capabilities";
import { parseServerCatalog, rootOf, SERVER_CATALOG, serverCatalogDocument } from "./catalog/serverCatalog";
import { CatalogStore, INFO_CATALOG } from "./catalog/store";
import { folderSymbols, type WorkspaceSymbol } from "./catalog/symbols";
import type { FeatureContext, Logger, StatusMenuItem, TrustService } from "./context";
import { CredentialStore } from "./credentials";
import { hasOpentideContent } from "./dormant";
import { loadEnvFile } from "./envfile";
import { cliRange, codePointColumnToUtf16 } from "./positions";
import { processEnv } from "./runtime/env";
import { describeFallback, fallbackAttempts } from "./runtime/fallback";
import { usePinnedVersion } from "./runtime/pinned";
import { which } from "./runtime/process";
import { isBundled, shouldRecheck, VENV_GLOB, VENV_SETTLE_MS } from "./runtime/recheck";
import { engineRuntime, uvExecutable } from "./runtime/resolve";
import { cliCommand, describeRuntime, ENGINE_LABEL, isEditorOnly } from "./runtime/types";
import { execStep, runSteps, venvSteps } from "./runtime/venv";
import { LanguageClientManager } from "./services/languageClient";
import { createLogger } from "./services/logger";
import { onDidChangePythonEnvironment } from "./services/python";
import { RuntimeManager, readEngine } from "./services/runtime";
import { httpProxy, RESTART_SETTINGS, readRestricted, readSetting } from "./services/settings";
import { StatusManager } from "./services/status";
import { WASI_INITIALIZE_PARAMS, WasiHost } from "./services/wasi";
import { FileEvents, FolderManager, registerLanguageAssociation } from "./services/workspace";
import { runShutdown, type ShutdownResult } from "./shutdown";
import { menuSections, problemsText } from "./statusText";
import { editorOnlyText, INSTALL_URL } from "./unavailable";
import { Emitter } from "./util/event";
import { serialized } from "./util/serial";
import type { WasiHostKind } from "./wasi/hostChoice";
import { createWebviewHelpers } from "./webview/panel";

export interface Core {
  readonly ctx: FeatureContext;
  /** The host the bundled opentide last started on (launcher or @vscode/wasm-wasi); for the tests. */
  readonly wasiHost: () => WasiHostKind | undefined;
  /** Resolve the runtime and start the language server, in the background. */
  start(): Promise<void>;
  /**
   * End every process the extension started and wait until they are gone, within `deadlineMs` (VS Code gives
   * `deactivate` about five seconds). Safe to call twice; what `context.subscriptions` disposes afterwards finds
   * nothing left to do.
   */
  shutdown(deadlineMs?: number): Promise<ShutdownResult>;
}

/** The commands cache: one file per opentide version under globalStorage/commands/. */
function commandsCache(storage: vscode.Uri): CommandsCache {
  const dir = path.join(storage.fsPath, "commands");
  const file = (version: string) => path.join(dir, `${version.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  return {
    async read(version) {
      try {
        return JSON.parse(await fs.promises.readFile(file(version), "utf8"));
      } catch {
        return undefined;
      }
    },
    async write(version, document) {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(file(version), JSON.stringify(document));
    },
  };
}

/** What was last said about each env file, so a problem is logged once, not on every command. */
const envFileWarnings = new Map<string, string>();

/** `opentide.envFile` variables for a folder (trusted only). Skipped lines and a missing file are logged. */
function envFileVariables(folder: string, log: Logger): Record<string, string> {
  const setting = readRestricted<string>("opentide.envFile", vscode.Uri.file(folder));
  if (!setting?.trim()) return {};
  const file = path.isAbsolute(setting) ? setting : path.join(folder, setting);
  let said = "";
  const variables = loadEnvFile(file, (message) => {
    said = message;
  });
  if (said && envFileWarnings.get(file) !== said) log.warn(said);
  envFileWarnings.set(file, said);
  return variables;
}

export function createCore(context: vscode.ExtensionContext): Core {
  const log = createLogger();
  const subscriptions = context.subscriptions;
  subscriptions.push(log);

  const folders = new FolderManager();
  const fileEvents = new FileEvents(folders);
  subscriptions.push(folders, fileEvents, registerLanguageAssociation(folders));

  const primaryFolder = () => folders.all[0]?.folder ?? vscode.workspace.workspaceFolders?.[0];
  const runtime = new RuntimeManager(context, log, primaryFolder);
  subscriptions.push(runtime);

  const capabilities = new Capabilities({
    cache: commandsCache(context.globalStorageUri),
    log: (level, message) => log[level](message),
    fetch: async (rt) => {
      const { command, args } = cliCommand(rt, ["--json", "commands"]);
      const result = await spawnRun({
        command,
        args,
        commandName: "commands",
        env: processEnv(process.env, rt, process.platform, { NO_COLOR: "1" }),
        cwd: primaryFolder()?.uri.fsPath,
        platform: process.platform,
      });
      return result.document;
    },
  });
  subscriptions.push(capabilities);

  const credentials = new CredentialStore(context.secrets);
  subscriptions.push(credentials);

  // The WASI module (tier 4) runs `serve` and the language server here, under @vscode/wasm-wasi. What it is
  // given of the environment: its own settings and the proxy (src/core/wasi/env.ts).
  const wasiHost = new WasiHost(
    context,
    () => runtime.current,
    () => {
      const proxy = httpProxy();
      return { ...process.env, ...(proxy ? { OPENTIDE_PROXY: proxy } : {}) };
    },
    log,
  );
  subscriptions.push(wasiHost);

  const backend = new Backend({
    runtime: () => runtime.current,
    commands: () => capabilities.ready(),
    classify: (argv) => capabilities.classify(argv),
    serveMode: () => (readSetting<string>("opentide.backend.serve") === "never" ? "never" : "auto"),
    baseEnv: () => process.env,
    proxy: () => httpProxy(),
    credentials: async (folder) => ({ ...envFileVariables(folder, log), ...(await credentials.env(folder)) }),
    platform: process.platform,
    log: (level, message) => log[level](message),
    wasi: { start: () => wasiHost.startServe(), initializeParams: WASI_INITIALIZE_PARAMS },
    notify: (message) =>
      void vscode.window.showWarningMessage(message, "Restart Server", "Show Output").then((choice) => {
        if (choice === "Restart Server") void vscode.commands.executeCommand("opentide.restartServer");
        else if (choice) log.show();
      }),
  });
  subscriptions.push({ dispose: () => void backend.dispose() });

  const activity = new ActivityLog();
  subscriptions.push(
    activity,
    backend.onDidRun((run) => activity.record(run)),
  );

  // The engine (WASM) has no filesystem: it is given each opentide folder's object files.
  // It is also the language server of a runtime whose own does not start (fallback.ts).
  const client = new LanguageClientManager(
    log,
    () => folders.all.map((folder) => ({ uri: folder.folder.uri, objectFolders: folder.objectFolders })),
    (restricted) => {
      const engine = readEngine(context.extensionPath, (problem) => log.warn(`engine: ${problem}`));
      return engine ? engineRuntime(engine, restricted) : undefined;
    },
    wasiHost,
  );
  subscriptions.push({ dispose: () => void client.dispose() });

  const catalog = new CatalogStore({
    availability: () => backend.availability(),
    hasInfoCatalog: async () => (await capabilities.ready())?.hasCommand(INFO_CATALOG) ?? false,
    runCatalog: async (folder) => {
      const result = await backend.run(folder, ["info", "catalog"]);
      return { document: result.document, exitCode: result.exitCode };
    },
    symbols: async (folder) => {
      const lc = client.current;
      if (!lc) return undefined;
      const symbols = (await lc.sendRequest("workspace/symbol", { query: "" })) as WorkspaceSymbol[] | null;
      return folderSymbols(symbols, folder, process.platform, (file) => vscode.Uri.file(file).toString());
    },
    // An editor-only runtime (the engine, opentide-lsp) has no `info catalog`: its server's index stands in.
    serverCatalog: async (folder) => {
      const lc = await client.ready();
      if (!lc) return undefined;
      const catalog = parseServerCatalog(await lc.sendRequest(SERVER_CATALOG, {}));
      const root = catalog ? rootOf(catalog, folder) : undefined;
      return root ? serverCatalogDocument(root, folder) : undefined;
    },
    unavailableMessage: (reason) =>
      reason === "editor-only"
        ? editorOnlyText(runtime.current, "the full catalogue (platforms, techniques, deployment)")
        : undefined,
    log: (level, message) => log[level](message),
  });
  subscriptions.push(catalog);

  const status = new StatusManager();
  subscriptions.push(status);

  const grant = new Emitter<void>();
  const trust: TrustService = {
    get isTrusted() {
      return vscode.workspace.isTrusted;
    },
    onDidGrant: grant.event,
  };
  subscriptions.push(grant);
  void vscode.commands.executeCommand("setContext", "opentide.trusted", vscode.workspace.isTrusted);

  // After a language server start, and after the engine took over from one that kept crashing: say so, once.
  const announceServer = (): void => {
    const fallback = client.fallback;
    const server = client.serverRuntime;
    if (fallback && server) {
      runtime.noteAttempts(fallbackAttempts(fallback, server));
      void vscode.window
        .showWarningMessage(
          `The language server of opentide ${fallback.from.version} ${describeFallback(fallback)}. The opentide engine (WASM) gives the editor features instead.`,
          "Show Output",
        )
        .then((choice) => {
          if (choice) log.show();
        });
    }
    status.setFallback(fallback);
    status.setServer(client.serverInfo, client.current !== undefined);
    catalog.refreshAll({ immediate: true });
  };
  subscriptions.push(client.onDidFallBack(announceServer));

  // A marker before and after each wait of a restart: one that hangs names the step it is in (the log's last line).
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    log.info(`restart: ${name}…`);
    const began = Date.now();
    try {
      const result = await work();
      log.info(`restart: ${name} done (${Date.now() - began} ms)`);
      return result;
    } catch (error) {
      log.info(`restart: ${name} failed after ${Date.now() - began} ms`);
      throw error;
    }
  };

  // Restarts run one at a time; a restart asked for during one runs once more afterwards, and its
  // caller waits for that run, not the one it arrived during.
  const doRestart = async (reason: string): Promise<void> => {
    log.info(`restart: ${reason}`);
    status.update({ runtime: runtime.current, resolving: true, pin: runtime.pin, trusted: trust.isTrusted });
    await step("stopping the language server", () => client.stop());
    await step("stopping opentide serve", () => backend.restart());
    // Which host runs the module is asked again: the WASM WASI Core extension may have been installed.
    wasiHost.reset();
    // From scratch, now: a resolution still running (a stale uv probe) is cancelled, not waited for. The one at
    // activation is the exception: a feature that asked for the runtime a moment ago started a resolution with
    // the same inputs, and a second one would log the same line twice.
    const rt = await step("resolving the runtime", () =>
      reason === "activation" ? runtime.ready() : runtime.resolveAgain(),
    );
    void capabilities.load(rt);
    status.update({ runtime: rt, resolving: false, pin: runtime.pin, trusted: trust.isTrusted });
    const cwd = trust.isTrusted ? primaryFolder()?.uri.fsPath : context.globalStorageUri.fsPath;
    if (!trust.isTrusted)
      await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true }).catch(() => undefined);
    await step("starting the language server", () => client.start(rt, cwd));
    announceServer();
  };
  const restart = serialized((reason) =>
    doRestart(reason).catch((error: unknown) => log.error(`restart failed: ${String(error)}`)),
  );
  runtime.restartHandler = restart;

  let lastPrimary = folders.all[0]?.path;

  // Keep the serve digest per version: a different digest for the same version re-reads the commands.
  const digests = new Map<string, string>();
  subscriptions.push(
    backend.onDidChangeServe(({ running, version, digest }) => {
      if (!running || !version || !digest) return;
      const known = digests.get(version);
      digests.set(version, digest);
      if (known && known !== digest) void capabilities.refresh();
    }),
    backend.onDidRun((run) => {
      if (run.status !== "running" && run.classification.writes && catalog.folders().includes(run.folder)) {
        void catalog.refresh(run.folder);
      }
    }),
    // A save reaches serve at once: the watcher's batch comes 300 ms after its event, and a feature's
    // run after the save would otherwise read serve's snapshot of the file from before it.
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme === "file" && folders.folderOf(document.uri))
        backend.invalidate([document.uri.fsPath]);
    }),
    fileEvents.onDidChange(({ folder, uris }) => {
      // The engine's, also when it serves a runtime whose own server did not start.
      void client.filesChanged(uris);
      backend.invalidate(uris.map((uri) => uri.fsPath));
      if (catalog.folders().includes(folder.path)) void catalog.refresh(folder.path);
    }),
    folders.onDidChange((all) => {
      // A removed folder's catalogue goes, so a restart's refreshAll does not run `info catalog` there.
      catalog.retain(all.map((folder) => folder.path));
      // A new primary folder changes the runtime; a paths.toml edit only changes object folders, which
      // the engine (WASM) is given as files: it reads them again (a fresh read, not the mirror).
      const primary = all[0]?.path;
      if (primary !== lastPrimary) {
        lastPrimary = primary;
        void restart("workspace folders changed");
      } else if (runtime.current?.kind === "engine") {
        void restart("opentide folders changed: the engine reads them again");
      } else if (runtime.current?.wasi) {
        // The module's file system is the window's folders as they were when it started.
        void restart("workspace folders changed: the WASI module is mounted on them again");
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (RESTART_SETTINGS.some((key) => event.affectsConfiguration(key))) void restart("settings changed");
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      await restart("workspace trusted");
      grant.fire();
    }),
    client.onDidChange((started) => {
      status.setServer(client.serverInfo, client.current !== undefined);
      // The catalogue of an editor-only runtime is the server's index: read it from the new server.
      if (started && isEditorOnly(runtime.current)) catalog.refreshAll({ immediate: true });
    }),
    client.onCatalogChanged(() => {
      if (isEditorOnly(runtime.current)) catalog.refreshAll();
    }),
    // The capability context keys ARCHITECTURE.md documents, for `when` clauses.
    capabilities.onDidChange(
      (tree) =>
        void vscode.commands.executeCommand(
          "setContext",
          "opentide.hasInfoCatalog",
          tree?.hasCommand(INFO_CATALOG) ?? false,
        ),
    ),
    backend.onDidChangeServe(({ running }) => {
      status.setServe(running);
      void vscode.commands.executeCommand("setContext", "opentide.serveRunning", running);
    }),
    runtime.onDidChange(
      () => void vscode.commands.executeCommand("setContext", "opentide.trusted", trust.isTrusted),
    ),
  );
  // On the WASI and engine tiers: an opentide that appears later replaces it without a Restart Server.
  let lastRecheck: number | undefined;
  const recheck = async (reason: string, force: boolean): Promise<void> => {
    const now = Date.now();
    if (!force && !shouldRecheck(runtime.current, lastRecheck, now)) return;
    if (!isBundled(runtime.current)) return;
    lastRecheck = now;
    const attempts = runtime.attempts;
    const rt = await runtime.resolveAgain();
    // A user's own opentide (tiers 1-3) replaces what the extension carries; anything else changes nothing.
    if (rt && rt.tier <= 3) await restart(reason);
    else if (JSON.stringify(attempts) !== JSON.stringify(runtime.attempts))
      log.debug(`runtime: looked again (${reason}); still ${rt ? describeRuntime(rt) : "no runtime"}`);
  };
  // Anything created under a .venv, a second after the last: a file made right after its new folder
  // can slip past a recursive watcher, and an install creates thousands at once.
  const venvWatcher = vscode.workspace.createFileSystemWatcher(`**/${VENV_GLOB}`, false, true, true);
  let venvTimer: NodeJS.Timeout | undefined;
  subscriptions.push(
    venvWatcher,
    venvWatcher.onDidCreate(() => {
      if (!isBundled(runtime.current)) return;
      if (venvTimer) clearTimeout(venvTimer);
      venvTimer = setTimeout(() => void recheck("something appeared in a .venv", true), VENV_SETTLE_MS);
    }),
    { dispose: () => venvTimer && clearTimeout(venvTimer) },
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) void recheck("the window got the focus back", false);
    }),
  );
  void onDidChangePythonEnvironment(() => {
    if (trust.isTrusted && runtime.current && runtime.current.tier >= 2)
      void restart("Python environment changed");
  }).then((disposable) => subscriptions.push(disposable));

  const ctx: FeatureContext = {
    extension: context,
    subscriptions,
    log,
    runtime,
    backend,
    capabilities,
    client,
    catalog,
    activity,
    credentials,
    trust,
    folders,
    status,
    positions: {
      toPosition: (document, line1, column1) => {
        const line = Math.min(Math.max(0, line1 - 1), Math.max(0, document.lineCount - 1));
        const text = document.lineCount > 0 ? document.lineAt(line).text : "";
        return new vscode.Position(line, column1 == null ? 0 : codePointColumnToUtf16(text, column1));
      },
      toRange: (document, span) => {
        const range = cliRange(
          { lineCount: document.lineCount, lineText: (line) => document.lineAt(line).text },
          span,
        );
        return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
      },
    },
    webview: createWebviewHelpers(context.extensionUri, (message) => log.warn(message)),
    onDidChangeFiles: fileEvents.onDidChange,
  };

  registerCoreCommands(ctx, status, runtime);

  // A window with no opentide content (the extension activates everywhere on `onStartupFinished`) starts no runtime
  // and no language server, and shows no status item: it only runs what needs no runtime, such as the agent-knowledge
  // detection. The runtime still resolves on demand (`runtime.ready()`: a command, an MCP agent, a task), and the
  // whole thing starts when an opentide folder or file appears.
  const withContent = () =>
    hasOpentideContent(
      folders.all.length,
      vscode.workspace.textDocuments.map((document) => document.languageId),
    );
  const start = async (): Promise<void> => {
    if (withContent()) return restart("activation");
    status.setDormant(true);
    log.info("activation: no opentide content in this window: the runtime starts when some appears");
    const wake = (why: string) => {
      if (!withContent()) return;
      for (const disposable of waiting) disposable.dispose();
      status.setDormant(false);
      void restart(why);
    };
    const waiting: vscode.Disposable[] = [
      folders.onDidChange(() => wake("an opentide folder appeared")),
      vscode.workspace.onDidOpenTextDocument(() => wake("an opentide file was opened")),
    ];
    subscriptions.push(...waiting);
  };

  return {
    ctx,
    wasiHost: () => wasiHost.host,
    start,
    shutdown: async (deadlineMs = 4000) => {
      // In order: stop what would start more (a resolution in flight), then the language server and `serve` together
      // (each can take a couple of seconds and a kill after that, and neither waits on the other), and last what is
      // left of the WASI processes. Each is awaited: `subscriptions` disposes them without waiting.
      const result = await runShutdown(
        [
          {
            name: "runtime resolution",
            run: async () => {
              runtime.cancelResolution();
            },
          },
          [
            { name: "language server", run: () => client.dispose() },
            { name: "opentide serve", run: () => backend.dispose() },
          ],
          { name: "WASI processes", run: () => wasiHost.shutdown() },
        ],
        {
          deadlineMs,
          // What did not finish in time is ended without waiting, so nothing outlives the host.
          onTimeout: (stuck) => {
            log.warn(`shutdown: "${stuck}" did not finish in ${deadlineMs} ms: ending what is left`);
            wasiHost.dispose();
          },
        },
      );
      for (const { name, error } of result.failed) log.warn(`shutdown: ${name}: ${error}`);
      return result;
    },
  };
}

function registerCoreCommands(ctx: FeatureContext, status: StatusManager, runtime: RuntimeManager): void {
  const { subscriptions, log } = ctx;
  subscriptions.push(
    status.addMenuItem({ label: "$(output) Show output", command: "opentide.showOutput", order: 100 }),
    status.addMenuItem({
      label: "$(debug-restart) Restart server",
      command: "opentide.restartServer",
      order: 110,
    }),
    status.addMenuItem({ label: "$(gear) Switch runtime…", command: "opentide.switchRuntime", order: 120 }),
    vscode.commands.registerCommand("opentide.showOutput", () => log.show()),
    vscode.commands.registerCommand("opentide.installOpentide", () =>
      vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL)),
    ),
    vscode.commands.registerCommand("opentide.restartServer", () =>
      runtime.restart("opentide: Restart Server"),
    ),
    vscode.commands.registerCommand("opentide.statusMenu", async () => {
      const items = status
        .menuItems()
        .filter((item) => ctx.trust.isTrusted || item.order === 100 || item.order === 110);
      const pin = runtime.pin;
      const install: StatusMenuItem[] = isEditorOnly(runtime.current)
        ? [{ label: "$(cloud-download) Install opentide…", command: "opentide.installOpentide", order: 115 }]
        : [];
      const extra: StatusMenuItem[] =
        runtime.pinMismatch && pin && ctx.trust.isTrusted
          ? [
              {
                label: `$(pinned) Use the pinned version (${pin.version})`,
                command: "opentide.usePinnedVersion",
                order: 125,
              },
              {
                label: `$(add) Create .venv with opentide ${pin.version}`,
                command: "opentide.createPinnedVenv",
                order: 126,
              },
            ]
          : [];
      const counts = status.problemCounts();
      const problems: StatusMenuItem = {
        label: `$(${counts.errors ? "error" : counts.warnings ? "warning" : "pass"}) Show Problems`,
        description: problemsText(counts),
        command: "workbench.actions.view.problems",
        order: 99,
      };
      type Item = vscode.QuickPickItem & { item?: StatusMenuItem };
      const entries: Item[] = menuSections([problems, ...items, ...install, ...extra]).flatMap((section) => [
        { label: section.label, kind: vscode.QuickPickItemKind.Separator },
        ...section.items.map((item) => ({
          label: item.label,
          ...(item.description ? { description: item.description } : {}),
          item,
        })),
      ]);
      const current = runtime.current;
      const picked = await vscode.window.showQuickPick(entries, {
        title:
          current?.kind === "engine"
            ? `${ENGINE_LABEL} ${current.version}`
            : current
              ? `opentide ${current.version}`
              : "opentide",
        placeHolder: current ? `${describeRuntime(current)} · ${problemsText(counts)}` : "No runtime",
      });
      const chosen = picked?.item;
      if (chosen) await vscode.commands.executeCommand(chosen.command, ...(chosen.args ?? []));
    }),
    vscode.commands.registerCommand("opentide.switchRuntime", () => switchRuntime(ctx)),
    vscode.commands.registerCommand("opentide.usePinnedVersion", async () => {
      if (!ctx.trust.isTrusted) return;
      const warning = await usePinnedVersion(runtime, () =>
        vscode.workspace
          .getConfiguration("opentide")
          .update("uv.usePin", true, vscode.ConfigurationTarget.Workspace),
      );
      if (warning) void vscode.window.showWarningMessage(warning);
    }),
    vscode.commands.registerCommand("opentide.createPinnedVenv", () => createPinnedVenv(ctx, runtime)),
  );
}

async function switchRuntime(ctx: FeatureContext): Promise<void> {
  if (!ctx.trust.isTrusted) {
    void vscode.window.showInformationMessage(
      "Restricted Mode runs no opentide, only the opentide engine (WASM). Trust this folder to choose a runtime.",
    );
    return;
  }
  const config = vscode.workspace.getConfiguration("opentide");
  const items: (vscode.QuickPickItem & { run: () => Thenable<unknown> })[] = [
    {
      label: "Bundled opentide (default)",
      detail:
        "The opentide the extension carries: nothing to install, the same version for everyone. Sets opentide.runtime to bundled for this workspace",
      run: async () => {
        await config.update("runtime", "bundled", vscode.ConfigurationTarget.Workspace);
      },
    },
    {
      label: "My installed opentide",
      detail:
        "opentide.path, the workspace's environment (its opentide, else python -m opentide), uv, then PATH; the bundled one if none answers. Sets opentide.runtime to installed for this workspace",
      run: async () => {
        await config.update("runtime", "installed", vscode.ConfigurationTarget.Workspace);
      },
    },
    {
      label: "Choose an opentide executable…",
      detail: "Sets opentide.path, and opentide.runtime to installed, for this workspace",
      run: async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "Use this opentide",
        });
        if (!picked?.[0]) return;
        await config.update("path", picked[0].fsPath, vscode.ConfigurationTarget.Workspace);
        await config.update("runtime", "installed", vscode.ConfigurationTarget.Workspace);
      },
    },
    {
      label: "Choose a Python interpreter…",
      detail:
        "Sets opentide.interpreter, and opentide.runtime to installed, for this workspace: a Python with opentide installed",
      run: async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "Use this interpreter",
        });
        if (!picked?.[0]) return;
        await config.update("interpreter", picked[0].fsPath, vscode.ConfigurationTarget.Workspace);
        await config.update("runtime", "installed", vscode.ConfigurationTarget.Workspace);
      },
    },
  ];
  items.push({
    label: "Install opentide…",
    detail: "How to install opentide: pip, uv or pipx. Then restart the server, or pick it here",
    run: () => vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL)),
  });
  if (vscode.extensions.getExtension("ms-python.python")) {
    items.push({
      label: "Select the Python interpreter (Python extension)…",
      detail: "The workspace environment tier follows it",
      run: () => vscode.commands.executeCommand("python.setInterpreter"),
    });
  }
  const current = ctx.runtime.current;
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder:
      current?.kind === "engine"
        ? `Now: the ${ENGINE_LABEL} ${current.version}: editor features only`
        : current
          ? `Now: opentide ${current.version} (${current.command})`
          : "No runtime",
  });
  await picked?.run();
}

async function createPinnedVenv(ctx: FeatureContext, runtime: RuntimeManager): Promise<void> {
  const pin = runtime.pin;
  const folder = ctx.folders.all[0];
  if (!ctx.trust.isTrusted || !pin || !folder) return;
  if (!/^[A-Za-z0-9.+!_-]+$/.test(pin.version)) return;
  const uv = uvExecutable(
    readRestricted<string>("opentide.uv.path", folder.folder.uri),
    folder.path,
    os.homedir(),
    (name) => which(name, process.env.PATH, process.platform),
  );
  if (!uv) {
    // No uv: the Python extension's create-environment command, when it is installed.
    if (vscode.extensions.getExtension("ms-python.python")) {
      await vscode.commands.executeCommand("python.createEnvironment");
      void vscode.window.showInformationMessage(
        `Install opentide==${pin.version} in the new environment, then restart opentide.`,
      );
    } else {
      void vscode.window.showWarningMessage(
        "Creating a .venv needs uv on PATH (or opentide.uv.path), or the Python extension.",
      );
    }
    return;
  }
  const steps = venvSteps(uv, pin.version);
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Creating .venv with opentide ${pin.version}` },
    () =>
      runSteps(steps, folder.path, execStep, (step, output) => {
        ctx.log.info(`${step.command} ${step.args.join(" ")}\n${output.trimEnd()}`);
      }),
  );
  if (!result.ok) {
    const choice = await vscode.window.showErrorMessage(
      `\`uv ${result.step.args.slice(0, 2).join(" ")}\` failed (exit ${result.code}); the .venv was not set up.`,
      "Show Log",
    );
    if (choice) ctx.log.show();
    return;
  }
  void runtime.restart(".venv created");
  void vscode.window.showInformationMessage(`Created .venv with opentide ${pin.version}.`);
}
