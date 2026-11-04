// The `opentide` task provider (SPEC §11): validate, lint, generate, dry-run deploy and query for tasks.json,
// keybindings and pre-launch chains, with `$opentide` filling Problems. Glue over tasks.ts.
import * as vscode from "vscode";
import type { FeatureContext } from "../../core/context";
import { cliCommand, hasCli } from "../../core/runtime/types";
import { httpProxy } from "../../core/services/settings";
import { DRY_RUN } from "./safety";
import {
  isTaskDefinition,
  type OpentideTaskDefinition,
  PROBLEM_MATCHER,
  providedTasks,
  taskEnv,
  taskName,
  taskPlan,
  whenTaskReady,
} from "./tasks";

export class OpentideTaskProvider implements vscode.TaskProvider {
  constructor(private readonly ctx: FeatureContext) {}

  async provideTasks(): Promise<vscode.Task[]> {
    if (!this.ctx.trust.isTrusted) return [];
    await whenTaskReady(this.readiness());
    if (!hasCli(this.ctx.runtime.current)) return [];
    const tasks: vscode.Task[] = [];
    for (const folder of this.ctx.folders.all) {
      for (const provided of providedTasks((p) => this.ctx.capabilities.hasCommand(p))) {
        const task = await this.build(provided.definition, folder.folder);
        if (provided.group === "build") task.group = vscode.TaskGroup.Build;
        if (provided.group === "test") task.group = vscode.TaskGroup.Test;
        tasks.push(task);
      }
    }
    return tasks;
  }

  async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
    if (!isTaskDefinition(task.definition)) return undefined;
    await whenTaskReady(this.readiness());
    const scope = typeof task.scope === "object" ? task.scope : vscode.TaskScope.Workspace;
    const resolved = await this.build(task.definition, scope, task.definition);
    resolved.group = task.group;
    return resolved;
  }

  private readiness() {
    return {
      trusted: this.ctx.trust.isTrusted,
      runtime: this.ctx.runtime,
      capabilities: this.ctx.capabilities,
    };
  }

  /** A task for a definition: the command, its dry run for a deploy or share, or a refusal that says why. */
  private async build(
    definition: OpentideTaskDefinition,
    scope: vscode.WorkspaceFolder | vscode.TaskScope.Workspace,
    original: vscode.TaskDefinition = definition,
  ): Promise<vscode.Task> {
    const name = taskName(definition);
    const refuse = (message: string) =>
      new vscode.Task(original, scope, name, "opentide", explanation(message), []);
    if (!this.ctx.trust.isTrusted) return refuse("Restricted Mode: trust this folder to run opentide tasks.");
    const runtime = this.ctx.runtime.current;
    if (!hasCli(runtime))
      return refuse("No opentide runtime: install opentide in the workspace, or set opentide.path.");
    const folder =
      typeof scope === "object"
        ? scope.uri.fsPath
        : (this.ctx.folders.all[0]?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    if (!folder) return refuse("Open a folder to run opentide tasks in.");
    const tree = this.ctx.capabilities.current;
    const argv = [...definition.command.trim().split(/\s+/), ...(definition.args ?? [])];
    const { path: commandPath } = tree?.commandPathOf(argv) ?? { path: definition.command };
    const classification = this.ctx.capabilities.classify(argv);
    const plan = taskPlan(definition, classification, tree?.hasOption(commandPath, DRY_RUN) ?? false);
    if (plan.kind === "refuse") return refuse(plan.reason);
    const credentials = classification.contactsTenant ? await this.ctx.backend.credentialEnv(folder) : {};
    const { command, args } = cliCommand(runtime, plan.argv);
    const task = new vscode.Task(
      original,
      scope,
      plan.kind === "confirm" && plan.dryRunAdded ? `${name} (dry run)` : name,
      "opentide",
      new vscode.ProcessExecution(command, args, {
        cwd: folder,
        env: taskEnv(folder, runtime.env, httpProxy(), credentials),
      }),
      [PROBLEM_MATCHER],
    );
    task.detail = plan.argv.join(" ");
    return task;
  }
}

/** A task that prints why it cannot run, and fails. */
function explanation(message: string): vscode.CustomExecution {
  return new vscode.CustomExecution(async () => {
    const write = new vscode.EventEmitter<string>();
    const close = new vscode.EventEmitter<number>();
    return {
      onDidWrite: write.event,
      onDidClose: close.event,
      open: () => {
        write.fire(`opentide: ${message}\r\n`);
        close.fire(1);
      },
      close: () => undefined,
    };
  });
}
