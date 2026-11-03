// Setup wizard, welcome triggers and walkthrough (SPEC §8, #16). Glue only: the answers, the commands
// they become, Review and Apply are the vscode-free modules next to this file.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { RunResult } from "../../core/backend/backend";
import { BackendError } from "../../core/backend/types";
import type { FeatureContext } from "../../core/context";
import { defineFeature } from "../../core/feature";
import type { OpentidePanel } from "../../core/webview/panel";
import { platformName } from "../sidebar/platformNames";
import { parsePlatforms } from "../sidebar/platforms";
import {
  defaultAnswers,
  type OptionSource,
  type SetupSupport,
  script,
  setupCommands,
  setupSupport,
} from "./answers";
import { type Entry, folderKind, isGitRepository, walkthroughCommand, walkthroughKeys } from "./detect";
import { apply, type Runner, review } from "./flow";
import { fileToOpen } from "./plan";
import {
  hostValidators,
  type PlatformChoice,
  type SetupAnswers,
  type SetupMode,
  type WizardProtocol,
} from "./protocol";

const PROMPTED_KEY = "opentide.setup.prompted";
const setContext = (key: string, value: unknown) =>
  void vscode.commands.executeCommand("setContext", key, value);

async function entries(folder: string): Promise<Entry[]> {
  try {
    const list = await fs.promises.readdir(folder, { withFileTypes: true });
    return list.map((e) => ({ name: e.name, directory: e.isDirectory() }));
  } catch {
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof BackendError || error instanceof Error ? error.message : String(error);
}

export default defineFeature({
  id: "setup",
  activate(ctx) {
    const wizard = new WizardHost(ctx);
    ctx.subscriptions.push(
      wizard,
      vscode.commands.registerCommand("opentide.setup.open", (arg?: unknown) =>
        wizard.open(typeof arg === "string" ? { folder: arg } : {}),
      ),
      vscode.commands.registerCommand("opentide.setup.agents", () => wizard.open({ step: 3 })),
      vscode.commands.registerCommand("opentide.setup.migrate", (arg?: unknown) =>
        migrate(ctx, wizard, typeof arg === "string" ? arg : undefined),
      ),
      vscode.commands.registerCommand("opentide.setup.step", (step?: unknown) =>
        walkthroughStep(ctx, typeof step === "string" ? step : ""),
      ),
      ctx.backend.onDidRun((run) => {
        for (const key of walkthroughKeys(run)) setContext(key, true);
      }),
      ctx.catalog.onDidChange((state) => {
        const rules =
          (state.catalog?.objects.some((o) => o.type === "rule" && !o.load_error) ?? false) ||
          (state.symbols?.some((s) => s.family === "rule") ?? false);
        if (rules) setContext("opentide.setup.hasRule", true);
      }),
      ctx.folders.onDidChange(() => void detectLayout()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void detectLayout()),
    );
    // No I/O on the activation path: look at the folders on the next tick, and prompt once the runtime
    // has resolved.
    const detectLayout = async (): Promise<void> => {
      let legacy = false;
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme !== "file") continue;
        if (folderKind(await entries(folder.uri.fsPath)) === "legacy") legacy = true;
      }
      setContext("opentide.setup.legacyLayout", legacy);
    };
    setTimeout(() => void detectLayout(), 0);
    void ctx.runtime.ready().then(() => promptOnce(ctx));
  },
});

/** A notification once per workspace, for an empty folder or a legacy layout (SPEC §8 "Triggers"). */
async function promptOnce(ctx: FeatureContext): Promise<void> {
  const state = ctx.extension.workspaceState;
  if (!ctx.trust.isTrusted || state.get<boolean>(PROMPTED_KEY) || ctx.folders.all.length > 0) return;
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === "file");
  if (!folder || !ctx.backend.availability().available) return;
  const kind = folderKind(await entries(folder.uri.fsPath));
  if (kind !== "empty" && kind !== "legacy") return;
  await state.update(PROMPTED_KEY, true);
  if (kind === "legacy") {
    const choice = await vscode.window.showInformationMessage(
      `${folder.name} has a legacy opentide layout (Configurations/ and Objects/).`,
      "Migrate…",
      "Not Now",
    );
    if (choice === "Migrate…")
      await vscode.commands.executeCommand("opentide.setup.migrate", folder.uri.fsPath);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Create a detection repository in ${folder.name}?`,
    "Set Up…",
    "Not Now",
  );
  if (choice === "Set Up…") await vscode.commands.executeCommand("opentide.setup.open", folder.uri.fsPath);
}

/** The command tree as the wizard asks it. */
function optionSource(ctx: FeatureContext): OptionSource {
  return {
    hasCommand: (p) => ctx.capabilities.hasCommand(p),
    hasOption: (p, flag) => ctx.capabilities.hasOption(p, flag),
    choices: (p, flag) => {
      const option = ctx.capabilities.current?.option(p, flag);
      return option?.choices ?? undefined;
    },
  };
}

/** Can commands run, and does this opentide have `setup`? Says why not. */
async function ready(ctx: FeatureContext, command = "setup"): Promise<boolean> {
  if (!ctx.trust.isTrusted) {
    const choice = await vscode.window.showWarningMessage(
      "Trust this folder to set it up: setup runs opentide.",
      "Manage Workspace Trust",
    );
    if (choice) await vscode.commands.executeCommand("workbench.trust.manage");
    return false;
  }
  await ctx.runtime.ready();
  const availability = ctx.backend.availability();
  if (!availability.available) {
    const choice = await vscode.window.showWarningMessage(
      availability.code === "editor-only"
        ? "opentide.path names opentide-lsp, which cannot set up a repository. Point it at opentide."
        : "No opentide runtime to run setup with.",
      "Switch Runtime…",
    );
    if (choice) await vscode.commands.executeCommand("opentide.switchRuntime");
    return false;
  }
  await ctx.capabilities.ready();
  if (!ctx.capabilities.hasCommand(command)) {
    void vscode.window.showWarningMessage(
      `This opentide has no \`${command}\` command. Switch to a newer opentide.`,
    );
    return false;
  }
  return true;
}

async function pickFolder(): Promise<{ path: string; name: string; inWorkspace: boolean } | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file");
  const editor = vscode.window.activeTextEditor?.document.uri;
  const active = editor ? vscode.workspace.getWorkspaceFolder(editor) : undefined;
  if (active) return { path: active.uri.fsPath, name: active.name, inWorkspace: true };
  if (folders.length === 1 && folders[0])
    return { path: folders[0].uri.fsPath, name: folders[0].name, inWorkspace: true };
  if (folders.length > 1) {
    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { placeHolder: "Which folder to set up" },
    );
    return picked
      ? { path: picked.folder.uri.fsPath, name: picked.folder.name, inWorkspace: true }
      : undefined;
  }
  const chosen = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Set Up Here",
    title: "Choose a folder for the detection repository",
  });
  const uri = chosen?.[0];
  return uri ? { path: uri.fsPath, name: path.basename(uri.fsPath), inWorkspace: false } : undefined;
}

interface Session {
  readonly panel: OpentidePanel<WizardProtocol>;
  readonly folder: { path: string; name: string; inWorkspace: boolean };
  mode: SetupMode;
  support: SetupSupport;
  enabled: string[];
  step?: number;
  reviewToken?: vscode.CancellationTokenSource;
  applyToken?: vscode.CancellationTokenSource;
}

class WizardHost implements vscode.Disposable {
  private session: Session | undefined;

  constructor(private readonly ctx: FeatureContext) {}

  async open(options: { folder?: string; step?: number }): Promise<void> {
    if (this.session) {
      this.session.panel.panel.reveal();
      return;
    }
    if (!(await ready(this.ctx))) return;
    const folder = options.folder
      ? {
          path: options.folder,
          name:
            vscode.workspace.getWorkspaceFolder(vscode.Uri.file(options.folder))?.name ??
            path.basename(options.folder),
          inWorkspace: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(options.folder)) !== undefined,
        }
      : await pickFolder();
    if (!folder) return;
    const listing = await entries(folder.path);
    const mode: SetupMode = folderKind(listing) === "opentide" ? "existing" : "new";
    const panel = this.ctx.webview.createPanel<WizardProtocol>({
      viewType: "opentide.setup",
      title: mode === "new" ? "Set Up a Detection Repository" : "Set Up opentide",
      entry: "setup",
      validators: hostValidators,
      retainContextWhenHidden: true,
    });
    const session: Session = {
      panel,
      folder,
      mode,
      support: setupSupport(optionSource(this.ctx)),
      enabled: [],
      ...(options.step !== undefined ? { step: options.step } : {}),
    };
    this.session = session;
    panel.panel.onDidDispose(() => {
      session.reviewToken?.cancel();
      session.applyToken?.cancel();
      if (this.session === session) this.session = undefined;
    });
    const channel = panel.channel;
    channel.on("ready", () => this.init(session, listing));
    channel.on("review", (answers) => this.review(session, answers));
    channel.on("apply", (answers) => this.apply(session, answers));
    channel.on("copyScript", async (answers) => {
      const commands = setupCommands(answers, session.mode, session.support, session.enabled);
      await vscode.env.clipboard.writeText(script(commands, session.folder.path));
      void vscode.window.setStatusBarMessage("$(copy) Copied the setup script", 4000);
    });
    channel.on("cancel", () => session.applyToken?.cancel());
    channel.on("gitInit", async () => {
      await vscode.commands.executeCommand("git.init");
      await this.init(session, await entries(folder.path));
    });
    channel.on("openFile", async (relative) => {
      const file = path.join(session.folder.path, relative);
      if (!file.startsWith(session.folder.path)) return;
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
    });
    channel.on("close", () => panel.dispose());
  }

  private async init(session: Session, listing: readonly Entry[]): Promise<void> {
    // `info` for the capability badges and what is enabled already; the wizard works without it.
    let info: ReturnType<typeof parsePlatforms> = [];
    try {
      const result = await this.ctx.backend.run(session.folder.path, ["info"]);
      info = parsePlatforms(result.document);
    } catch (error) {
      this.ctx.log.debug(`setup: info failed: ${errorMessage(error)}`);
    }
    session.enabled = info.filter((p) => p.enabled).map((p) => p.name);
    const ids = [...new Set([...session.support.platforms, ...info.map((p) => p.name)])];
    const platforms: PlatformChoice[] = ids.map((id) => {
      const known = info.find((p) => p.name === id);
      const name = platformName(id);
      return {
        id,
        label: name.long,
        ...(name.languages ? { languages: name.languages } : {}),
        ...(known
          ? { canDeploy: known.can_deploy, canValidate: known.can_validate, canQuery: known.can_query }
          : {}),
        enabled: known?.enabled ?? false,
      };
    });
    const answers: SetupAnswers = {
      ...defaultAnswers(session.folder.name),
      ci: session.mode === "existing" ? "none" : "github",
      hooks: session.mode === "new",
      env: session.mode === "new",
    };
    const s = session.support;
    void session.panel.channel.post("init", {
      mode: session.mode,
      folderName: session.folder.name,
      answers,
      platforms,
      ciProviders: s.ciProviders,
      mcpHosts: s.mcpHosts,
      skillsHosts: s.skillsHosts,
      plugin: s.plugin,
      hooks: s.hooks,
      env: s.env,
      explorerPages: s.explorerPages,
      plan: s.plan,
      gitRepository: isGitRepository(listing),
      mcpProvided: "lm" in vscode && "registerMcpServerDefinitionProvider" in vscode.lm,
      ...(session.step !== undefined ? { startStep: session.step } : {}),
    });
  }

  private runner(session: Session): Runner {
    return async (argv, token) => {
      const result: RunResult = await this.ctx.backend.run(session.folder.path, argv, {
        ...(token ? { cancellation: token } : {}),
      });
      return { document: result.document, exitCode: result.exitCode, cancelled: result.cancelled };
    };
  }

  private async review(session: Session, answers: SetupAnswers): Promise<void> {
    session.reviewToken?.cancel();
    const source = new vscode.CancellationTokenSource();
    session.reviewToken = source;
    void session.panel.channel.post("reviewing", undefined);
    try {
      const result = await review({
        answers,
        mode: session.mode,
        support: session.support,
        enabled: session.enabled,
        run: this.runner(session),
        token: source.token,
      });
      if (!source.token.isCancellationRequested) void session.panel.channel.post("review", result);
    } catch (error) {
      void session.panel.channel.post("review", { problems: [], steps: [], error: errorMessage(error) });
    }
  }

  private async apply(session: Session, answers: SetupAnswers): Promise<void> {
    if (session.applyToken) return;
    const source = new vscode.CancellationTokenSource();
    session.applyToken = source;
    const commands = setupCommands(answers, session.mode, session.support, session.enabled);
    try {
      const progress = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "opentide setup" },
        () =>
          apply({
            commands,
            run: this.runner(session),
            onProgress: (p) => void session.panel.channel.post("progress", p),
            token: source.token,
          }),
      );
      if (!progress.ok) return;
      setContext("opentide.setup.done", true);
      const steps = progress.commands.flatMap((c) => c.steps);
      const readme = fileToOpen(steps.map((s) => ({ ...s, warnings: [] })));
      if (readme) {
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(session.folder.path, readme)), {
          preview: false,
          viewColumn: vscode.ViewColumn.One,
        });
      }
      if (!session.folder.inWorkspace) {
        const choice = await vscode.window.showInformationMessage(
          `${session.folder.name} is ready. Open it to start writing detections.`,
          "Open Folder",
        );
        if (choice)
          await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(session.folder.path));
        return;
      }
      await vscode.commands.executeCommand("opentide.sidebar.catalogue.focus");
      void this.ctx.catalog.refresh(session.folder.path, { immediate: true });
    } finally {
      session.applyToken = undefined;
      source.dispose();
    }
  }

  dispose(): void {
    this.session?.panel.dispose();
  }
}

/** A legacy layout: the `migrate objects` dry run as a list of moves, then `--apply` (SPEC §8). */
async function migrate(ctx: FeatureContext, wizard: WizardHost, folderArg?: string): Promise<void> {
  if (!(await ready(ctx, "migrate objects"))) return;
  const folder = folderArg ?? (await pickFolder())?.path;
  if (!folder) return;
  const run = (argv: string[], title: string) =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (_p, token) => ctx.backend.run(folder, argv, { cancellation: token }),
    );
  let dry: RunResult;
  try {
    dry = await run(["migrate", "objects"], "Planning the migration…");
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error));
    return;
  }
  if (dry.cancelled) return;
  const operations = Array.isArray(dry.document.operations)
    ? (dry.document.operations as { from?: unknown; to?: unknown; action?: unknown; reason?: unknown }[])
    : [];
  const moves = operations.filter((o) => o.action !== "skip");
  if (dry.exitCode !== 0 || moves.length === 0) {
    void vscode.window.showInformationMessage(
      dry.exitCode !== 0
        ? (dry.document.failure?.message ?? dry.document.message)
        : "Nothing to migrate: no legacy folder is left.",
    );
    return;
  }
  const verb = dry.document.copy === true ? "Copy" : "Move";
  const applyItem = {
    label: `$(check) ${verb} ${moves.length} folder${moves.length === 1 ? "" : "s"}`,
    apply: true,
  };
  const picked = await vscode.window.showQuickPick(
    [
      applyItem,
      { label: "Planned", kind: vscode.QuickPickItemKind.Separator, apply: false },
      ...moves.map((o) => ({
        label: `${String(o.from)} → ${String(o.to)}`,
        description: String(o.action),
        apply: false,
      })),
      { label: "Skipped", kind: vscode.QuickPickItemKind.Separator, apply: false },
      ...operations
        .filter((o) => o.action === "skip")
        .map((o) => ({
          label: `${String(o.from)}`,
          description: String(o.reason ?? "skipped"),
          apply: false,
        })),
    ],
    {
      title: `Migrate ${path.basename(folder)}: opentide migrate objects`,
      placeHolder: "Review the moves, then apply",
    },
  );
  if (!picked?.apply) return;
  const confirm = await vscode.window.showWarningMessage(
    `${verb} ${moves.length} folder${moves.length === 1 ? "" : "s"} into objects/ and .opentide/?`,
    {
      modal: true,
      detail: "opentide migrate objects --apply. Existing non-empty folders are never overwritten.",
    },
    verb,
  );
  if (confirm !== verb) return;
  const applied = await Promise.resolve(run(["migrate", "objects", "--apply"], "Migrating…")).catch(
    (error: unknown) => {
      void vscode.window.showErrorMessage(errorMessage(error));
      return undefined;
    },
  );
  if (!applied || applied.cancelled) return;
  if (applied.exitCode !== 0) {
    void vscode.window.showErrorMessage(applied.document.failure?.message ?? applied.document.message);
    return;
  }
  setContext("opentide.setup.legacyLayout", false);
  const next = await vscode.window.showInformationMessage(
    "Migrated. Add what the repository still lacks: platforms, CI, agents.",
    "Open Setup…",
  );
  if (next) await wizard.open({ folder });
}

/** A walkthrough button: the owning feature's command (every feature ships in this extension). */
async function walkthroughStep(ctx: FeatureContext, step: string): Promise<void> {
  const command = walkthroughCommand(step);
  if (!command) return;
  const commands = await vscode.commands.getCommands(true);
  if (commands.includes(command)) {
    await vscode.commands.executeCommand(command);
    return;
  }
  // The feature failed to activate (logged), so its command is not registered.
  const choice = await vscode.window.showWarningMessage(
    "This step's feature did not start. The opentide output says why.",
    "Show Output",
  );
  if (choice) ctx.log.show();
}
