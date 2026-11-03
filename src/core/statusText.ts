// The status bar text, as pure functions. vscode-free.
import type { RepoPin } from "./runtime/pins";
import type { Runtime } from "./runtime/types";

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
}

/** `$(shield) 0.21.0 ✗ 2 ! 5 · repo pins 0.20.1`. */
export function statusText(model: StatusModel): string {
  if (model.resolving && !model.runtime) return "$(loading~spin) opentide";
  if (!model.runtime) return "$(shield) opentide: no runtime";
  const parts = [`$(shield) ${model.runtime.version}`];
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
