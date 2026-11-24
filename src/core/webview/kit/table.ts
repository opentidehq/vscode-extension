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

/** Rows `sortKind` reads to infer a kind from the values: the first ones, then a stride over the rest. */
export const KIND_SAMPLE = { head: 200, stride: 200 } as const;

/** The row indices a sample of `count` rows holds: the first `head`, then about `stride` more, evenly spread. */
function sampleIndices(count: number): number[] {
  const indices: number[] = [];
  const head = Math.min(count, KIND_SAMPLE.head);
  for (let i = 0; i < head; i++) indices.push(i);
  const step = Math.max(1, Math.floor((count - head) / KIND_SAMPLE.stride));
  for (let i = head; i < count; i += step) indices.push(i);
  return indices;
}

/**
 * How a column sorts: from its type, else from a bounded sample of its values (see KIND_SAMPLE), so
 * opening a 50,000-row result does not scan every cell. A value outside the sample can contradict a
 * kind inferred this way: `kindHolds` checks it before the column is sorted.
 */
export function sortKind(column: Column, rows: readonly Row[]): SortKind {
  const type = column.type ?? "";
  if (NUMERIC.test(type)) return "number";
  if (DATE.test(type)) return "date";
  if (/^bool/i.test(type)) return "boolean";
  let numbers = 0;
  let booleans = 0;
  let present = 0;
  for (const index of sampleIndices(rows.length)) {
    const value = rows[index]?.[column.name];
    if (value === null || value === undefined) continue;
    present++;
    if (typeof value === "number") numbers++;
    else if (typeof value === "boolean") booleans++;
    else return "text";
  }
  if (present > 0 && numbers === present) return "number";
  if (present > 0 && booleans === present) return "boolean";
  return "text";
}

/** Whether every value of a column inferred as `number` or `boolean` is of that type (text always holds). */
export function kindHolds(kind: SortKind, rows: readonly Row[], column: string): boolean {
  if (kind !== "number" && kind !== "boolean") return true;
  const wanted = kind === "number" ? "number" : "boolean";
  for (const row of rows) {
    const value = row[column];
    if (value !== null && value !== undefined && typeof value !== wanted) return false;
  }
  return true;
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

/** Runs `task` later, off the critical path (requestIdleCallback with a timeout, a timer, a test's queue). */
export type Schedule = (task: () => void) => void;

export interface TableModelOptions {
  /**
   * Builds the lower-cased text index in the background, in chunks of INDEX_CHUNK cells, each in a task
   * this runs. Without it the index is built when the first filter needs it.
   */
  readonly schedule?: Schedule;
}

/** Cells lower-cased per background task: a few milliseconds, well inside a frame. */
export const INDEX_CHUNK = 20_000;

/** A column's lower-cased cell text, filled from row 0 on; `texts[row]` is valid below `built`. */
interface LowerColumn {
  readonly texts: string[];
  built: number;
}

/**
 * One data set's columns and rows, with what views of it need computed once: each column's sort kind
 * (inferred from a sample, checked in full before a sort), its cells' lower-cased text (built in the
 * background when a schedule is given, else, or sooner if a filter comes first, on demand), and each sort
 * order.
 */
export class TableModel {
  private readonly kindList: SortKind[];
  /** Columns whose kind came from the values, not the type: the ones a late row can contradict. */
  private readonly inferred: boolean[];
  private readonly lower: LowerColumn[];
  private readonly orders = new Map<string, number[]>();
  private cancelled = false;

  constructor(
    readonly columns: readonly Column[],
    readonly rows: readonly Row[],
    options: TableModelOptions = {},
  ) {
    this.kindList = columns.map((c) => sortKind(c, rows));
    this.inferred = columns.map(
      (c) => !NUMERIC.test(c.type ?? "") && !DATE.test(c.type ?? "") && !/^bool/i.test(c.type ?? ""),
    );
    this.lower = columns.map(() => ({ texts: [], built: 0 }));
    if (options.schedule && columns.length > 0 && rows.length > 0) this.buildInBackground(options.schedule);
  }

  /** How each column sorts. A kind inferred from the sample may turn to `text` when a sort finds a contradiction. */
  get kinds(): readonly SortKind[] {
    return this.kindList;
  }

  /** Stop building the index in the background (the data was replaced). */
  dispose(): void {
    this.cancelled = true;
  }

  /** Whether every column's lower-cased text is built. */
  get indexReady(): boolean {
    return this.lower.every((column) => column.built >= this.rows.length);
  }

  kindOf(column: string): SortKind {
    const index = this.columns.findIndex((c) => c.name === column);
    return this.kindList[index] ?? "text";
  }

  /** The cell text of row `row`, column `column` (indices). */
  text(row: number, column: number): string {
    const name = this.columns[column]?.name;
    const value = name === undefined ? undefined : this.rows[row]?.[name];
    return cellText(value);
  }

  /** Lower-case up to `limit` more rows of a column; returns how many cells it did. */
  private fill(column: number, limit: number): number {
    const state = this.lower[column];
    const name = this.columns[column]?.name ?? "";
    if (!state) return 0;
    const end = Math.min(this.rows.length, state.built + limit);
    const done = end - state.built;
    for (let i = state.built; i < end; i++) state.texts[i] = cellText(this.rows[i]?.[name]).toLowerCase();
    state.built = end;
    return done;
  }

  private buildInBackground(schedule: Schedule): void {
    let column = 0;
    const step = (): void => {
      if (this.cancelled) return;
      let budget = INDEX_CHUNK;
      // A filter may have finished columns already (lowerColumn): skip them.
      while (column < this.columns.length && budget > 0) {
        budget -= this.fill(column, budget);
        if ((this.lower[column]?.built ?? 0) >= this.rows.length) column++;
      }
      if (column < this.columns.length) schedule(step);
    };
    schedule(step);
  }

  /** A column's lower-cased text, complete: whatever the background has not built yet is built now. */
  private lowerColumn(column: number): string[] {
    const state = this.lower[column];
    if (!state) return [];
    if (state.built < this.rows.length) this.fill(column, this.rows.length);
    return state.texts;
  }

  private order(column: string, descending: boolean): number[] {
    const key = `${descending ? "-" : "+"}${column}`;
    let order = this.orders.get(key);
    if (!order) {
      this.checkKind(column);
      order = sortOrder(this.rows, column, this.kindOf(column), descending);
      this.orders.set(key, order);
    }
    return order;
  }

  /** A kind inferred from the sample is checked against every row once, before a sort relies on it. */
  private checkKind(column: string): void {
    const index = this.columns.findIndex((c) => c.name === column);
    const kind = this.kindList[index];
    if (index < 0 || !this.inferred[index] || kind === undefined || kind === "text") return;
    this.inferred[index] = false;
    if (!kindHolds(kind, this.rows, column)) this.kindList[index] = "text";
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
