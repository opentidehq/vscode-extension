// When validate and lint run, with which argv, and the one-finding-one-squiggle rule. vscode-free.
import type { Severity } from "./findings";

export type OnSave = "file" | "workspace" | "off";

export interface SaveSettings {
  /** `opentide.validate.onSave`. */
  readonly validateOnSave: OnSave;
  /** `opentide.lint.onSave` (`file` or `off`). */
  readonly lintOnSave: "file" | "off";
  /** `opentide.lint.withValidate`: lint the workspace whenever the workspace is validated. */
  readonly lintWithValidate: boolean;
}

export interface SaveTarget {
  /** An object file (YAML under an object folder). */
  readonly isObject: boolean;
  /** A configuration file under `.opentide/configurations/`. */
  readonly isConfiguration: boolean;
}

export interface Features {
  readonly validateFile: boolean;
  readonly lintFile: boolean;
}

export interface SavePlan {
  readonly validate?: "file" | "workspace";
  readonly lint?: "file" | "workspace";
}

/**
 * What a save runs (SPEC §6 "Sources"). An object file is validated alone (`validate --file`) and
 * linted alone when the CLI has `lint --file`; a configuration file affects every object, so it
 * validates the workspace. Lint without `--file` runs on demand only, or with workspace validation.
 */
export function planSave(target: SaveTarget, settings: SaveSettings, features: Features): SavePlan {
  if (!target.isObject && !target.isConfiguration) return {};
  let validate: SavePlan["validate"];
  if (settings.validateOnSave === "workspace") validate = "workspace";
  else if (settings.validateOnSave === "file")
    validate = target.isObject && features.validateFile ? "file" : "workspace";
  let lint: SavePlan["lint"];
  if (validate === "workspace" && settings.lintWithValidate) lint = "workspace";
  else if (settings.lintOnSave === "file" && target.isObject && features.lintFile) lint = "file";
  return { ...(validate ? { validate } : {}), ...(lint ? { lint } : {}) };
}

/**
 * What one batch of saves in a folder runs: its object files, and whether a configuration file was among
 * them. A configuration file validates the workspace, which covers the object files, and brings the
 * workspace lint `opentide.lint.withValidate` asks for; without that, the object files are still linted
 * one by one.
 */
export function planSaveBatch(
  batch: { readonly objects: number; readonly configuration: boolean },
  settings: SaveSettings,
  features: Features,
): SavePlan {
  const forObjects = planSave({ isObject: batch.objects > 0, isConfiguration: false }, settings, features);
  if (!batch.configuration) return forObjects;
  const forConfiguration = planSave({ isObject: false, isConfiguration: true }, settings, features);
  const lint = forConfiguration.lint ?? forObjects.lint;
  return {
    ...(forConfiguration.validate ? { validate: forConfiguration.validate } : {}),
    ...(lint ? { lint } : {}),
  };
}

export function validateArgv(files?: readonly string[]): string[] {
  return ["validate", ...(files ?? []).flatMap((file) => ["--file", file])];
}

export function lintArgv(files?: readonly string[]): string[] {
  return ["lint", ...(files ?? []).flatMap((file) => ["--file", file])];
}

/** A diagnostic's code as text (`code` may be a string, a number or `{ value, target }`). */
export function codeText(code: unknown): string | undefined {
  if (typeof code === "string") return code;
  if (typeof code === "number") return String(code);
  if (code && typeof code === "object" && "value" in code)
    return codeText((code as { value: unknown }).value);
  return undefined;
}

/** The dedupe key: code and 0-based start line (the file is the collection's key). */
export function dedupeKey(code: string, line0: number): string {
  return `${code}\u0000${line0}`;
}

/** Drop the items the language server already reports (same code, same start line). */
export function withoutDuplicates<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  serverKeys: ReadonlySet<string>,
): T[] {
  return items.filter((item) => !serverKeys.has(keyOf(item)));
}

export interface Counts {
  errors: number;
  warnings: number;
}

/** Errors and warnings; information and hints are shown but not counted (SPEC §6 rule 8). */
export function countSeverities(severities: Iterable<Severity>): Counts {
  const counts = { errors: 0, warnings: 0 };
  for (const severity of severities) {
    if (severity === "error") counts.errors++;
    else if (severity === "warning") counts.warnings++;
  }
  return counts;
}

/** `✗ 2 errors · ! 1 warning in 1 file`, or `No problems`. */
export function summaryText(counts: Counts, files: number): string {
  if (counts.errors === 0 && counts.warnings === 0) return "No problems";
  const parts: string[] = [];
  if (counts.errors > 0) parts.push(`${counts.errors} ${counts.errors === 1 ? "error" : "errors"}`);
  if (counts.warnings > 0) parts.push(`${counts.warnings} ${counts.warnings === 1 ? "warning" : "warnings"}`);
  return `${parts.join(", ")} in ${files} ${files === 1 ? "file" : "files"}`;
}

interface Pos {
  readonly line: number;
  readonly character: number;
}

const before = (a: Pos, b: Pos): boolean =>
  a.line < b.line || (a.line === b.line && a.character < b.character);

/** The edits that can go into one workspace edit: the first of any overlapping ones wins. */
export function nonOverlapping<T extends { readonly range: { readonly start: Pos; readonly end: Pos } }>(
  edits: readonly T[],
): T[] {
  const kept: T[] = [];
  for (const edit of edits) {
    const clash = kept.some(
      (other) => before(edit.range.start, other.range.end) && before(other.range.start, edit.range.end),
    );
    const same = kept.some(
      (other) =>
        other.range.start.line === edit.range.start.line &&
        other.range.start.character === edit.range.start.character &&
        other.range.end.line === edit.range.end.line &&
        other.range.end.character === edit.range.end.character,
    );
    if (!clash && !same) kept.push(edit);
  }
  return kept;
}

interface PositionLike {
  readonly line: number;
  readonly character: number;
}
interface RangeLike {
  readonly start: PositionLike;
  readonly end: PositionLike;
}

/** What a rendered diagnostic shows, in the shape `vscode.Diagnostic` has. */
export interface ShownItem {
  readonly key: string;
  readonly diagnostic: {
    readonly message: string;
    readonly severity: number;
    readonly range: RangeLike;
    readonly relatedInformation?: readonly {
      readonly message: string;
      readonly location: { readonly uri: { toString(): string }; readonly range: RangeLike };
    }[];
  };
  readonly finding: { readonly fix: unknown };
}

const rangeText = (range: RangeLike) =>
  `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;

/**
 * Everything a collection entry shows (message, severity, range, related locations) and the quick fix
 * it offers. Two renders with the same signature need no collection update; any other difference does
 * (a `lint.toml` severity change keeps code, line and message alike).
 */
export function itemSignature(item: ShownItem): string {
  const related = (item.diagnostic.relatedInformation ?? [])
    .map((info) => `${info.location.uri.toString()}@${rangeText(info.location.range)}:${info.message}`)
    .join("\u0003");
  return [
    item.key,
    item.diagnostic.message,
    String(item.diagnostic.severity),
    rangeText(item.diagnostic.range),
    related,
    JSON.stringify(item.finding.fix ?? null),
  ].join("\u0001");
}
