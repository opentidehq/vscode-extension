// The status bar text, as pure functions. vscode-free.
import type { RepoPin } from "./runtime/pins";
import { ENGINE_STATUS, type Runtime } from "./runtime/types";

export interface ProblemCounts {
  readonly errors: number;
  readonly warnings: number;
}

export interface StatusModel {
  readonly runtime: Runtime | undefined;
  readonly resolving: boolean;
  readonly pin: RepoPin | undefined;
  readonly counts: ProblemCounts;
  readonly trusted: boolean;
  /** The warm backend (`opentide serve`) is running. */
  readonly serve?: boolean;
}

/** `$(shield) 0.21.0 $(zap) ✗ 2 ! 5 · repo pins 0.20.1`; `$(zap)` while the warm backend runs. */
export function statusText(model: StatusModel): string {
  if (model.resolving && !model.runtime) return "$(loading~spin) opentide";
  if (!model.runtime) return "$(shield) opentide: no runtime";
  const parts = [
    model.runtime.kind === "engine" ? `$(shield) ${ENGINE_STATUS}` : `$(shield) ${model.runtime.version}`,
  ];
  if (model.serve) parts.push("$(zap)");
  if (model.counts.errors > 0) parts.push(`✗ ${model.counts.errors}`);
  if (model.counts.warnings > 0) parts.push(`! ${model.counts.warnings}`);
  let text = parts.join(" ");
  if (model.pin && model.runtime.kind === "opentide" && model.pin.version !== model.runtime.version) {
    text += ` · repo pins ${model.pin.version}`;
  }
  return text;
}

export function sumCounts(sources: Iterable<ProblemCounts>): ProblemCounts {
  let errors = 0;
  let warnings = 0;
  for (const counts of sources) {
    errors += counts.errors;
    warnings += counts.warnings;
  }
  return { errors, warnings };
}

/** "2 errors, 5 warnings", "No problems". */
export function problemsText(counts: ProblemCounts): string {
  const part = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (counts.errors === 0 && counts.warnings === 0) return "No problems";
  return [
    counts.errors ? part(counts.errors, "error") : "",
    counts.warnings ? part(counts.warnings, "warning") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** What a screen reader says for the item: "opentide 0.21.0, warm backend, 2 errors, 5 warnings". */
export function statusLabel(model: StatusModel): string {
  if (model.resolving && !model.runtime) return "opentide: starting";
  if (!model.runtime) return "opentide: no runtime";
  const parts = [
    model.runtime.kind === "engine"
      ? `${ENGINE_STATUS}, engine ${model.runtime.version}`
      : `opentide ${model.runtime.version}`,
  ];
  if (model.serve) parts.push("warm backend");
  if (model.counts.errors || model.counts.warnings) parts.push(problemsText(model.counts));
  if (model.pin && model.runtime.kind === "opentide" && model.pin.version !== model.runtime.version)
    parts.push(`the repository pins ${model.pin.version}`);
  return parts.join(", ");
}

/** The backend line of the tooltip. */
export function serveText(model: Pick<StatusModel, "serve" | "runtime" | "trusted">): string {
  if (!model.runtime) return "No backend: no runtime";
  if (!model.trusted || model.runtime.restricted)
    return "No backend in Restricted Mode: only the language server runs";
  if (model.runtime.kind !== "opentide")
    return "No backend: commands, validate, deploy and query need opentide";
  return model.serve
    ? "Warm backend: `opentide serve` answers commands"
    : "Backend: one opentide process per command";
}

/** A status menu entry, by `order`: features below 100 ("Actions"), the core's at 100 and up ("opentide"). */
export interface MenuEntryLike {
  readonly order?: number;
}

/** The menu's items in two sections, each in order. */
export function menuSections<T extends MenuEntryLike>(items: readonly T[]): { label: string; items: T[] }[] {
  const sorted = [...items].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  const actions = sorted.filter((item) => (item.order ?? 50) < 100);
  const core = sorted.filter((item) => (item.order ?? 50) >= 100);
  return [
    { label: "Actions", items: actions },
    { label: "opentide", items: core },
  ].filter((section) => section.items.length > 0);
}
