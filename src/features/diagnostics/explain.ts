// `opentide --json explain [code]` documents, for the Markdown preview and the code picker. vscode-free.
import { docsUrl } from "./findings";

/** The page of one code: the document's `markdown`, else a page built from `meaning`. */
export function explainMarkdown(code: string, document: unknown): string | undefined {
  if (!document || typeof document !== "object") return undefined;
  const value = document as { markdown?: unknown; meaning?: unknown; ok?: unknown };
  if (value.ok === false) return undefined;
  const footer = `\n\n---\n\n[${code} on opentide.org](${docsUrl(code)}) · \`opentide explain ${code}\`\n`;
  if (typeof value.markdown === "string" && value.markdown.trim()) return value.markdown.trimEnd() + footer;
  if (typeof value.meaning === "string") return `# ${code}\n\n${value.meaning}${footer}`;
  return undefined;
}

export interface ExplainCode {
  readonly code: string;
  readonly meaning: string;
}

/** The codes `opentide --json explain` (no argument) lists. */
export function explainCodes(document: unknown): ExplainCode[] {
  const codes = (document as { codes?: unknown } | undefined)?.codes;
  if (!Array.isArray(codes)) return [];
  return codes.flatMap((entry) =>
    entry && typeof entry === "object" && typeof (entry as { code?: unknown }).code === "string"
      ? [
          {
            code: (entry as { code: string }).code,
            meaning: String((entry as { meaning?: unknown }).meaning ?? ""),
          },
        ]
      : [],
  );
}

/** A diagnostic code is safe to put on a command line and in a URI path. */
export function isCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value);
}

export interface WouldFix {
  readonly path: string;
  readonly line?: number;
  readonly code?: string;
  readonly before?: string;
  readonly after?: string;
}

/** `validate --fix --dry-run`: the unified diff and the fixes it would apply. */
export function dryRunFixes(document: unknown): { diff: string; fixes: WouldFix[] } {
  const value = (document ?? {}) as { diff?: unknown; would_fix?: unknown };
  const fixes = Array.isArray(value.would_fix)
    ? value.would_fix.filter(
        (fix): fix is WouldFix => !!fix && typeof fix === "object" && typeof fix.path === "string",
      )
    : [];
  return { diff: typeof value.diff === "string" ? value.diff : "", fixes };
}
