// Running a command for the runner and the palette commands: availability, the D6 policy, the tenants a
// command reaches, the background run with progress, and its result. Glue; the logic is in the modules it
// imports.
import * as path from "node:path";
import * as vscode from "vscode";
import type { RunRecord, RunResult } from "../../core/backend/backend";
import { BackendError } from "../../core/backend/types";
import type { Classification } from "../../core/capabilities/classification";
import type { FeatureContext } from "../../core/context";
import { displayArgv } from "../../core/runtime/env";
import { cliCommand, hasCli } from "../../core/runtime/types";
import { httpProxy } from "../../core/services/settings";
import { ProgressModel } from "./progress";
import {
  changedFiles,
  commandLabel,
  explainCodes,
  isExplainable,
  renderDocument,
  resultPath,
  summarize,
} from "./result";
import { RESULT_SCHEME, type ResultStore } from "./resultStore";
import { confirmMessage, DRY_RUN, planRun, platformsOf, type RunPlan, selectedRuleCount } from "./safety";
import { PROBLEM_MATCHER, TASK_TYPE, taskEnv } from "./tasks";
import { describeReach, missingVariables, type PlatformReach, reachOf } from "./tenants";

export interface BackgroundOptions {
  /** Open the result document when the run ends (the generic runner). */
  readonly open?: boolean;
  /** No notification when the run succeeds (a palette command shows its own result). */
  readonly quietSuccess?: boolean;
  /** The notification's title; default: the command line. */
  readonly title?: string;
}

export interface Ran {
  readonly result: RunResult;
  readonly uri: vscode.Uri;
}

const MESSAGES = {
  untrusted: "Restricted Mode: trust this folder to run opentide commands.",
  "no-runtime": "No opentide runtime. Install opentide in the workspace, or set opentide.path.",
  "editor-only": "opentide.path names opentide-lsp, which runs no commands. Point it at opentide.",
} as const;

export class Runner implements vscode.Disposable {
  private readonly codes = new Map<string, Promise<Set<string>>>();
  private terminalRunId = -1;

  constructor(
    private readonly ctx: FeatureContext,
    readonly results: ResultStore,
  ) {}

  /** Whether commands can run; says why not, with the next action, when they cannot. */
  async ensureAvailable(): Promise<boolean> {
    if (!this.ctx.trust.isTrusted) {
      void this.explainUnavailable("untrusted");
      return false;
    }
    await this.ctx.runtime.ready();
    const availability = this.ctx.backend.availability();
    if (availability.available) return true;
    void this.explainUnavailable(availability.code);
    return false;
  }

  private async explainUnavailable(code: keyof typeof MESSAGES): Promise<void> {
    const action = code === "untrusted" ? "Manage Workspace Trust" : "Switch Runtime…";
    const picked = await vscode.window.showWarningMessage(MESSAGES[code], action);
    if (picked === "Manage Workspace Trust") await vscode.commands.executeCommand("workbench.trust.manage");
    else if (picked === "Switch Runtime…") await vscode.commands.executeCommand("opentide.switchRuntime");
  }

  /** The folder a run is about: an opentide folder (asked when several), else the first workspace folder. */
  async folder(placeHolder?: string): Promise<string | undefined> {
    if (this.ctx.folders.all.length > 0) return (await this.ctx.folders.pick(placeHolder))?.path;
    const first = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === "file");
    if (first) return first.uri.fsPath;
    void vscode.window.showWarningMessage("Open a folder to run opentide commands in.");
    return undefined;
  }

  /** The active opentide lacks a command: say what is needed instead of failing. */
  needs(command: string): void {
    void vscode.window
      .showWarningMessage(
        `This needs \`opentide ${command}\`, which the active opentide does not have. Update opentide.`,
        "Switch Runtime…",
      )
      .then((picked) => {
        if (picked) void vscode.commands.executeCommand("opentide.switchRuntime");
      });
  }

  classify(argv: readonly string[]): Classification & { readonly unclassified?: true } {
    return this.ctx.capabilities.classify(argv);
  }

  /** The D6 plan for argv. */
  plan(argv: readonly string[]): RunPlan {
    const tree = this.ctx.capabilities.current;
    const { path: commandPath } = tree?.commandPathOf(argv) ?? { path: argv[0] ?? "" };
    return planRun(argv, commandPath, this.classify(argv), tree?.hasOption(commandPath, DRY_RUN) ?? false);
  }

  /** The platforms and tenants a command reaches, from `opentide info` (empty when it cannot tell). */
  async reach(folder: string, argv: readonly string[]): Promise<PlatformReach[]> {
    try {
      const { document } = await this.ctx.backend.run(folder, ["info"], { credentials: false });
      return reachOf(document, platformsOf(argv));
    } catch {
      return [];
    }
  }

  /** Variables the tenants need that nothing sets. */
  async missingCredentials(folder: string, reach: readonly PlatformReach[]): Promise<string[]> {
    const known = new Set(Object.keys(await this.ctx.backend.credentialEnv(folder)));
    return missingVariables(reach, known, process.env);
  }

  /** Ask for a credential and store it in SecretStorage for this folder. */
  async setCredential(folder: string, name: string): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      title: `Set ${name}`,
      prompt: `Stored in VS Code's secret storage for ${path.basename(folder)}, and passed only to commands that contact a tenant.`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!value) return false;
    await this.ctx.credentials.set(folder, name, value);
    return true;
  }

  /**
   * Apply the D6 policy: the argv to run (possibly the dry run), or undefined when nothing runs. A deploy
   * or share asks first, in a modal naming its platforms, tenants and rule count.
   */
  async confirm(folder: string, argv: readonly string[]): Promise<readonly string[] | undefined> {
    const plan = this.plan(argv);
    if (plan.kind === "run") return plan.argv;
    if (plan.kind === "refuse") {
      const actions = plan.alternative
        ? ["Copy Command", plan.alternative.replace(/^opentide /, "Run ")]
        : ["Copy Command"];
      const picked = await vscode.window.showWarningMessage(plan.reason, ...actions);
      if (picked === "Copy Command") await vscode.env.clipboard.writeText(commandLabel(displayArgv(argv)));
      else if (picked && plan.alternative) return plan.alternative.split(" ").slice(1);
      return undefined;
    }
    const reach = await this.reach(folder, plan.argv);
    const platforms = platformsOf(plan.argv);
    const lines = [
      `Platforms and tenants: ${describeReach(reach, platforms)}`,
      `Rules: ${this.ruleCount(folder, plan.argv, reach)}`,
      "",
      commandLabel(displayArgv(plan.argv)),
    ];
    const picked = await vscode.window.showWarningMessage(
      confirmMessage(plan),
      { modal: true, detail: lines.join("\n") },
      "Run Dry Run",
    );
    return picked === "Run Dry Run" ? plan.argv : undefined;
  }

  /** "3", "12 enabled for sentinel", or the default selection, for the confirmation. */
  private ruleCount(folder: string, argv: readonly string[], reach: readonly PlatformReach[]): string {
    const selected = selectedRuleCount(argv);
    if (selected !== undefined) return String(selected);
    const catalog = this.ctx.catalog.get(folder).catalog;
    const platforms = reach.map((r) => r.platform);
    if (argv.includes("--all") && catalog) {
      const count = catalog.objects.filter(
        (o) =>
          o.type === "rule" &&
          o.platforms.some((p) => p.enabled && (platforms.length === 0 || platforms.includes(p.id))),
      ).length;
      return `${count} (every rule enabled for ${platforms.join(", ") || "a platform"})`;
    }
    if (argv.includes("--all")) return "every rule";
    return argv[0] === "deploy"
      ? "the rules changed since the default branch"
      : "the objects the command selects";
  }

  /** Run in the background (`--json`), with progress and cancellation; show and keep the result. */
  async background(
    folder: string,
    argv: readonly string[],
    options: BackgroundOptions = {},
  ): Promise<Ran | undefined> {
    const classification = this.classify(argv);
    const written = new Set<string>();
    const watcher = classification.writes
      ? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), "**/*"))
      : undefined;
    if (watcher) {
      const add = (uri: vscode.Uri) => written.add(uri.fsPath);
      watcher.onDidCreate(add);
      watcher.onDidChange(add);
    }
    const label = commandLabel(displayArgv(argv));
    let result: RunResult;
    try {
      result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: options.title ?? label,
          cancellable: true,
        },
        (progress, token) => {
          const model = new ProgressModel();
          return this.ctx.backend.run(folder, argv, {
            cancellation: token,
            onProgress: (event) => {
              const report = model.report(event);
              if (report) progress.report(report);
            },
          });
        },
      );
    } catch (error) {
      watcher?.dispose();
      this.showError(error, label);
      return undefined;
    }
    // File events arrive shortly after the process wrote.
    if (watcher) await new Promise((resolve) => setTimeout(resolve, 300));
    watcher?.dispose();
    const uri = this.store(result);
    if (options.open) await this.open(uri);
    void this.notify(result, uri, folder, changedFiles(folder, written), options);
    return { result, uri };
  }

  private store(result: RunResult): vscode.Uri {
    const resultUri = vscode.Uri.from({
      scheme: RESULT_SCHEME,
      path: resultPath(this.results.id(), result.argvDisplay),
    });
    this.results.set(resultUri.path, renderDocument(result.document));
    return resultUri;
  }

  /** Open a read-only document of the store. */
  async open(uri: vscode.Uri, language?: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    if (language && document.languageId !== language)
      await vscode.languages.setTextDocumentLanguage(document, language);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  /** A Markdown page of the store, in the Markdown preview when there is one. */
  async openMarkdown(name: string, text: string): Promise<void> {
    const uri = vscode.Uri.from({ scheme: RESULT_SCHEME, path: `/${this.results.id()}/${name}.md` });
    this.results.set(uri.path, text, false);
    try {
      await vscode.commands.executeCommand("markdown.showPreview", uri);
    } catch {
      await this.open(uri, "markdown");
    }
  }

  private async notify(
    result: RunResult,
    uri: vscode.Uri,
    folder: string,
    files: readonly string[],
    options: BackgroundOptions,
  ): Promise<void> {
    const summary = summarize(result);
    if (summary.level !== "error" && options.quietSuccess && files.length === 0) return;
    const actions: string[] = [];
    if (!options.open) actions.push("Show Result");
    if (files.length > 0) actions.push(files.length === 1 ? "Open File" : `Show ${files.length} Files`);
    const explainable =
      summary.failureCode !== undefined && isExplainable(summary.failureCode, await this.explainable(folder));
    if (explainable) actions.push("Explain");
    if (summary.level === "error") actions.push("Show Output");
    const text =
      files.length > 0
        ? `${summary.text} · ${files.length} file${files.length === 1 ? "" : "s"} changed`
        : summary.text;
    const show =
      summary.level === "error"
        ? vscode.window.showErrorMessage
        : summary.level === "warning"
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
    const picked = await show(text, ...actions);
    if (picked === "Show Result") await this.open(uri);
    else if (picked === "Explain" && summary.failureCode)
      await vscode.commands.executeCommand("opentide.runner.explain", summary.failureCode);
    else if (picked === "Show Output") this.ctx.log.show();
    else if (picked && files.length > 0) await this.pickFile(folder, files);
  }

  private async pickFile(folder: string, files: readonly string[]): Promise<void> {
    const file =
      files.length === 1
        ? files[0]
        : (
            await vscode.window.showQuickPick(
              files.map((f) => ({ label: path.posix.basename(f), description: f, file: f })),
              { placeHolder: "Files the command changed" },
            )
          )?.file;
    if (file) await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder, file)));
  }

  /** The codes `opentide explain` explains, read once per opentide version. */
  explainable(folder: string): Promise<Set<string>> {
    const version = this.ctx.runtime.current?.version ?? "";
    let codes = this.codes.get(version);
    if (!codes) {
      codes = this.ctx.capabilities.hasCommand("explain")
        ? this.ctx.backend
            .run(folder, ["explain"], { credentials: false })
            .then((r) => explainCodes(r.document))
            .catch(() => new Set<string>())
        : Promise.resolve(new Set<string>());
      this.codes.set(version, codes);
    }
    return codes;
  }

  showError(error: unknown, label: string): void {
    if (
      error instanceof BackendError &&
      (error.code === "untrusted" || error.code === "no-runtime" || error.code === "editor-only")
    ) {
      void this.explainUnavailable(error.code);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`${label}: ${message}`, "Show Output").then((picked) => {
      if (picked) this.ctx.log.show();
    });
  }

  /**
   * Run in a terminal (human output, colours, prompts) as an `opentide` task, so `$opentide` fills
   * Problems. Recorded in Activity like a background run.
   */
  async terminal(folder: string, argv: readonly string[]): Promise<void> {
    const runtime = this.ctx.runtime.current;
    if (!hasCli(runtime)) return;
    const classification = this.classify(argv);
    const credentials = classification.contactsTenant ? await this.ctx.backend.credentialEnv(folder) : {};
    const { command, args } = cliCommand(runtime, argv);
    const scope = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folder)) ?? vscode.TaskScope.Workspace;
    const task = new vscode.Task(
      { type: TASK_TYPE, command: argv.join(" ") },
      scope,
      argv.join(" "),
      "opentide",
      new vscode.ProcessExecution(command, args, {
        cwd: folder,
        env: taskEnv(folder, runtime.env, httpProxy(), credentials),
      }),
      [PROBLEM_MATCHER],
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
    };
    const id = this.terminalRunId--;
    const argvDisplay = commandLabel(displayArgv(argv, Object.values(credentials)));
    const startedAt = Date.now();
    const base = { id, folder, argv, argvDisplay, startedAt, classification } as const;
    const record = (run: Omit<RunRecord, keyof typeof base>) => this.ctx.activity.record({ ...base, ...run });
    let execution: vscode.TaskExecution;
    try {
      execution = await vscode.tasks.executeTask(task);
    } catch (error) {
      this.showError(error, argvDisplay);
      return;
    }
    record({ status: "running" });
    this.ctx.log.info(`▶ ${argvDisplay}  (terminal, in ${folder})`);
    const done = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution !== execution) return;
      done.dispose();
      const exitCode = event.exitCode;
      record({
        status:
          exitCode === undefined
            ? "cancelled"
            : exitCode === 0
              ? "ok"
              : exitCode === 130
                ? "cancelled"
                : "failed",
        durationMs: Date.now() - startedAt,
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
    });
    this.ctx.subscriptions.push(done);
  }

  dispose(): void {
    this.codes.clear();
  }
}
