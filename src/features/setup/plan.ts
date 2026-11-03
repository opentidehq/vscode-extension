// `setup --plan` (opentide#751) and `setup --yes` documents, as Review and Apply show them. vscode-free.

export type FileAction = "create" | "merge" | "skip";

export interface PlannedFile {
  readonly path: string;
  readonly action: FileAction;
}

export interface PlannedStep {
  readonly step: string;
  readonly files: readonly PlannedFile[];
  readonly warnings: readonly string[];
}

export interface Plan {
  readonly steps: readonly PlannedStep[];
  readonly warnings: readonly string[];
  readonly summary: { readonly create: number; readonly merge: number; readonly skip: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const ACTIONS: readonly FileAction[] = ["create", "merge", "skip"];

/** The steps of one `setup … --plan` document; undefined when it is not a plan. */
export function parsePlan(document: unknown): PlannedStep[] | undefined {
  if (!isRecord(document) || document.plan !== true || !Array.isArray(document.steps)) return undefined;
  return document.steps.filter(isRecord).map((step) => ({
    step: typeof step.step === "string" ? step.step : "",
    files: (Array.isArray(step.files) ? step.files : [])
      .filter(isRecord)
      .flatMap((file): PlannedFile[] =>
        typeof file.path === "string" && ACTIONS.includes(file.action as FileAction)
          ? [{ path: file.path, action: file.action as FileAction }]
          : [],
      ),
    warnings: strings(step.warnings),
  }));
}

/** Several plans (an existing repository plans one subcommand at a time) as one. */
export function mergePlans(
  plans: readonly { steps: readonly PlannedStep[]; warnings?: readonly string[] }[],
): Plan {
  const steps = plans.flatMap((p) => p.steps);
  const warnings = [
    ...new Set([...plans.flatMap((p) => p.warnings ?? []), ...steps.flatMap((s) => s.warnings)]),
  ];
  const count = (action: FileAction) =>
    steps.reduce((n, s) => n + s.files.filter((f) => f.action === action).length, 0);
  return {
    steps,
    warnings,
    summary: { create: count("create"), merge: count("merge"), skip: count("skip") },
  };
}

/** Files Apply writes, in order, each once: what Review promises (`create` and `merge`). */
export function writtenFiles(plan: Plan): string[] {
  const out: string[] = [];
  for (const step of plan.steps)
    for (const file of step.files)
      if (file.action !== "skip" && !out.includes(file.path)) out.push(file.path);
  return out;
}

/** One step of a `setup --yes` result, as it completed. */
export interface AppliedStep {
  readonly step: string;
  readonly message: string;
  /** Files it wrote, relative to the repository. */
  readonly files: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * The steps of a `setup` (or `setup <sub>`) document. `setup` lists `steps[]`; a subcommand is one step
 * with its own `files`.
 */
export function appliedSteps(document: unknown, step: string): AppliedStep[] {
  if (!isRecord(document)) return [];
  const one = (raw: Record<string, unknown>, name: string): AppliedStep => ({
    step: typeof raw.step === "string" ? raw.step : name,
    message: typeof raw.message === "string" ? raw.message : "",
    files: [...strings(raw.files), ...strings(raw.platform_files)],
    warnings: strings(raw.warnings),
  });
  if (Array.isArray(document.steps)) return document.steps.filter(isRecord).map((s) => one(s, step));
  return [one(document, step)];
}

/** `README.md` if a step wrote it, else the first file written. */
export function fileToOpen(steps: readonly AppliedStep[]): string | undefined {
  const files = steps.flatMap((s) => s.files);
  return files.find((f) => f.toLowerCase() === "readme.md") ?? files[0];
}
