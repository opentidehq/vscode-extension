// The `opentide` task type (SPEC §11): which tasks the provider offers, the argv a definition runs, and its
// environment. vscode-free; index.ts turns these into vscode.Task objects.
import type { Classification } from "../../core/capabilities/classification";
import { planRun, type RunPlan } from "./safety";

export const TASK_TYPE = "opentide";
export const PROBLEM_MATCHER = "$opentide";

/** `contributes.taskDefinitions`: `{ "type": "opentide", "command": "validate", "args": ["--strict"] }`. */
export interface OpentideTaskDefinition {
  readonly type: typeof TASK_TYPE;
  /** A command path: `validate`, `validate query`, `generate docs`. */
  readonly command: string;
  readonly args?: readonly string[];
}

export interface ProvidedTask {
  readonly name: string;
  readonly definition: OpentideTaskDefinition;
  readonly group?: "build" | "test";
  /** Whether the command's output carries code frames for `$opentide`. */
  readonly problems: boolean;
}

/** What the provider lists for each folder, when the active opentide has the command (SPEC §11). */
const PROVIDED: readonly ProvidedTask[] = [
  { name: "validate", definition: { type: TASK_TYPE, command: "validate" }, group: "test", problems: true },
  { name: "lint", definition: { type: TASK_TYPE, command: "lint" }, group: "test", problems: true },
  { name: "generate", definition: { type: TASK_TYPE, command: "generate" }, group: "build", problems: false },
  {
    name: "deploy --dry-run",
    definition: { type: TASK_TYPE, command: "deploy", args: ["--dry-run"] },
    problems: false,
  },
  {
    name: "validate query",
    definition: { type: TASK_TYPE, command: "validate query" },
    problems: true,
  },
];

export function providedTasks(hasCommand: (path: string) => boolean): ProvidedTask[] {
  return PROVIDED.filter((task) => hasCommand(task.definition.command));
}

export function isTaskDefinition(value: unknown): value is OpentideTaskDefinition {
  if (typeof value !== "object" || value === null) return false;
  const { type, command, args } = value as { type?: unknown; command?: unknown; args?: unknown };
  return (
    type === TASK_TYPE &&
    typeof command === "string" &&
    command.trim().length > 0 &&
    (args === undefined || (Array.isArray(args) && args.every((arg) => typeof arg === "string")))
  );
}

/** `opentide <argv>` for a definition: the command path's words, then its args. */
export function taskArgv(definition: OpentideTaskDefinition): string[] {
  return [...definition.command.trim().split(/\s+/), ...(definition.args ?? [])];
}

/** The task's name in the Run Task list: `validate`, `deploy --dry-run`. */
export function taskName(definition: OpentideTaskDefinition): string {
  return taskArgv(definition).join(" ");
}

/**
 * What a task definition may run. A deploy or share runs as its dry run (D6: a tasks.json entry cannot
 * deploy either); one without a dry run is refused.
 */
export function taskPlan(
  definition: OpentideTaskDefinition,
  classification: Classification,
  hasDryRun: boolean,
): RunPlan {
  const argv = taskArgv(definition);
  return planRun(argv, definition.command.trim().split(/\s+/).join(" "), classification, hasDryRun);
}

/**
 * The environment of a task (human output in a terminal). `COLUMNS` keeps code frames whole (opentide wraps
 * messages and shortens paths to the terminal's width, which `$opentide` could not read), and
 * `OPENTIDE_LINKS=none` leaves out OSC 8 links, which the terminal finds itself.
 */
export function taskEnv(
  folder: string,
  runtimeEnv: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ...runtimeEnv,
    OPENTIDE_REPO_ROOT: folder,
    OPENTIDE_LINKS: "none",
    COLUMNS: "4096",
    ...extra,
  };
}
