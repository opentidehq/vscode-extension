// The kit's table data: cells as text, typed sorting, filtering, and a model that keeps what it computed
// (lower-cased cell text, sort orders) so a filter keystroke or a sort click on 10,000 rows stays well
// inside a frame (SPEC §14). Shared by the host and the webviews: no vscode, no DOM.

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

/**
 * Row indices in sorted order; empty values last in either direction, ties in their original order. The
 * keys are computed once, and the comparison specialised to numbers or strings: 10,000 rows sort within
 * a frame.
 */
export function sortOrder(
  rows: readonly Row[],
  column: string,
  kind: SortKind,
  descending: boolean,
): number[] {
  const keys = rows.map((row) => comparable(row[column], kind));
  const present: number[] = [];
  const empty: number[] = [];
  let numeric = true;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === undefined) empty.push(i);
    else {
      present.push(i);
      if (typeof key !== "number") numeric = false;
    }
  }
  const sign = descending ? -1 : 1;
  if (numeric) {
    const values = keys as (number | undefined)[];
    present.sort((a, b) => sign * ((values[a] as number) - (values[b] as number)) || a - b);
  } else {
    // Mixed (a date column with some unparsable values): compare as text.
    const texts = keys.map((key) => (key === undefined ? "" : String(key)));
    present.sort((a, b) => {
      const ta = texts[a] as string;
      const tb = texts[b] as string;
      return (ta < tb ? -sign : ta > tb ? sign : 0) || a - b;
    });
  }
  return present.concat(empty);
}

/** Sorted copy; empty values last in either direction. */
export function sortRows(rows: readonly Row[], column: string, kind: SortKind, descending: boolean): Row[] {
  return sortOrder(rows, column, kind, descending).flatMap((index) => {
    const row = rows[index];
    return row ? [row] : [];
  });
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

/**
 * The table's "in" column after new data: `wanted` (the column chosen, or one waiting from a restored
 * view) if the data has it, else all columns (`""`). `pending` is what to keep waiting for: a table with no
 * columns yet (a tab still running, a failed tab, a re-run's empty start) keeps the choice for the next
 * data that has columns, as the sort does.
 */
export function filterColumnAfter(
  wanted: string,
  columns: readonly string[],
): { readonly value: string; readonly pending: string | undefined } {
  if (columns.includes(wanted)) return { value: wanted, pending: undefined };
  return { value: "", pending: columns.length === 0 && wanted ? wanted : undefined };
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

/** The view a table shows: which rows, in which order (indices into the model's rows). */
export interface TableQuery {
  readonly filter: string;
  /** A column name, or "" for every column. */
  readonly filterColumn: string;
  readonly sort?: { readonly column: string; readonly descending: boolean };
}

/**
 * One data set's columns and rows, with what views of it need computed once: each column's sort kind,
 * its cells' lower-cased text (built the first time a filter needs the column), and each sort order.
 */
export class TableModel {
  readonly kinds: readonly SortKind[];
  private readonly lower: (string[] | undefined)[];
  private readonly orders = new Map<string, number[]>();

  constructor(
    readonly columns: readonly Column[],
    readonly rows: readonly Row[],
  ) {
    this.kinds = columns.map((c) => sortKind(c, rows));
    this.lower = columns.map(() => undefined);
  }

  kindOf(column: string): SortKind {
    const index = this.columns.findIndex((c) => c.name === column);
    return this.kinds[index] ?? "text";
  }

  /** The cell text of row `row`, column `column` (indices). */
  text(row: number, column: number): string {
    const name = this.columns[column]?.name;
    const value = name === undefined ? undefined : this.rows[row]?.[name];
    return cellText(value);
  }

  private lowerColumn(column: number): string[] {
    let texts = this.lower[column];
    if (!texts) {
      const name = this.columns[column]?.name ?? "";
      texts = this.rows.map((row) => cellText(row[name]).toLowerCase());
      this.lower[column] = texts;
    }
    return texts;
  }

  private order(column: string, descending: boolean): number[] {
    const key = `${descending ? "-" : "+"}${column}`;
    let order = this.orders.get(key);
    if (!order) {
      order = sortOrder(this.rows, column, this.kindOf(column), descending);
      this.orders.set(key, order);
    }
    return order;
  }

  /** The rows a query shows, as indices: sorted (cached per column and direction), then filtered. */
  view(query: TableQuery): number[] {
    const known = query.sort && this.columns.some((c) => c.name === query.sort?.column);
    const base =
      known && query.sort
        ? this.order(query.sort.column, query.sort.descending)
        : this.rows.map((_, index) => index);
    const needle = query.filter.trim().toLowerCase();
    if (!needle) return [...base];
    const only = this.columns.findIndex((c) => c.name === query.filterColumn);
    const columns = only >= 0 ? [this.lowerColumn(only)] : this.columns.map((_, c) => this.lowerColumn(c));
    return base.filter((row) => columns.some((texts) => (texts[row] ?? "").includes(needle)));
  }
}
