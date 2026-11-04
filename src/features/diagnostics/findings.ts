// `opentide --json validate` and `opentide --json lint` documents as findings: one shape for both, with
// absolute file paths and CLI spans (1-based, code points). vscode-free.
import * as path from "node:path";
import type { CliSpan } from "../../core/positions";
import { folderSpelling } from "../../core/util/paths";

export type FindingSource = "validate" | "lint";

/** VS Code's four severities, by their opentide names (SPEC §6 rule 4). */
export type Severity = "error" | "warning" | "info" | "hint";

export interface FixEdit extends CliSpan {
  readonly replacement: string;
}

export interface Fix {
  readonly safe: boolean;
  readonly edits: readonly FixEdit[];
}

export interface RelatedFile {
  readonly file: string;
  readonly message: string;
  /** Text to look for in that file to place the location (a duplicated UUID). */
  readonly value?: string;
}

export interface Finding {
  readonly source: FindingSource;
  /** Absolute, as the CLI resolved it. */
  readonly file: string;
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly help: string | null;
  readonly span: CliSpan;
  readonly fix: Fix | null;
  readonly related: readonly RelatedFile[];
}

export interface ParsedFindings {
  readonly findings: Finding[];
  /** Findings that name no file (logged, never shown). */
  readonly unlocated: number;
  /**
   * The run checked what it was asked to: the document has its findings list, and no failure other
   * than "issues found" (`lint --file` on a file outside the family folders answers `findings: []`
   * with `command_failed`; `validate --file` an unlocated `scope_no_match`). An incomplete result
   * must not replace the problems it would otherwise clear.
   */
  readonly complete: boolean;
}

/** The docs page of a code (SPEC §6 rule 5; the language server uses the same target). */
export function docsUrl(code: string): string {
  return `https://opentide.org/docs/cli/diagnostics/#${encodeURIComponent(code)}`;
}

/** Deprecation codes get the Deprecated tag. */
export function isDeprecationCode(code: string): boolean {
  return /(^|_)deprecat/.test(code);
}

export function severityOf(value: unknown): Severity {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "error":
    case "critical":
      return "error";
    case "warning":
    case "warn":
      return "warning";
    case "note":
    case "hint":
      return "hint";
    default:
      return "info";
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function parseFix(value: unknown): Fix | null {
  if (!isObject(value) || !Array.isArray(value.edits)) return null;
  const edits: FixEdit[] = [];
  for (const edit of value.edits) {
    if (!isObject(edit) || typeof edit.replacement !== "string") continue;
    const line = num(edit.line);
    if (line === undefined) continue;
    edits.push({
      line,
      column: num(edit.column) ?? null,
      end_line: num(edit.end_line) ?? null,
      end_column: num(edit.end_column) ?? null,
      replacement: edit.replacement,
    });
  }
  return edits.length > 0 ? { safe: value.safe === true, edits } : null;
}

function spanOf(entry: Json): CliSpan {
  const line = num(entry.line) ?? (num(entry.yaml_line) !== undefined ? (num(entry.yaml_line) ?? 0) + 1 : 1);
  const column = num(entry.column);
  return {
    line,
    column: column ?? null,
    end_line: num(entry.end_line) ?? null,
    end_column: column === undefined ? null : (num(entry.end_column) ?? null),
  };
}

/** Resolves a path the CLI reported (relative to the document's root) to the folder's spelling of it. */
type At = (file: string) => string;

function relatedOf(entry: Json, at: At): RelatedFile[] {
  const context = isObject(entry.context) ? entry.context : undefined;
  const original = context && isObject(context.original) ? context.original : undefined;
  const file = original ? str(original.file_path) : undefined;
  if (!original || !file) return [];
  const name = str(original.name);
  const value = str(context?.value);
  return [
    {
      file: at(file),
      message: name ? `already used by '${name}'` : "already used here",
      ...(value ? { value } : {}),
    },
  ];
}

/**
 * The file a finding is about: `file_path` (absolute), else `path` (workspace-relative), else, for a
 * configuration finding, `context.file` under `.opentide/configurations/`.
 */
function fileOf(entry: Json, at: At): string | undefined {
  const absolute = str(entry.file_path);
  if (absolute) return at(absolute);
  const relative = str(entry.path);
  if (relative) return at(relative);
  const context = isObject(entry.context) ? entry.context : undefined;
  const config = context ? str(context.file) : undefined;
  if (config && !path.isAbsolute(config) && !config.split(/[\\/]/).includes(".."))
    return at(path.join(".opentide", "configurations", config));
  return undefined;
}

function toFinding(source: FindingSource, entry: unknown, at: At): Finding | undefined {
  if (!isObject(entry)) return undefined;
  const file = fileOf(entry, at);
  const code = str(entry.code) ?? (source === "lint" ? str(entry.check) : undefined) ?? "opentide";
  if (!file) return undefined;
  return {
    source,
    file,
    code,
    severity: severityOf(entry.severity),
    message: str(entry.message) ?? code,
    help: str(entry.help) ?? null,
    span: spanOf(entry),
    fix: parseFix(entry.fix),
    related: relatedOf(entry, at),
  };
}

/** The workspace a document's relative paths are relative to. */
function rootOf(document: Json, folder: string, source: FindingSource): string {
  const own = source === "validate" ? str(document.workspace) : str(document.path);
  return own && path.isAbsolute(own) ? own : folder;
}

/** Paths of the document resolved against its root, in the folder's spelling (see core/util/paths). */
function resolver(document: Json, folder: string, source: FindingSource, spell: At): At {
  const root = rootOf(document, folder, source);
  return (file) => spell(path.resolve(root, file));
}

/** Findings of a `validate` document (`report.issues` and `report.warnings`). */
export function validateFindings(
  document: unknown,
  folder: string,
  spell: At = folderSpelling(folder),
): ParsedFindings {
  if (!isObject(document) || !isObject(document.report) || failedRun(document))
    return { findings: [], unlocated: 0, complete: false };
  const entries = [
    ...(Array.isArray(document.report.issues) ? document.report.issues : []),
    ...(Array.isArray(document.report.warnings) ? document.report.warnings : []),
  ];
  if (entries.some((entry) => isObject(entry) && entry.code === "scope_no_match"))
    return { findings: [], unlocated: 0, complete: false };
  return collect("validate", entries, resolver(document, folder, "validate", spell));
}

/** Findings of a `lint` document (`findings`). */
export function lintFindings(
  document: unknown,
  folder: string,
  spell: At = folderSpelling(folder),
): ParsedFindings {
  if (!isObject(document) || !Array.isArray(document.findings) || failedRun(document))
    return { findings: [], unlocated: 0, complete: false };
  return collect("lint", document.findings, resolver(document, folder, "lint", spell));
}

/** A failure other than "issues found": the command did not check what it was asked to. */
function failedRun(document: Json): boolean {
  const failure = document.failure;
  return isObject(failure) && failure.code !== "issues_found";
}

function collect(source: FindingSource, entries: readonly unknown[], at: At): ParsedFindings {
  const findings: Finding[] = [];
  let unlocated = 0;
  for (const entry of entries) {
    const finding = toFinding(source, entry, at);
    if (finding) findings.push(finding);
    else unlocated++;
  }
  return { findings, unlocated, complete: true };
}

/** The message a diagnostic shows: the finding's, then its `help` on a line of its own. */
export function diagnosticMessage(finding: Finding): string {
  return finding.help ? `${finding.message}\n${finding.help}` : finding.message;
}

/** `Replace with 'amber'` (one edit) or `Apply the suggested fix` (several). */
export function fixTitle(finding: Finding): string {
  const [edit] = finding.fix?.edits ?? [];
  if (finding.fix?.edits.length === 1 && edit) {
    return edit.replacement === ""
      ? `Delete the value (${finding.code})`
      : `Replace with '${edit.replacement}'`;
  }
  return `Apply the suggested fix (${finding.code})`;
}
