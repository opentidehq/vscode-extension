// Agents (SPEC §12, #6): the opentide MCP server for VS Code's agents, a user-level MCP entry for forks
// without the provider API, and two language-model tools for live editor state. Glue over mcp.ts, forks.ts
// and tools.ts; the newer VS Code APIs are feature-detected.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FeatureContext } from "../../core/context";
import { defineFeature } from "../../core/feature";
import { which } from "../../core/runtime/process";
import { readWasi } from "../../core/services/runtime";
import { httpProxy, readRestricted, readSetting } from "../../core/services/settings";
import { cursorMcp, cursorRegistration } from "./cursor";
import {
  chooseMcpMechanism,
  configProblem,
  type ForkTarget,
  forkTarget,
  hasOurEntry,
  mergeMcpEntry,
  removeMcpEntry,
} from "./forks";
import { launcherEntry, launcherPath, launcherStale } from "./launcher";
import {
  decideMcp,
  entryUsable,
  environmentLookup,
  MCP_FILES,
  MCP_PROVIDER_ID,
  type McpDecision,
  McpDecisionLog,
  mcpBridge,
  opentideEntryCommand,
  opentideServerCommand,
  provideMode,
  USER_CONFIG_ORDER,
  WORKSPACE_CONFIG_ORDER,
  type WorkspaceEntry,
  workspaceMcpFiles,
} from "./mcp";
import {
  ACTIVE_OBJECT_TOOL,
  activeObjectPayload,
  DIAGNOSTICS_TOOL,
  diagnosticsPayload,
  type PlainDiagnostic,
} from "./tools";

// The MCP and language-model tool APIs are newer than `engines.vscode` (1.91): declared here, detected at run time.
interface McpStdioDefinition {
  cwd?: vscode.Uri;
}
type McpStdioCtor = new (
  label: string,
  command: string,
  args?: string[],
  env?: Record<string, string | number | null>,
  version?: string,
) => McpStdioDefinition;
interface McpProvider {
  readonly onDidChangeMcpServerDefinitions?: vscode.Event<void>;
  provideMcpServerDefinitions(token: vscode.CancellationToken): Promise<McpStdioDefinition[]>;
  resolveMcpServerDefinition?(server: McpStdioDefinition): McpStdioDefinition;
}
interface ToolInvocation {
  readonly input: unknown;
}
interface LanguageModelTool {
  invoke(options: ToolInvocation, token: vscode.CancellationToken): Promise<unknown>;
}
interface NewerLm {
  registerMcpServerDefinitionProvider?(id: string, provider: McpProvider): vscode.Disposable;
  registerTool?(name: string, tool: LanguageModelTool): vscode.Disposable;
}
interface NewerApi {
  readonly McpStdioServerDefinition?: McpStdioCtor;
  readonly LanguageModelToolResult?: new (content: unknown[]) => unknown;
  readonly LanguageModelTextPart?: new (value: string) => unknown;
}

const newer = vscode as unknown as NewerApi;
const lm = (vscode.lm ?? {}) as unknown as NewerLm;

export default defineFeature({
  id: "agents",
  activate(ctx) {
    const cursor = cursorMcp(vscode);
    const hasProviderApi =
      typeof lm.registerMcpServerDefinitionProvider === "function" &&
      newer.McpStdioServerDefinition !== undefined;
    // By host, not by API presence (#84): Kiro's core has the provider API but its agent never reads it.
    const mechanism = chooseMcpMechanism({
      cursor: cursor !== undefined,
      hasProviderApi,
      appName: vscode.env.appName,
      uriScheme: vscode.env.uriScheme,
      home: os.homedir(),
    });
    ctx.log.info(`agents: ${mechanism.description}`);
    void vscode.commands.executeCommand(
      "setContext",
      "opentide.agents.forkMcp",
      mechanism.fork?.editor ?? false,
    );
    if (cursor) registerCursorServer(ctx, cursor);
    if (mechanism.provider) registerMcpProvider(ctx);
    if (mechanism.fork) maintainForkEntry(ctx, mechanism.fork);
    ctx.subscriptions.push(
      vscode.commands.registerCommand("opentide.agents.addToEditorMcp", () => addToForkMcp(ctx)),
      vscode.commands.registerCommand("opentide.agents.removeFromEditorMcp", () => removeFromForkMcp(ctx)),
    );
    registerTools(ctx);
  },
});

/**
 * Whether and how the opentide MCP server is provided now (SPEC §12): the one decision the provider, Cursor's
 * registration and the user-level file all follow. Nothing in Restricted Mode, without reading a setting or a file.
 */
async function decideNow(ctx: FeatureContext, log?: McpDecisionLog): Promise<McpDecision> {
  if (!ctx.trust.isTrusted) return { provide: false, reason: "Restricted Mode" };
  const runtime = await ctx.runtime.ready();
  const tree = (await ctx.capabilities.ready()) ?? ctx.capabilities.current;
  const mode = provideMode(readRestricted<string>("opentide.mcp.provide"));
  const decision = decideMcp({
    trusted: ctx.trust.isTrusted,
    mode,
    runtime: ctx.runtime.current ?? runtime,
    // No tree yet for a runtime with commands: capabilities.onDidChange asks again once it loads.
    hasMcpStart: tree ? tree.hasCommand("mcp start") : undefined,
    folder: ctx.folders.all[0]?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    workspaceEntries: mode === "never" ? [] : await workspaceEntries(),
    proxy: httpProxy(),
    bridge: bundledBridge(ctx),
  });
  const line = log?.line(decision);
  if (line) ctx.log.info(line);
  return decision;
}

/** What the decision changes on: the runtime, the command tree, trust, folders and the settings it reads. */
function onMcpInputsChanged(ctx: FeatureContext, fire: () => void): vscode.Disposable[] {
  return [
    ctx.runtime.onDidChange(fire),
    ctx.capabilities.onDidChange(fire),
    ctx.trust.onDidGrant(fire),
    ctx.folders.onDidChange(fire),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("opentide.mcp.provide") ||
        event.affectsConfiguration("opentide.runtime") ||
        event.affectsConfiguration("opentide.wasi.enabled") ||
        event.affectsConfiguration("mcp") ||
        event.affectsConfiguration("chat.mcp.discovery.enabled")
      )
        fire();
    }),
  ];
}

/**
 * The `opentide` servers of the workspace MCP files VS Code reads (`.vscode/mcp.json`, `.mcp.json`, and
 * `.cursor/mcp.json` when `chat.mcp.discovery.enabled` says so), a `.code-workspace`'s and the user's, each with its order in VS Code and
 * whether VS Code can start its command. decideMcp defers when those VS Code may keep can all start, and
 * logs, once, why it provides its own under another label when one cannot.
 */
async function workspaceEntries(): Promise<WorkspaceEntry[]> {
  const lookup = {
    isAbsolute: (file: string) => path.isAbsolute(file),
    exists: (file: string) => fs.existsSync(file),
    which: (name: string) => which(name, process.env.PATH, process.platform),
    env: environmentLookup(process.env, process.platform),
  };
  const files = workspaceMcpFiles(vscode.workspace.getConfiguration("chat.mcp").get("discovery.enabled"));
  const folders = vscode.workspace.workspaceFolders ?? [];
  const entries: WorkspaceEntry[] = [];
  for (const file of files) {
    for (const folder of folders) {
      let text: string;
      try {
        text = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, ...file.segments)),
        );
      } catch {
        continue; // No file.
      }
      const command = opentideEntryCommand(text, file.kind);
      if (command === undefined) continue;
      entries.push({
        file: `${folder.name}/${file.segments.join("/")}`,
        command,
        usable: entryUsable(command, lookup, file.expansion),
        order: file.order,
      });
    }
  }
  // `mcp.servers` of a `.code-workspace` and of the user's mcp.json. A single folder's workspace value is
  // its `.vscode/mcp.json`, read above.
  const servers = vscode.workspace.getConfiguration("mcp").inspect<unknown>("servers");
  const workspaceFile = vscode.workspace.workspaceFile;
  const configured = [
    ...(workspaceFile
      ? [
          {
            file: path.posix.basename(workspaceFile.path),
            value: servers?.workspaceValue,
            order: WORKSPACE_CONFIG_ORDER,
          },
        ]
      : []),
    { file: "the user's mcp.json", value: servers?.globalValue, order: USER_CONFIG_ORDER },
  ];
  for (const { file, value, order } of configured) {
    const command = opentideServerCommand(value);
    if (command === undefined) continue;
    entries.push({ file, command, usable: entryUsable(command, lookup, "variables"), order });
  }
  return entries;
}

/** The bundled MCP bridge of this build, when `opentide.wasi.enabled` leaves the module on. */
function bundledBridge(ctx: FeatureContext) {
  return mcpBridge(
    ctx.extension.extensionPath,
    process.execPath,
    readWasi(ctx.extension.extensionPath),
    fs.existsSync,
    readSetting<boolean>("opentide.wasi.enabled") !== false,
  );
}

function registerMcpProvider(ctx: FeatureContext): void {
  const register = lm.registerMcpServerDefinitionProvider;
  const Definition = newer.McpStdioServerDefinition;
  if (!register || !Definition) return;
  const changed = new vscode.EventEmitter<void>();
  const fire = () => changed.fire();
  const watchers = MCP_FILES.map((file) => vscode.workspace.createFileSystemWatcher(file.glob));
  const log = new McpDecisionLog();
  const provider: McpProvider = {
    onDidChangeMcpServerDefinitions: changed.event,
    async provideMcpServerDefinitions() {
      const decision = await decideNow(ctx, log);
      if (!decision.provide) return [];
      const { server } = decision;
      const definition = new Definition(
        server.label,
        server.command,
        [...server.args],
        { ...server.env },
        server.version,
      );
      definition.cwd = vscode.Uri.file(server.cwd);
      return [definition];
    },
    resolveMcpServerDefinition: (server) => server,
  };
  ctx.subscriptions.push(
    changed,
    ...watchers.flatMap((watcher) => [
      watcher,
      watcher.onDidCreate(fire),
      watcher.onDidChange(fire),
      watcher.onDidDelete(fire),
    ]),
    ...onMcpInputsChanged(ctx, fire),
    register(MCP_PROVIDER_ID, provider),
  );
}

/** Cursor: register the same stdio server with its extension API, and take it back when it no longer applies. */
function registerCursorServer(ctx: FeatureContext, cursor: NonNullable<ReturnType<typeof cursorMcp>>): void {
  const log = new McpDecisionLog();
  let registered: string | undefined;
  let running = Promise.resolve();
  const withdraw = () => {
    if (registered === undefined) return;
    try {
      cursor.unregisterServer(registered);
    } catch (error) {
      ctx.log.warn(`agents: cursor.mcp.unregisterServer(${registered}): ${String(error)}`);
    }
    registered = undefined;
  };
  const apply = () => {
    running = running.then(async () => {
      const decision = await decideNow(ctx, log);
      withdraw();
      if (!decision.provide) return;
      try {
        cursor.registerServer(cursorRegistration(decision.server));
        registered = decision.server.label;
        ctx.log.info(`agents: registered ${decision.server.label} with Cursor (${decision.server.command})`);
      } catch (error) {
        ctx.log.warn(`agents: cursor.mcp.registerServer: ${String(error)}`);
      }
    });
  };
  ctx.subscriptions.push({ dispose: withdraw }, ...onMcpInputsChanged(ctx, apply));
  apply();
}

/** The entry a user-level file gets: the resolved server, without the per-folder variable. */
function entryOf(decision: McpDecision & { provide: true }) {
  const { OPENTIDE_REPO_ROOT: _folder, ...env } = decision.server.env;
  return { command: decision.server.command, args: decision.server.args, env };
}

/**
 * The entry for a user-level MCP file. For the bundled bridge it names the stable launcher in the global storage
 * (written here when it is missing or differs), so an extension update changes nothing in the file; for an
 * installed opentide it is that opentide's own `mcp start`.
 */
async function forkEntryOf(
  ctx: FeatureContext,
  target: ForkTarget,
  decision: McpDecision & { provide: true },
): Promise<ReturnType<typeof entryOf>> {
  if (!decision.server.bridge) return entryOf(decision);
  const storageDir = ctx.extension.globalStorageUri.fsPath;
  const source = await readFileOrUndefined(path.join(ctx.extension.extensionPath, "dist", "mcp-launcher.js"));
  if (source !== undefined) {
    const file = launcherPath(storageDir);
    if (launcherStale(await readFileOrUndefined(file), source)) {
      try {
        await fs.promises.mkdir(storageDir, { recursive: true });
        await fs.promises.writeFile(file, source, "utf8");
        ctx.log.info(`agents: wrote the MCP launcher ${file}`);
      } catch (error) {
        ctx.log.warn(`agents: could not write the MCP launcher ${file}: ${String(error)}`);
      }
    }
  } else {
    ctx.log.warn(
      "agents: this build has no dist/mcp-launcher.js; the entry runs the bridge by its versioned path",
    );
    return entryOf(decision);
  }
  const proxy = decision.server.env.OPENTIDE_PROXY;
  return launcherEntry({
    execPath: decision.server.command,
    storageDir,
    extensionPath: ctx.extension.extensionPath,
    entryFile: target.file,
    proxy,
  });
}

async function readFileOrUndefined(file: string): Promise<string | undefined> {
  return fs.promises.readFile(file, "utf8").catch(() => undefined);
}

const DECLINED_KEY = "opentide.agents.writeEditorConfig.declined";

/**
 * Kiro, Devin Desktop, Windsurf: keep the extension's entry in the editor's user-level MCP file current. An
 * entry the extension wrote is rewritten when its command or the extension's version changed; a new one is
 * written only after the user agrees (`opentide.agents.writeEditorConfig`: ask, always or never); the user's own
 * `opentide` entry and every other server are never touched.
 */
function maintainForkEntry(ctx: FeatureContext, target: ForkTarget): void {
  const log = new McpDecisionLog();
  let asked = false;
  let lastProblem: string | undefined;
  let running = Promise.resolve();
  const apply = () => {
    running = running.then(async () => {
      const mode = readSetting<string>("opentide.agents.writeEditorConfig") ?? "ask";
      if (mode === "never") return;
      const decision = await decideNow(ctx, log);
      if (!decision.provide) return;
      const existing = await readFileOrUndefined(target.file);
      // A file the extension cannot read is not offered an entry: say so once, in the log, and leave it.
      const problem = configProblem(existing);
      if (problem !== undefined) {
        if (problem !== lastProblem) ctx.log.warn(`agents: ${target.file} ${problem}: left unchanged`);
        lastProblem = problem;
        return;
      }
      lastProblem = undefined;
      const ours = hasOurEntry(existing);
      if (!ours) {
        if (mode !== "always") {
          if (asked || ctx.extension.globalState.get<boolean>(DECLINED_KEY)) return;
          asked = true;
          const shown = target.file.replace(os.homedir(), "~");
          const choice = await vscode.window.showInformationMessage(
            `${target.editor}'s agent reads MCP servers from ${shown}, not from extensions. Add the opentide MCP server to it?`,
            "Add",
            "Not now",
            "Never",
          );
          if (choice === "Never") await ctx.extension.globalState.update(DECLINED_KEY, true);
          if (choice !== "Add") return;
        }
      }
      await writeForkEntry(ctx, target, await forkEntryOf(ctx, target, decision), ours ? "refresh" : "add");
    });
  };
  ctx.subscriptions.push(...onMcpInputsChanged(ctx, apply));
  apply();
}

async function writeForkEntry(
  ctx: FeatureContext,
  target: ForkTarget,
  entry: ReturnType<typeof entryOf>,
  why: "add" | "refresh",
): Promise<"written" | "same" | "refused"> {
  const shown = target.file.replace(os.homedir(), "~");
  const existing = await readFileOrUndefined(target.file);
  const merged = mergeMcpEntry(existing, entry);
  if (merged.kind === "same") return "same";
  if (merged.kind === "foreign") {
    ctx.log.info(`agents: ${shown} has an opentide server the extension did not write: left unchanged`);
    if (why === "add")
      void vscode.window.showInformationMessage(
        `${shown} already defines an opentide server of your own: left unchanged. Remove it to let the extension manage one.`,
      );
    return "refused";
  }
  if (merged.kind === "error") {
    ctx.log.warn(`agents: ${shown} ${merged.error}: left unchanged`);
    void vscode.window.showErrorMessage(
      `${shown} ${merged.error}; left unchanged. Add opentide to it by hand.`,
    );
    return "refused";
  }
  try {
    await fs.promises.mkdir(path.dirname(target.file), { recursive: true });
    await fs.promises.writeFile(target.file, merged.text, "utf8");
  } catch (error) {
    ctx.log.warn(`agents: could not write ${target.file}: ${String(error)}`);
    void vscode.window.showErrorMessage(`Could not write ${shown}: ${String(error)}`);
    return "refused";
  }
  ctx.log.info(
    `agents: ${why === "add" ? "added" : "refreshed"} opentide (${entry.command}) in ${target.file}`,
  );
  return "written";
}

/** The command: write the entry now, after confirming it, whatever the setting says. */
async function addToForkMcp(ctx: FeatureContext): Promise<void> {
  const target = forkTarget(
    vscode.env.appName,
    os.homedir(),
    process.platform,
    undefined,
    vscode.env.uriScheme,
  );
  if (!target) {
    void vscode.window.showInformationMessage(
      "This editor gets the opentide MCP server from the extension itself; there is nothing to add.",
    );
    return;
  }
  if (!ctx.trust.isTrusted) {
    void vscode.window.showWarningMessage(
      "Restricted Mode: trust this folder to set up the opentide MCP server.",
    );
    return;
  }
  const decision = await decideNow(ctx);
  if (!decision.provide) {
    void vscode.window.showWarningMessage(`The opentide MCP server is not available: ${decision.reason}.`);
    return;
  }
  const entry = await forkEntryOf(ctx, target, decision);
  const shown = target.file.replace(os.homedir(), "~");
  const picked = await vscode.window.showInformationMessage(
    `Add opentide to ${target.editor}'s MCP settings (${shown})? It runs ${path.basename(entry.command)} with the extension's bridge.`,
    "Add",
  );
  if (picked !== "Add") return;
  if ((await writeForkEntry(ctx, target, entry, "add")) === "refused") return;
  await ctx.extension.globalState.update(DECLINED_KEY, undefined);
  const open = await vscode.window.showInformationMessage(`Added opentide to ${shown}.`, "Open File");
  if (open) await vscode.window.showTextDocument(vscode.Uri.file(target.file));
}

/** The command: remove the extension's entry, and only that. */
async function removeFromForkMcp(ctx: FeatureContext): Promise<void> {
  const target = forkTarget(
    vscode.env.appName,
    os.homedir(),
    process.platform,
    undefined,
    vscode.env.uriScheme,
  );
  if (!target) return;
  const shown = target.file.replace(os.homedir(), "~");
  const existing = await readFileOrUndefined(target.file);
  const removal = removeMcpEntry(existing);
  if (removal.kind === "error") {
    ctx.log.warn(`agents: ${shown} ${removal.error}: left unchanged`);
    void vscode.window.showErrorMessage(
      `${shown} ${removal.error}; left unchanged. Remove opentide from it by hand.`,
    );
    return;
  }
  if (removal.kind === "none") {
    void vscode.window.showInformationMessage(`${shown} has no opentide entry the extension wrote.`);
    return;
  }
  try {
    await fs.promises.writeFile(target.file, removal.text, "utf8");
  } catch (error) {
    ctx.log.warn(`agents: could not write ${target.file}: ${String(error)}`);
    void vscode.window.showErrorMessage(`Could not write ${shown}: ${String(error)}`);
    return;
  }
  // So the extension does not write it again unasked.
  await ctx.extension.globalState.update(DECLINED_KEY, true);
  ctx.log.info(`agents: removed the extension's opentide entry from ${target.file}`);
  void vscode.window.showInformationMessage(`Removed the extension's opentide entry from ${shown}.`);
}

function plain(diagnostic: vscode.Diagnostic): PlainDiagnostic {
  const code = diagnostic.code;
  return {
    message: diagnostic.message,
    severity: diagnostic.severity,
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(code !== undefined ? { code: typeof code === "object" ? { value: code.value } : code } : {}),
    range: diagnostic.range,
  };
}

/** The tool input's `file` (absolute or workspace-relative), else the active editor's file. */
function fileOf(input: unknown): vscode.Uri | undefined {
  const file = (input as { file?: unknown } | null)?.file;
  if (typeof file === "string" && file.trim()) {
    if (path.isAbsolute(file)) return vscode.Uri.file(file);
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? vscode.Uri.joinPath(folder.uri, file) : undefined;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  return active?.scheme === "file" ? active : undefined;
}

function registerTools(ctx: FeatureContext): void {
  const registerTool = lm.registerTool;
  const Result = newer.LanguageModelToolResult;
  const Text = newer.LanguageModelTextPart;
  if (!registerTool || !Result || !Text) return;
  const answer = (value: unknown) => new Result([new Text(JSON.stringify(value, null, 2))]);
  ctx.subscriptions.push(
    registerTool(DIAGNOSTICS_TOOL, {
      async invoke(options) {
        const uri = fileOf(options.input);
        if (!uri) return answer({ error: "No file given and no file open in the editor." });
        return answer(diagnosticsPayload(uri.fsPath, vscode.languages.getDiagnostics(uri).map(plain)));
      },
    }),
    registerTool(ACTIVE_OBJECT_TOOL, {
      async invoke() {
        const uri = fileOf(undefined);
        const folder = uri ? ctx.folders.folderOf(uri) : undefined;
        const state = folder ? ctx.catalog.get(folder.path) : undefined;
        if (state && state.status !== "ready" && !state.catalog && state.status !== "unavailable")
          await ctx.catalog.refresh(folder?.path ?? "", { immediate: true }).catch(() => undefined);
        const fresh = folder ? ctx.catalog.get(folder.path) : undefined;
        const unavailable =
          fresh?.unavailable?.reason === "needs-command"
            ? "The catalogue needs opentide with `info catalog`."
            : (fresh?.unavailable?.message ?? fresh?.error);
        return answer(
          activeObjectPayload(
            uri?.fsPath,
            fresh?.catalog,
            folder ? unavailable : "The active file is not in an opentide folder.",
          ),
        );
      },
    }),
  );
}
