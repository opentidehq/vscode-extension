// Review and Apply: the wizard's two actions, each a sequence of real `opentide setup` commands
// (SPEC §8). vscode-free: the runner is injected (the backend in index.ts).
import type { Envelope } from "../../core/backend/types";
import { displayArgv } from "../../core/runtime/env";
import type { CancellationToken } from "../../core/util/cancellation";
import {
  canPlan,
  planArgv,
  type SetupAnswers,
  type SetupCommand,
  type SetupMode,
  type SetupSupport,
  setupCommands,
  validateAnswers,
} from "./answers";
import { appliedSteps, mergePlans, type PlannedStep, parsePlan } from "./plan";
import type { ApplyProgress, CommandStatus, Review, ReviewStep } from "./protocol";

export interface RunOutcome {
  readonly document: Envelope;
  readonly exitCode: number;
  readonly cancelled: boolean;
}

export type Runner = (argv: readonly string[], token?: CancellationToken) => Promise<RunOutcome>;

/** `opentide setup …` without `--json`: what a person types. */
export function commandLine(argv: readonly string[]): string {
  return `opentide ${displayArgv(argv).replace(/^opentide --json /, "")}`;
}

export const NO_PLAN_NOTE =
  "This opentide cannot list the files before it writes them, so Review says what each command does. " +
  "An opentide whose `setup` has `--plan` lists every file.";

function failureOf(document: Envelope): { message: string; fix?: string } {
  const failure = document.failure;
  const next = document.next_actions.find(
    (action): action is { command: string } =>
      typeof action === "object" &&
      action !== null &&
      typeof (action as { command?: unknown }).command === "string",
  );
  const fix = failure?.suggestion ?? next?.command;
  return { message: failure?.message ?? document.message ?? "Failed", ...(fix ? { fix } : {}) };
}

export async function review(options: {
  answers: SetupAnswers;
  mode: SetupMode;
  support: SetupSupport;
  enabled: readonly string[];
  run: Runner;
  token?: CancellationToken;
}): Promise<Review> {
  const { answers, mode, support, enabled } = options;
  const problems = validateAnswers(answers, mode, enabled);
  const commands = setupCommands(answers, mode, support, enabled);
  if (problems.length > 0)
    return {
      problems,
      steps: commands.map((c) => ({ command: commandLine(c.argv), summary: c.summary, warnings: [] })),
    };
  const steps: ReviewStep[] = [];
  const plans: { steps: PlannedStep[]; warnings: string[] }[] = [];
  let planned = false;
  let unplanned = false;
  for (const command of commands) {
    if (!canPlan(command, support)) {
      unplanned = true;
      steps.push({ command: commandLine(command.argv), summary: command.summary, warnings: [] });
      continue;
    }
    const result = await options.run(planArgv(command), options.token);
    if (result.cancelled) return { problems: [], steps, error: "Cancelled." };
    const plan = parsePlan(result.document);
    if (!plan) {
      const failure = failureOf(result.document);
      return {
        problems: [],
        steps,
        error: `${commandLine(planArgv(command))} failed: ${failure.message}${failure.fix ? ` ${failure.fix}` : ""}`,
      };
    }
    planned = true;
    const warnings = Array.isArray(result.document.warnings)
      ? (result.document.warnings as unknown[]).filter((w): w is string => typeof w === "string")
      : [];
    plans.push({ steps: plan, warnings });
    steps.push({
      command: commandLine(command.argv),
      summary: command.summary,
      files: plan.map((s) => ({ step: s.step, files: s.files })),
      warnings: [...new Set([...warnings, ...plan.flatMap((s) => s.warnings)])],
    });
  }
  const merged = planned ? mergePlans(plans) : undefined;
  return {
    problems: [],
    steps,
    ...(unplanned ? { note: NO_PLAN_NOTE } : {}),
    ...(merged ? { totals: merged.summary } : {}),
  };
}

/** Run the commands in order with `--yes`; stop at the first that fails. */
export async function apply(options: {
  commands: readonly SetupCommand[];
  run: Runner;
  onProgress: (progress: ApplyProgress) => void;
  token?: CancellationToken;
}): Promise<ApplyProgress> {
  const rows: {
    command: string;
    status: CommandStatus;
    steps: { step: string; message: string; files: string[] }[];
    failure?: { message: string; fix?: string };
  }[] = options.commands.map((c) => ({ command: commandLine(c.argv), status: "pending", steps: [] }));
  const snapshot = (done: boolean, ok: boolean): ApplyProgress => ({
    commands: rows.map((r) => ({ ...r, steps: [...r.steps] })),
    done,
    ok,
  });
  for (const [index, command] of options.commands.entries()) {
    const row = rows[index];
    if (!row) continue;
    if (options.token?.isCancellationRequested) {
      row.status = "cancelled";
      return finish(false);
    }
    row.status = "running";
    options.onProgress(snapshot(false, false));
    let result: RunOutcome;
    try {
      result = await options.run(command.argv, options.token);
    } catch (error) {
      row.status = "failed";
      row.failure = { message: error instanceof Error ? error.message : String(error) };
      return finish(false);
    }
    row.steps = appliedSteps(result.document, command.step).map((s) => ({
      step: s.step,
      message: s.message,
      files: [...s.files],
    }));
    if (result.cancelled) {
      row.status = "cancelled";
      return finish(false);
    }
    if (result.exitCode !== 0) {
      row.status = "failed";
      row.failure = failureOf(result.document);
      return finish(false);
    }
    row.status = "ok";
    options.onProgress(snapshot(false, false));
  }
  return finish(true);

  function finish(ok: boolean): ApplyProgress {
    const progress = snapshot(true, ok);
    options.onProgress(progress);
    return progress;
  }
}
