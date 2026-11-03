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
import { cliCommand, hasCli } from "../../core/runtime/types";
import { httpProxy, readRestricted } from "../../core/services/settings";
import { forkTarget, mergeMcpEntry } from "./forks";
import { decideMcp, entryUsable, MCP_PROVIDER_ID, opentideEntryCommand, provideMode } from "./mcp";
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
    const hasProviderApi =
      typeof lm.registerMcpServerDefinitionProvider === "function" &&
      newer.McpStdioServerDefinition !== undefined;
    const fork = hasProviderApi ? undefined : forkTarget(vscode.env.appName, os.homedir());
    void vscode.commands.executeCommand("setContext", "opentide.agents.forkMcp", fork?.editor ?? false);
    if (hasProviderApi) registerMcpProvider(ctx);
    ctx.subscriptions.push(
      vscode.commands.registerCommand("opentide.agents.addToEditorMcp", () => addToForkMcp(ctx)),
    );
    registerTools(ctx);
  },
});

/**
 * `.vscode/mcp.json` of any workspace folder defines an `opentide` server VS Code can start. One whose
 * command is not found (`opentide` with only the bundled runtime) does not count: deferring to it would
 * leave the agents with a server that fails with ENOENT.
 */
async function workspaceDefinesOpentide(log: FeatureContext["log"]): Promise<boolean> {
  const lookup = {
    isAbsolute: (file: string) => path.isAbsolute(file),
    exists: (file: string) => fs.existsSync(file),
    which: (name: string) => which(name, process.env.PATH, process.platform),
  };
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    let text: string;
    try {
      text = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, ".vscode", "mcp.json")),
      );
    } catch {
      continue; // No file.
    }
    const command = opentideEntryCommand(text);
    if (command === undefined) continue;
    if (entryUsable(command, lookup)) return true;
    log.info(
      `${folder.name}/.vscode/mcp.json's opentide server runs \`${command}\`, which is not found: providing the extension's server instead`,
    );
  }
  return false;
}

function registerMcpProvider(ctx: FeatureContext): void {
  const register = lm.registerMcpServerDefinitionProvider;
  const Definition = newer.McpStdioServerDefinition;
  if (!register || !Definition) return;
  const changed = new vscode.EventEmitter<void>();
  const fire = () => changed.fire();
  const watcher = vscode.workspace.createFileSystemWatcher("**/.vscode/mcp.json");
  let lastReason: string | undefined;
  const provider: McpProvider = {
    onDidChangeMcpServerDefinitions: changed.event,
    async provideMcpServerDefinitions() {
      // Restricted Mode: nothing, without reading a setting or a file.
      if (!ctx.trust.isTrusted) return [];
      const runtime = await ctx.runtime.ready();
      await ctx.capabilities.ready();
      const mode = provideMode(readRestricted<string>("opentide.mcp.provide"));
      const decision = decideMcp({
        trusted: ctx.trust.isTrusted,
        mode,
        runtime: ctx.runtime.current ?? runtime,
        hasMcpStart: ctx.capabilities.hasCommand("mcp start"),
        folder: ctx.folders.all[0]?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        workspaceDefines: mode === "auto" ? await workspaceDefinesOpentide(ctx.log) : false,
        proxy: httpProxy(),
      });
      if (!decision.provide) {
        if (decision.reason !== lastReason) ctx.log.info(`MCP server not provided: ${decision.reason}`);
        lastReason = decision.reason;
        return [];
      }
      lastReason = undefined;
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
    watcher,
    watcher.onDidCreate(fire),
    watcher.onDidChange(fire),
    watcher.onDidDelete(fire),
    ctx.runtime.onDidChange(fire),
    ctx.capabilities.onDidChange(fire),
    ctx.trust.onDidGrant(fire),
    ctx.folders.onDidChange(fire),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("opentide.mcp.provide")) fire();
    }),
    register(MCP_PROVIDER_ID, provider),
  );
}

/** Cursor and Windsurf: write `mcpServers.opentide` into the editor's user-level MCP file, after asking. */
async function addToForkMcp(ctx: FeatureContext): Promise<void> {
  const target = forkTarget(vscode.env.appName, os.homedir());
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
  const runtime = await ctx.runtime.ready();
  if (!hasCli(runtime)) {
    void vscode.window
      .showWarningMessage("No opentide runtime to run the MCP server with.", "Switch Runtime…")
      .then((picked) => picked && vscode.commands.executeCommand("opentide.switchRuntime"));
    return;
  }
  const { command, args } = cliCommand(runtime, ["mcp", "start"]);
  const env: Record<string, string> = { ...runtime.env };
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the editor expands it, not JavaScript
  if (target.workspaceVariable) env.OPENTIDE_REPO_ROOT = "${workspaceFolder}";
  const existing = await fs.promises.readFile(target.file, "utf8").catch(() => undefined);
  const merged = mergeMcpEntry(existing, { command, args, env });
  const shown = target.file.replace(os.homedir(), "~");
  if ("error" in merged) {
    void vscode.window.showErrorMessage(
      `${shown} ${merged.error}; left unchanged. Add opentide to it by hand.`,
    );
    return;
  }
  const picked = await vscode.window.showInformationMessage(
    `Add opentide to ${target.editor}'s MCP settings (${shown})? It runs ${path.basename(command)} from ${runtime.source === "bundled" ? "the bundled runtime" : path.dirname(command)}.`,
    "Add",
  );
  if (picked !== "Add") return;
  try {
    await fs.promises.mkdir(path.dirname(target.file), { recursive: true });
    await fs.promises.writeFile(target.file, merged.text, "utf8");
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not write ${shown}: ${String(error)}`);
    return;
  }
  ctx.log.info(`added opentide (${command}) to ${target.file}`);
  const open = await vscode.window.showInformationMessage(
    `Added opentide to ${shown}. ${runtime.source === "bundled" ? "It points at this extension version's runtime: run this again after an update." : ""}`.trim(),
    "Open File",
  );
  if (open) await vscode.window.showTextDocument(vscode.Uri.file(target.file));
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
