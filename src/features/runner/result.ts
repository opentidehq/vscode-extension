// A run's result as the UI shows it: one summary line, the document as JSON, explainable failure codes,
// and the files a writing command changed. vscode-free.
import * as path from "node:path";
import type { Envelope } from "../../core/backend/types";

export interface RunOutcome {
  readonly document: Envelope;
  readonly exitCode: number;
  readonly cancelled: boolean;
  readonly argvDisplay: string;
}

export interface ResultSummary {
  readonly level: "info" | "warning" | "error";
  /** One short line, for a notification. */
  readonly text: string;
  readonly failureCode?: string;
}

/** `opentide validate --file x` from `opentide --json validate --file x`. */
export function commandLabel(argvDisplay: string): string {
  return argvDisplay.replace(/^opentide --json /, "opentide ");
}

/** The command path a document names, or the start of the argv. */
function commandName(outcome: RunOutcome): string {
  const named = typeof outcome.document.command === "string" ? outcome.document.command : "";
  return (
    named ||
    commandLabel(outcome.argvDisplay)
      .replace(/^opentide /, "")
      .split(" ")[0] ||
    "command"
  );
}

const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function summarize(outcome: RunOutcome): ResultSummary {
  const name = `opentide ${commandName(outcome)}`;
  const message = typeof outcome.document.message === "string" ? outcome.document.message.trim() : "";
  if (outcome.cancelled) return { level: "info", text: `${name}: cancelled` };
  const code = outcome.document.failure?.code;
  if (outcome.exitCode === 0) {
    const warn = outcome.document.status === "issues" || outcome.document.status === "warning";
    return { level: warn ? "warning" : "info", text: clip(`${name}: ${message || "done"}`) };
  }
  const detail = code ? `exit ${outcome.exitCode}, ${code}` : `exit ${outcome.exitCode}`;
  return {
    level: "error",
    text: clip(`${name} failed (${detail})${message ? `: ${message}` : ""}`),
    ...(code ? { failureCode: code } : {}),
  };
}

/** The document as the read-only result shows it: exactly what `--json` printed, indented. */
export function renderDocument(document: Envelope): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** `opentide-result:/<id>/<command>.json`'s path. */
export function resultPath(id: number, argvDisplay: string): string {
  const words = commandLabel(argvDisplay)
    .split(" ")
    .slice(1)
    .filter((word) => /^[a-z][a-z0-9-]*$/.test(word))
    .slice(0, 3);
  return `/${id}/${words.join("-") || "result"}.json`;
}

/** The diagnostic codes of `opentide --json explain` (no code: every code). */
export function explainCodes(document: unknown): Set<string> {
  const codes = new Set<string>();
  const list = (document as { codes?: unknown } | null)?.codes;
  if (!Array.isArray(list)) return codes;
  for (const entry of list) {
    const code = (entry as { code?: unknown } | null)?.code;
    if (typeof code === "string") codes.add(code);
  }
  return codes;
}

/** Whether a failure code is one `explain` explains (cancellation and interruption are not). */
export function isExplainable(code: string | undefined, codes: ReadonlySet<string>): code is string {
  return code !== undefined && codes.has(code);
}

/**
 * Files a writing run changed, workspace-relative with forward slashes, sorted and without duplicates.
 * `.git/` and the extension's caches are left out.
 */
export function changedFiles(folder: string, files: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const file of files) {
    const relative = path.relative(folder, file).split(path.sep).join("/");
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) continue;
    if (/^(\.git|node_modules)\//.test(relative) || relative.startsWith(".opentide/lsp/")) continue;
    out.add(relative);
  }
  return [...out].sort();
}
