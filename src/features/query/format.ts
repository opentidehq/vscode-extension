// Rows as text, sorted and filtered: shared by the host and the results webview (no vscode, no DOM).

import { type Column, cellText, type Row } from "../../core/webview/kit/table";

export {
  type Column,
  cellText,
  clampFocus,
  filterColumnAfter,
  filterRows,
  type Row,
  type SortKind,
  sortKind,
  sortRows,
  type TableViewState,
  tableViewState,
} from "../../core/webview/kit/table";

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * A cell a spreadsheet would read as a formula (`=`, `+`, `-`, `@`, tab or CR first, OWASP's list) gets a
 * leading `'`. Query rows carry attacker-controlled telemetry (command lines, user agents, file
 * names), and Excel or LibreOffice evaluate `=HYPERLINK(…)` in a CSV even when it is quoted. A plain
 * number such as `-2` is left as it is.
 */
export function neutraliseFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) && !NUMBER.test(text) ? `'${text}` : text;
}

function csvField(raw: string): string {
  const text = neutraliseFormula(raw);
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * RFC 4180 CSV with a header row (objects as JSON, as `opentide query --format csv` writes them), for
 * Export and Copy CSV. Unlike the CLI's, cells that would be formulas are neutralised.
 */
export function toCsv(columns: readonly Column[], rows: readonly Row[]): string {
  const lines = [columns.map((c) => csvField(c.name)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvField(cellText(row[c.name]))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** One JSON object per line, keys in column order. */
export function toJsonl(columns: readonly Column[], rows: readonly Row[]): string {
  return rows
    .map((row) => JSON.stringify(Object.fromEntries(columns.map((c) => [c.name, row[c.name] ?? null]))))
    .map((line) => `${line}\n`)
    .join("");
}

/** A JSON array of row objects. */
export function toJson(columns: readonly Column[], rows: readonly Row[]): string {
  return `${JSON.stringify(
    rows.map((row) => Object.fromEntries(columns.map((c) => [c.name, row[c.name] ?? null]))),
    null,
    2,
  )}\n`;
}

function markdownCell(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

/** A GitHub-flavoured Markdown table. */
export function toMarkdown(columns: readonly Column[], rows: readonly Row[]): string {
  const header = `| ${columns.map((c) => markdownCell(c.name)).join(" | ")} |`;
  const rule = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${columns.map((c) => markdownCell(cellText(row[c.name]))).join(" | ")} |`,
  );
  return `${[header, rule, ...body].join("\n")}\n`;
}

export type CopyFormat = "csv" | "json" | "jsonl" | "markdown";

export function formatRows(format: CopyFormat, columns: readonly Column[], rows: readonly Row[]): string {
  switch (format) {
    case "csv":
      return toCsv(columns, rows);
    case "json":
      return toJson(columns, rows);
    case "jsonl":
      return toJsonl(columns, rows);
    default:
      return toMarkdown(columns, rows);
  }
}
