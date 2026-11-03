// Rows as text, sorted and filtered: shared by the host and the results webview (no vscode, no DOM).

export interface Column {
  readonly name: string;
  /** The platform's type name (`datetime`, `long`, `string`, …), when it reports one. */
  readonly type?: string | null;
}

export type Row = Readonly<Record<string, unknown>>;

/** A cell as one line of text: objects as compact JSON, null as empty. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export type SortKind = "number" | "date" | "boolean" | "text";

const NUMERIC =
  /^(int|long|real|double|float|decimal|number|integer|short|byte|unsigned_long|half_float|scaled_float)/i;
const DATE = /^(datetime|date|timestamp|time)/i;

/** How a column sorts: from its type, else from its values. */
export function sortKind(column: Column, rows: readonly Row[]): SortKind {
  const type = column.type ?? "";
  if (NUMERIC.test(type)) return "number";
  if (DATE.test(type)) return "date";
  if (/^bool/i.test(type)) return "boolean";
  const values = rows.map((row) => row[column.name]).filter((v) => v !== null && v !== undefined);
  if (values.length > 0 && values.every((v) => typeof v === "number")) return "number";
  if (values.length > 0 && values.every((v) => typeof v === "boolean")) return "boolean";
  return "text";
}

function comparable(value: unknown, kind: SortKind): number | string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  switch (kind) {
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isNaN(n) ? undefined : n;
    }
    case "date": {
      const n = Date.parse(String(value));
      return Number.isNaN(n) ? String(value) : n;
    }
    case "boolean":
      return value === true || value === "true" ? 1 : 0;
    default:
      return cellText(value).toLowerCase();
  }
}

/** Sorted copy; empty values last in either direction. */
export function sortRows(rows: readonly Row[], column: string, kind: SortKind, descending: boolean): Row[] {
  const keyed = rows.map((row, index) => ({ row, index, key: comparable(row[column], kind) }));
  keyed.sort((a, b) => {
    if (a.key === undefined || b.key === undefined) {
      if (a.key === b.key) return a.index - b.index;
      return a.key === undefined ? 1 : -1;
    }
    let order: number;
    if (typeof a.key === "number" && typeof b.key === "number") order = a.key - b.key;
    else order = String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0;
    return (descending ? -order : order) || a.index - b.index;
  });
  return keyed.map((k) => k.row);
}

/** Rows whose text contains `needle` (case-insensitive), in every column or one. */
export function filterRows(
  rows: readonly Row[],
  columns: readonly Column[],
  needle: string,
  column?: string,
): Row[] {
  const wanted = needle.trim().toLowerCase();
  if (!wanted) return [...rows];
  const names = column ? [column] : columns.map((c) => c.name);
  return rows.filter((row) => names.some((name) => cellText(row[name]).toLowerCase().includes(wanted)));
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 CSV with a header row (objects as JSON, as `opentide query --format csv` writes them). */
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

/** A grid's focused cell kept inside its data: a tab with fewer rows or columns moves it in. */
export function clampFocus(
  focus: { readonly row: number; readonly column: number },
  rows: number,
  columns: number,
): { row: number; column: number } {
  return {
    row: Math.max(0, Math.min(focus.row, rows - 1)),
    column: Math.max(0, Math.min(focus.column, columns - 1)),
  };
}

/** What a table's user chose (filter text, filter column, sort): UI preferences, no row data. */
export interface TableViewState {
  readonly filter: string;
  readonly filterColumn: string;
  readonly sort?: { readonly column: string; readonly descending: boolean };
}

/** A persisted TableViewState, or undefined when `value` is not one. */
export function tableViewState(value: unknown): TableViewState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.filter !== "string" || typeof v.filterColumn !== "string") return undefined;
  const sort = v.sort as Record<string, unknown> | undefined;
  const validSort =
    typeof sort === "object" &&
    sort !== null &&
    typeof sort.column === "string" &&
    typeof sort.descending === "boolean";
  return {
    filter: v.filter,
    filterColumn: v.filterColumn,
    ...(validSort ? { sort: { column: sort.column as string, descending: sort.descending as boolean } } : {}),
  };
}
