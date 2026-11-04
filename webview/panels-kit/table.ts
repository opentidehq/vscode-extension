// A virtualised, sortable, filterable table with a keyboard grid (WAI-ARIA grid pattern). Rows render
// only while in view, so 5,000 rows scroll smoothly.
import {
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
} from "../../src/features/query/format";
import { addStyles, announce, h } from "./dom";

const ROW_HEIGHT = 24;
const OVERSCAN = 8;

export interface TableOptions {
  /** Accessible name. */
  readonly label: string;
  /** Copy text (a cell or a row) through the host. */
  readonly onCopy: (format: "cell" | "row", text: string) => void;
  /** A row was activated (Enter on a row header), for a details drawer. */
  readonly onActivate?: (row: Row) => void;
  /** The user changed the filter or the sort (to keep it in the webview's state). */
  readonly onViewChange?: () => void;
}

interface Sort {
  readonly column: string;
  readonly descending: boolean;
}

let styled = false;

export class VirtualTable {
  readonly element: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private readonly columnSelect: HTMLSelectElement;
  private readonly countLabel: HTMLElement;
  private readonly header: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly body: HTMLElement;
  private columns: readonly Column[] = [];
  private kinds = new Map<string, SortKind>();
  private rows: readonly Row[] = [];
  private shown: Row[] = [];
  private sort: Sort | undefined;
  private widths: number[] = [];
  /** The focused cell: row index into `shown`, column index. */
  private focus = { row: 0, column: 0 };
  /** A restored filter column, applied once a tab with that column is shown. */
  private pendingColumn: string | undefined;

  constructor(private readonly options: TableOptions) {
    if (!styled) {
      addStyles(TABLE_CSS);
      styled = true;
    }
    this.filterInput = h("input", {
      class: "table-filter",
      attrs: { type: "search", placeholder: "Filter rows", "aria-label": "Filter rows" },
      on: { input: () => this.changed() },
    });
    this.columnSelect = h("select", {
      attrs: { "aria-label": "Filter in column" },
      on: {
        change: () => {
          this.pendingColumn = undefined;
          this.changed();
        },
      },
    });
    this.countLabel = h("span", { class: "muted", attrs: { "aria-live": "polite" } });
    this.header = h("div", { class: "vt-header", attrs: { role: "row", "aria-rowindex": 1 } });
    this.spacer = h("div", { class: "vt-spacer" });
    this.body = h("div", { class: "vt-body", attrs: { role: "rowgroup" } });
    this.viewport = h(
      "div",
      {
        class: "vt-viewport",
        attrs: { role: "grid", "aria-label": options.label, tabindex: 0 },
        on: {
          scroll: () => this.render(),
          keydown: (event) => this.onKey(event),
          focus: () => this.focusCell(false),
        },
      },
      [this.header, this.spacer],
    );
    this.spacer.append(this.body);
    this.element = h("div", { class: "vt" }, [
      h("div", { class: "toolbar" }, [
        this.filterInput,
        h("label", {}, ["in ", this.columnSelect]),
        this.countLabel,
      ]),
      this.viewport,
    ]);
    new ResizeObserver(() => this.render()).observe(this.viewport);
  }

  setData(columns: readonly Column[], rows: readonly Row[]): void {
    this.columns = columns;
    this.rows = rows;
    this.kinds = new Map(columns.map((c) => [c.name, sortKind(c, rows)]));
    // An empty table (a failed tab) keeps the sort for the next tab that has the column.
    if (this.sort && columns.length > 0 && !columns.some((c) => c.name === this.sort?.column))
      this.sort = undefined;
    this.widths = columns.map((c) => {
      const sample = rows.slice(0, 200).map((r) => cellText(r[c.name]).length);
      const longest = Math.max(c.name.length + 2, ...sample);
      return Math.min(420, Math.max(80, longest * 7.5 + 20));
    });
    const previous = this.pendingColumn ?? this.columnSelect.value;
    this.columnSelect.replaceChildren(
      h("option", { text: "all columns", attrs: { value: "" } }),
      ...columns.map((c) => h("option", { text: c.name, attrs: { value: c.name } })),
    );
    const { value, pending } = filterColumnAfter(
      previous,
      columns.map((c) => c.name),
    );
    this.columnSelect.value = value;
    this.pendingColumn = pending;
    this.renderHeader();
    this.refresh();
  }

  /** The filter and sort, to keep across a hide and show of the panel. */
  viewState(): TableViewState {
    return {
      filter: this.filterInput.value,
      filterColumn: this.pendingColumn ?? this.columnSelect.value,
      ...(this.sort ? { sort: this.sort } : {}),
    };
  }

  /** Put back a viewState(); takes effect with the next setData. */
  restoreView(state: TableViewState): void {
    this.filterInput.value = state.filter;
    this.pendingColumn = state.filterColumn || undefined;
    this.sort = state.sort;
  }

  private changed(): void {
    this.refresh();
    this.options.onViewChange?.();
  }

  /** The rows as shown: filtered, then sorted. */
  view(): { columns: readonly Column[]; rows: readonly Row[] } {
    return { columns: this.columns, rows: this.shown };
  }

  private refresh(): void {
    const filtered = filterRows(
      this.rows,
      this.columns,
      this.filterInput.value,
      this.columnSelect.value || undefined,
    );
    const kind = this.sort ? (this.kinds.get(this.sort.column) ?? "text") : "text";
    this.shown = this.sort ? sortRows(filtered, this.sort.column, kind, this.sort.descending) : filtered;
    this.countLabel.textContent =
      this.shown.length === this.rows.length
        ? `${this.rows.length} row${this.rows.length === 1 ? "" : "s"}`
        : `${this.shown.length} of ${this.rows.length} rows`;
    this.viewport.setAttribute("aria-rowcount", String(this.shown.length + 1));
    this.viewport.setAttribute("aria-colcount", String(this.columns.length));
    this.focus = clampFocus(this.focus, this.shown.length, this.columns.length);
    this.spacer.style.height = `${this.shown.length * ROW_HEIGHT}px`;
    this.render(true);
  }

  private template(): string {
    return this.widths.map((w) => `${w}px`).join(" ");
  }

  private renderHeader(): void {
    this.header.style.gridTemplateColumns = this.template();
    this.header.replaceChildren(
      ...this.columns.map((column, index) => {
        const active = this.sort?.column === column.name;
        const sorted = active ? (this.sort?.descending ? "descending" : "ascending") : "none";
        return h(
          "div",
          {
            class: "vt-th",
            attrs: { role: "columnheader", "aria-sort": sorted, "aria-colindex": index + 1 },
          },
          [
            h(
              "button",
              {
                class: "vt-sort",
                title: column.type ? `${column.name} (${column.type}). Sort` : `${column.name}. Sort`,
                attrs: { tabindex: -1 },
                on: { click: () => this.toggleSort(column.name) },
              },
              [column.name, active ? (this.sort?.descending ? " ▾" : " ▴") : ""],
            ),
          ],
        );
      }),
    );
  }

  private toggleSort(column: string): void {
    if (this.sort?.column !== column) this.sort = { column, descending: false };
    else if (!this.sort.descending) this.sort = { column, descending: true };
    else this.sort = undefined;
    this.renderHeader();
    this.changed();
    announce(
      this.sort ? `Sorted by ${column}, ${this.sort.descending ? "descending" : "ascending"}` : "Unsorted",
    );
  }

  private render(force = false): void {
    const height = this.viewport.clientHeight || 400;
    const top = Math.max(0, this.viewport.scrollTop - this.header.offsetHeight);
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(this.shown.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    const key = `${first}:${last}`;
    if (!force && this.body.dataset.window === key) return;
    this.body.dataset.window = key;
    this.body.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
    const template = this.template();
    const rows: HTMLElement[] = [];
    for (let index = first; index < last; index++) {
      const row = this.shown[index];
      if (!row) continue;
      const element = h("div", {
        class: "vt-row",
        attrs: { role: "row", "aria-rowindex": index + 2 },
      });
      element.style.gridTemplateColumns = template;
      this.columns.forEach((column, c) => {
        const text = cellText(row[column.name]);
        const focused = this.focus.row === index && this.focus.column === c;
        element.append(
          h("div", {
            class: `vt-td${focused ? " focused" : ""}`,
            text,
            title: text.length > 40 ? text.slice(0, 2000) : "",
            attrs: { role: "gridcell", "aria-colindex": c + 1, id: focused ? "vt-active" : undefined },
            on: {
              click: () => {
                this.focus = { row: index, column: c };
                this.focusCell(false);
              },
            },
          }),
        );
      });
      rows.push(element);
    }
    this.body.replaceChildren(...rows);
    if (this.columns.length > 0 && this.shown.length > 0)
      this.viewport.setAttribute("aria-activedescendant", "vt-active");
    else this.viewport.removeAttribute("aria-activedescendant");
  }

  private focusCell(scroll: boolean): void {
    if (scroll) {
      // Rows sit below the sticky header; keep the focused one between it and the bottom edge.
      const headerHeight = this.header.offsetHeight;
      const top = headerHeight + this.focus.row * ROW_HEIGHT;
      if (top - headerHeight < this.viewport.scrollTop) this.viewport.scrollTop = top - headerHeight;
      else if (top + ROW_HEIGHT > this.viewport.scrollTop + this.viewport.clientHeight)
        this.viewport.scrollTop = top + ROW_HEIGHT - this.viewport.clientHeight;
    }
    this.render(true);
    if (document.activeElement !== this.viewport) this.viewport.focus({ preventScroll: true });
  }

  private onKey(event: KeyboardEvent): void {
    const rows = this.shown.length;
    const columns = this.columns.length;
    if (rows === 0 || columns === 0) return;
    const page = Math.max(1, Math.floor(this.viewport.clientHeight / ROW_HEIGHT) - 1);
    const { row, column } = this.focus;
    const moves: Record<string, () => void> = {
      ArrowDown: () => (this.focus.row = Math.min(rows - 1, row + 1)),
      ArrowUp: () => (this.focus.row = Math.max(0, row - 1)),
      ArrowRight: () => (this.focus.column = Math.min(columns - 1, column + 1)),
      ArrowLeft: () => (this.focus.column = Math.max(0, column - 1)),
      PageDown: () => (this.focus.row = Math.min(rows - 1, row + page)),
      PageUp: () => (this.focus.row = Math.max(0, row - page)),
      Home: () => {
        this.focus.column = 0;
        if (event.ctrlKey) this.focus.row = 0;
      },
      End: () => {
        this.focus.column = columns - 1;
        if (event.ctrlKey) this.focus.row = rows - 1;
      },
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      move();
      this.focusCell(true);
      return;
    }
    const current = this.shown[this.focus.row];
    const name = this.columns[this.focus.column]?.name;
    if (!current || name === undefined) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      if (event.shiftKey) this.options.onCopy("row", JSON.stringify(current));
      else this.options.onCopy("cell", cellText(current[name]));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey || !this.options.onActivate) this.toggleSort(name);
      else this.options.onActivate(current);
    }
  }

  /** The focused row, for "Copy row". */
  focusedRow(): Row | undefined {
    return this.shown[this.focus.row];
  }

  focusedCell(): string | undefined {
    const row = this.shown[this.focus.row];
    const name = this.columns[this.focus.column]?.name;
    return row && name !== undefined ? cellText(row[name]) : undefined;
  }
}

const TABLE_CSS = `
.vt { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.table-filter { min-width: 220px; }
.vt-viewport { position: relative; overflow: auto; flex: 1; min-height: 160px; height: 60vh;
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
.vt-viewport:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.vt-header { position: sticky; top: 0; z-index: 1; display: grid; width: max-content; min-width: 100%;
  background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
.vt-th { overflow: hidden; }
.vt-sort { all: unset; display: block; box-sizing: border-box; width: 100%; padding: 3px 8px; font-weight: 600;
  cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vt-sort:hover { background: var(--vscode-list-hoverBackground); }
.vt-spacer { position: relative; width: max-content; min-width: 100%; }
.vt-body { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }
.vt-row { display: grid; height: ${ROW_HEIGHT}px; width: max-content; min-width: 100%; }
.vt-row:nth-child(even) { background: var(--vscode-list-inactiveSelectionBackground, transparent); }
.vt-row:hover { background: var(--vscode-list-hoverBackground); }
.vt-td { padding: 0 8px; line-height: ${ROW_HEIGHT}px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
.vt-td.focused { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
  background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
`;
