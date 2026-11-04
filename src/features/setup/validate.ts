// What the setup wizard checks before Review, and each step's state in the stepper (done, invalid, current,
// to do). Shared by the host and webview/setup: no vscode, no DOM, no node.
import type { SetupAnswers, SetupMode } from "./protocol";

/** Problems that stop Review, per step (1-based, as the stepper numbers them). */
export function validateAnswers(
  answers: SetupAnswers,
  mode: SetupMode,
  enabled: readonly string[] = [],
): { step: number; message: string }[] {
  const problems: { step: number; message: string }[] = [];
  if (mode === "new" && !answers.name.trim())
    problems.push({ step: 1, message: "Give the repository a name." });
  if (mode === "new" && answers.platforms.length === 0)
    problems.push({ step: 2, message: "Pick at least one platform." });
  if (answers.pythonVersion.trim() && !/^3\.\d{1,2}$/.test(answers.pythonVersion.trim()))
    problems.push({ step: 3, message: "The Python version looks like 3.12." });
  if (answers.defaultBranch.trim() && /[\s~^:?*[\\]/.test(answers.defaultBranch.trim()))
    problems.push({ step: 3, message: "That is not a valid branch name." });
  if (mode === "existing" && nothingToDo(answers, enabled))
    problems.push({ step: 2, message: "Pick something to add: a platform, CI, an agent or an extra." });
  return problems;
}

function nothingToDo(answers: SetupAnswers, enabled: readonly string[]): boolean {
  return (
    answers.platforms.every((p) => enabled.includes(p)) &&
    answers.ci === "none" &&
    answers.mcp.length === 0 &&
    answers.skills.length === 0 &&
    !answers.plugin &&
    !answers.hooks &&
    !answers.env
  );
}

/** The wizard's steps (0-based): Repository, Platforms, CI, Agents, Extras, Review. */
export const STEP_NAMES = ["Repository", "Platforms", "CI", "Agents", "Extras", "Review"] as const;

export type StepState = "done" | "current" | "invalid" | "todo";

/**
 * Each visible step's state: the current one; a step with a problem once visited (or once Review was
 * reached) is invalid; a visited step without one is done; the rest are to do.
 */
export function stepStates(options: {
  readonly answers: SetupAnswers;
  readonly mode: SetupMode;
  readonly enabled?: readonly string[];
  readonly steps: readonly number[];
  readonly current: number;
  readonly visited: ReadonlySet<number>;
  /** Apply finished: every step is done. */
  readonly applied?: boolean;
}): { step: number; state: StepState }[] {
  const problems = validateAnswers(options.answers, options.mode, options.enabled ?? []);
  const reviewed = options.visited.has(5);
  return options.steps.map((step) => {
    if (options.applied) return { step, state: "done" };
    if (step === options.current) return { step, state: "current" };
    const invalid = problems.some((p) => p.step - 1 === step);
    if (invalid && (options.visited.has(step) || reviewed)) return { step, state: "invalid" };
    if (options.visited.has(step) && step !== 5) return { step, state: "done" };
    return { step, state: "todo" };
  });
}

/** The inline message for a field, once the person has touched it or gone past its step. */
export function fieldError(
  field: "name" | "platforms" | "pythonVersion" | "defaultBranch",
  answers: SetupAnswers,
  mode: SetupMode,
): string | undefined {
  switch (field) {
    case "name":
      return mode === "new" && !answers.name.trim() ? "Give the repository a name." : undefined;
    case "platforms":
      return mode === "new" && answers.platforms.length === 0 ? "Pick at least one platform." : undefined;
    case "pythonVersion":
      return answers.pythonVersion.trim() && !/^3\.\d{1,2}$/.test(answers.pythonVersion.trim())
        ? "The Python version looks like 3.12."
        : undefined;
    case "defaultBranch":
      return answers.defaultBranch.trim() && /[\s~^:?*[\\]/.test(answers.defaultBranch.trim())
        ? "That is not a valid branch name."
        : undefined;
  }
}
