// Creates and wires the core services, registers the core commands, and builds the FeatureContext.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ActivityLog } from "./activity";
import { Backend } from "./backend/backend";
import { spawnRun } from "./backend/spawn";
import { Capabilities, type CommandsCache } from "./capabilities/capabilities";
import { CatalogStore, INFO_CATALOG } from "./catalog/store";
import type { CatalogSymbol } from "./catalog/types";
import type { FeatureContext, TrustService } from "./context";
import { CredentialStore } from "./credentials";
import { parseEnvFile } from "./envfile";
import { cliRange, codePointColumnToUtf16 } from "./positions";
import { processEnv } from "./runtime/env";
import { which } from "./runtime/process";
import { cliCommand } from "./runtime/types";
import { LanguageClientManager } from "./services/languageClient";
import { createLogger } from "./services/logger";
import { onDidChangePythonEnvironment } from "./services/python";
import { RuntimeManager } from "./services/runtime";
import { httpProxy, RESTART_SETTINGS, readRestricted, readSetting } from "./services/settings";
import { StatusManager } from "./services/status";
import { FileEvents, FolderManager, registerLanguageAssociation } from "./services/workspace";
import { Emitter } from "./util/event";
import { createWebviewHelpers } from "./webview/panel";

export interface Core {
  readonly ctx: FeatureContext;
  /** Resolve the runtime and start the language server, in the background. */
  start(): Promise<void>;
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

/** `opentide.envFile` variables for a folder (trusted only). */
function envFileVariables(folder: string): Record<string, string> {
  const setting = readRestricted<string>("opentide.envFile", vscode.Uri.file(folder));
  if (!setting?.trim()) return {};
  const file = path.isAbsolute(setting) ? setting : path.join(folder, setting);
  try {
    return parseEnvFile(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
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

  const backend = new Backend({
    runtime: () => runtime.current,
    commands: () => capabilities.ready(),
    classify: (argv) => capabilities.classify(argv),
    serveMode: () => (readSetting<string>("opentide.backend.serve") === "never" ? "never" : "auto"),
    baseEnv: () => process.env,
    proxy: () => httpProxy(),
    credentials: async (folder) => ({ ...envFileVariables(folder), ...(await credentials.env(folder)) }),
    platform: process.platform,
    log: (level, message) => log[level](message),
  });
  subscriptions.push({ dispose: () => void backend.dispose() });

  const activity = new ActivityLog();
  subscriptions.push(
    activity,
    backend.onDidRun((run) => activity.record(run)),
  );

  const client = new LanguageClientManager(log);
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
      const symbols = (await lc.sendRequest("workspace/symbol", { query: "" })) as
        | {
            name: string;
            containerName?: string;
            location: { uri: string; range?: { start: { line: number; character: number } } };
          }[]
        | null;
      const root = vscode.Uri.file(folder).toString();
      return (symbols ?? [])
        .filter((symbol) => symbol.location.uri.startsWith(`${root}/`))
        .map(
          (symbol): CatalogSymbol => ({
            name: symbol.name,
            family: symbol.containerName ?? "",
            uri: symbol.location.uri,
            line: symbol.location.range?.start.line ?? 0,
            character: symbol.location.range?.start.character ?? 0,
          }),
        );
    },
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

  // Restarts run one at a time; a restart asked for during one runs once more afterwards.
  let restarting: Promise<void> | undefined;
  let again: string | undefined;
  const doRestart = async (reason: string): Promise<void> => {
    log.info(`restart: ${reason}`);
    status.update({ runtime: runtime.current, resolving: true, pin: runtime.pin, trusted: trust.isTrusted });
    await client.stop();
    await backend.restart();
    const rt = await runtime.resolve();
    void capabilities.load(rt);
    status.update({ runtime: rt, resolving: false, pin: runtime.pin, trusted: trust.isTrusted });
    const cwd = trust.isTrusted ? primaryFolder()?.uri.fsPath : context.globalStorageUri.fsPath;
    if (!trust.isTrusted)
      await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true }).catch(() => undefined);
    await client.start(rt, cwd);
    status.setServer(client.serverInfo, client.current !== undefined);
    catalog.refreshAll({ immediate: true });
  };
  const restart = (reason: string): Promise<void> => {
    if (restarting) {
      again = reason;
      return restarting;
    }
    restarting = doRestart(reason)
      .catch((error: unknown) => log.error(`restart failed: ${String(error)}`))
      .finally(() => {
        restarting = undefined;
        if (again) {
          const next = again;
          again = undefined;
          void restart(next);
        }
      });
    return restarting;
  };
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
    fileEvents.onDidChange(({ folder, uris }) => {
      backend.invalidate(uris.map((uri) => uri.fsPath));
      if (catalog.folders().includes(folder.path)) void catalog.refresh(folder.path);
    }),
    folders.onDidChange((all) => {
      // A new primary folder changes the runtime; a paths.toml edit only changes object folders.
      const primary = all[0]?.path;
      if (primary !== lastPrimary) {
        lastPrimary = primary;
        void restart("workspace folders changed");
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (RESTART_SETTINGS.some((key) => event.affectsConfiguration(key))) void restart("settings changed");
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      await restart("workspace trusted");
      grant.fire();
    }),
    client.onDidChange(() => status.setServer(client.serverInfo, client.current !== undefined)),
    // The capability context keys ARCHITECTURE.md documents, for `when` clauses.
    capabilities.onDidChange(
      (tree) =>
        void vscode.commands.executeCommand(
          "setContext",
          "opentide.hasInfoCatalog",
          tree?.hasCommand(INFO_CATALOG) ?? false,
        ),
    ),
    backend.onDidChangeServe(
      ({ running }) => void vscode.commands.executeCommand("setContext", "opentide.serveRunning", running),
    ),
    runtime.onDidChange(
      () => void vscode.commands.executeCommand("setContext", "opentide.trusted", trust.isTrusted),
    ),
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

  return {
    ctx,
    start: () => restart("activation"),
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
    vscode.commands.registerCommand("opentide.restartServer", () =>
      runtime.restart("opentide: Restart Server"),
    ),
    vscode.commands.registerCommand("opentide.statusMenu", async () => {
      const items = status
        .menuItems()
        .filter((item) => ctx.trust.isTrusted || item.order === 100 || item.order === 110);
      const pin = runtime.pin;
      const extra =
        runtime.pinMismatch && pin && ctx.trust.isTrusted
          ? [
              {
                label: `$(pinned) Use the pinned version (${pin.version})`,
                command: "opentide.usePinnedVersion",
              },
              {
                label: `$(add) Create .venv with opentide ${pin.version}`,
                command: "opentide.createPinnedVenv",
              },
            ]
          : [];
      const picked = await vscode.window.showQuickPick(
        [...extra, ...items].map((item) => ({
          label: item.label,
          description: "description" in item ? item.description : undefined,
          item,
        })),
        { placeHolder: "opentide" },
      );
      if (picked)
        await vscode.commands.executeCommand(
          picked.item.command,
          ...("args" in picked.item ? (picked.item.args ?? []) : []),
        );
    }),
    vscode.commands.registerCommand("opentide.switchRuntime", () => switchRuntime(ctx)),
    vscode.commands.registerCommand("opentide.usePinnedVersion", async () => {
      if (!ctx.trust.isTrusted) return;
      await vscode.workspace
        .getConfiguration("opentide")
        .update("uv.usePin", true, vscode.ConfigurationTarget.Workspace);
      await runtime.ready();
      const uv = runtime.attempts.find((attempt) => attempt.source === "uv");
      if (runtime.current?.source !== "uv" && uv) {
        void vscode.window.showWarningMessage(`Could not use the pinned version with uv: ${uv.detail}`);
      }
    }),
    vscode.commands.registerCommand("opentide.createPinnedVenv", () => createPinnedVenv(ctx, runtime)),
  );
}

async function switchRuntime(ctx: FeatureContext): Promise<void> {
  if (!ctx.trust.isTrusted) {
    void vscode.window.showInformationMessage(
      "Restricted Mode uses the bundled runtime. Trust this folder to choose another.",
    );
    return;
  }
  const config = vscode.workspace.getConfiguration("opentide");
  const items: (vscode.QuickPickItem & { run: () => Thenable<unknown> })[] = [
    {
      label: "Automatic",
      detail: "opentide.path, then the workspace's environment, then the bundled runtime",
      run: async () => {
        await config.update("runtime", undefined, vscode.ConfigurationTarget.Workspace);
        await config.update("path", undefined, vscode.ConfigurationTarget.Workspace);
      },
    },
    {
      label: "Bundled runtime",
      detail: "The opentide that ships with the extension",
      run: () => config.update("runtime", "bundled", vscode.ConfigurationTarget.Workspace),
    },
    {
      label: "Choose an opentide executable…",
      detail: "Sets opentide.path for this workspace",
      run: async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "Use this opentide",
        });
        if (picked?.[0]) {
          await config.update("runtime", undefined, vscode.ConfigurationTarget.Workspace);
          await config.update("path", picked[0].fsPath, vscode.ConfigurationTarget.Workspace);
        }
      },
    },
    {
      label: "Choose a Python interpreter…",
      detail: "Sets opentide.interpreter for this workspace: a Python with opentide installed",
      run: async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "Use this interpreter",
        });
        if (picked?.[0])
          await config.update("interpreter", picked[0].fsPath, vscode.ConfigurationTarget.Workspace);
      },
    },
  ];
  if (vscode.extensions.getExtension("ms-python.python")) {
    items.push({
      label: "Select the Python interpreter (Python extension)…",
      detail: "The workspace environment tier follows it",
      run: () => vscode.commands.executeCommand("python.setInterpreter"),
    });
  }
  const current = ctx.runtime.current;
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: current ? `Now: opentide ${current.version} (${current.command})` : "No runtime",
  });
  await picked?.run();
}

async function createPinnedVenv(ctx: FeatureContext, runtime: RuntimeManager): Promise<void> {
  const pin = runtime.pin;
  const folder = ctx.folders.all[0];
  if (!ctx.trust.isTrusted || !pin || !folder) return;
  if (!/^[A-Za-z0-9.+!_-]+$/.test(pin.version)) return;
  const uv =
    readRestricted<string>("opentide.uv.path")?.trim() || which("uv", process.env.PATH, process.platform);
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
  const terminal = vscode.window.createTerminal({ name: "opentide: create .venv", cwd: folder.path });
  terminal.show();
  const quoted = /^[A-Za-z0-9_./:\\-]+$/.test(uv) ? uv : `"${uv.replaceAll('"', '\\"')}"`;
  terminal.sendText(
    `${quoted} venv .venv && ${quoted} pip install --python .venv "opentide==${pin.version}"`,
  );
  const done = vscode.window.onDidCloseTerminal((closed) => {
    if (closed !== terminal) return;
    done.dispose();
    void runtime.restart(".venv created");
  });
  ctx.subscriptions.push(done);
  void vscode.window.showInformationMessage(
    `Creating .venv with opentide ${pin.version}. Close the terminal when it finishes to switch to it.`,
  );
}
