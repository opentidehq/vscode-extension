// A virtualised, sortable, filterable table with resizable columns and a keyboard grid (WAI-ARIA grid).
// Only the rows in view exist, and they are a fixed pool of elements whose text changes as the window
// moves: scrolling 10,000 rows creates no element, and a state update rebuilds nothing it can update.
import {
  gridTemplate,
  initialWidths,
  keyboardResizeDelta,
  resizeColumn,
} from "../../src/core/webview/kit/columns";
import {
  type Column,
  cellText,
  clampFocus,
  filterColumnAfter,
  type Row,
  TableModel,
  type TableViewState,
} from "../../src/core/webview/kit/table";
import { pageRows, revealRow, rowWindow } from "../../src/core/webview/kit/virtual";
import { announce, frameThrottle, h, setClass, setText } from "./dom";
import { showMenu } from "./menu";

const ROW_HEIGHT = 24;
const OVERSCAN = 6;

export interface TableOptions {
  /** Accessible name. */
  readonly label: string;
  /** Copy text (a cell or a row) through the host. */
  readonly onCopy: (format: "cell" | "row", text: string) => void;
  /** A row was activated (Enter on a cell), for a details drawer. */
  readonly onActivate?: (row: Row) => void;
  /** The user changed the filter or the sort (to keep it in the webview's state). */
  readonly onViewChange?: () => void;
}

interface Sort {
  readonly column: string;
  readonly descending: boolean;
}

export class VirtualTable {
  readonly element: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private readonly columnSelect: HTMLSelectElement;
  private readonly countLabel: HTMLElement;
  private readonly header: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly body: HTMLElement;
  private model = new TableModel([], []);
  /** Indices into the model's rows, as shown (filtered, then sorted). */
  private shown: number[] = [];
  private sort: Sort | undefined;
  private widths: number[] = [];
  /** Widths the user set, by column name: kept across tabs and re-runs with the same columns. */
  private readonly chosenWidths = new Map<string, number>();
  /** The focused cell: index into `shown`, column index. */
  private focus = { row: 0, column: 0 };
  /** A restored filter column, applied once data with that column is shown. */
  private pendingColumn: string | undefined;
  /** The row elements in use, by slot; each has one cell element per column. */
  private pool: HTMLElement[] = [];
  private windowKey = "";
  private filterTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly scheduleRender = frameThrottle(() => this.render());

  constructor(private readonly options: TableOptions) {
    this.filterInput = h("input", {
      class: "table-filter",
      attrs: {
        type: "search",
        placeholder: "Filter rows",
        "aria-label": "Filter rows",
        "data-focus": "filter",
      },
      on: {
        input: () => {
          // A keystroke waits for the next one (80 ms): typing a word filters once, not per letter.
          if (this.filterTimer) clearTimeout(this.filterTimer);
          this.filterTimer = setTimeout(() => this.changed(), 80);
        },
        keydown: (event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            this.viewport.focus();
          }
        },
      },
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
        attrs: { role: "grid", "aria-label": options.label, tabindex: 0, "data-focus": "grid" },
        on: {
          scroll: () => this.scheduleRender(),
          keydown: (event) => this.onKey(event),
          focus: () => this.paintFocus(),
          click: (event) => this.onClick(event),
          contextmenu: (event) => this.onContextMenu(event),
        },
      },
      [this.header, this.spacer],
    );
    this.spacer.append(this.body);
    this.element = h("div", { class: "vt" }, [
      h("div", { class: "ot-bar" }, [
        h("span", { class: "codicon codicon-filter", attrs: { "aria-hidden": "true" } }),
        this.filterInput,
        h("label", {}, ["in ", this.columnSelect]),
        h("span", { class: "ot-spacer" }),
        this.countLabel,
      ]),
      this.viewport,
    ]);
    new ResizeObserver(() => this.scheduleRender()).observe(this.viewport);
  }

  setData(columns: readonly Column[], rows: readonly Row[]): void {
    if (this.model.columns === columns && this.model.rows === rows) return;
    this.model = new TableModel(columns, rows);
    // An empty table (a failed tab) keeps the sort for the next data that has the column.
    if (this.sort && columns.length > 0 && !columns.some((c) => c.name === this.sort?.column))
      this.sort = undefined;
    const guessed = initialWidths(
      columns.map((c) => c.name),
      (c, r) => this.model.text(r, c).length,
      rows.length,
    );
    this.widths = columns.map((c, i) => this.chosenWidths.get(c.name) ?? guessed[i] ?? 120);
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
    this.buildPool();
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

  /** The rows as shown: filtered, then sorted. */
  view(): { columns: readonly Column[]; rows: readonly Row[] } {
    const rows = this.model.rows;
    return {
      columns: this.model.columns,
      rows: this.shown.flatMap((index) => {
        const row = rows[index];
        return row ? [row] : [];
      }),
    };
  }

  /** The focused row, for "Copy row". */
  focusedRow(): Row | undefined {
    const index = this.shown[this.focus.row];
    return index === undefined ? undefined : this.model.rows[index];
  }

  focusedCell(): string | undefined {
    const index = this.shown[this.focus.row];
    return index === undefined ? undefined : this.model.text(index, this.focus.column);
  }

  private changed(): void {
    this.refresh();
    this.options.onViewChange?.();
  }

  private refresh(): void {
    this.shown = this.model.view({
      filter: this.filterInput.value,
      filterColumn: this.columnSelect.value,
      ...(this.sort ? { sort: this.sort } : {}),
    });
    const total = this.model.rows.length;
    this.countLabel.textContent =
      this.shown.length === total
        ? `${total.toLocaleString()} row${total === 1 ? "" : "s"}`
        : `${this.shown.length.toLocaleString()} of ${total.toLocaleString()} rows`;
    this.viewport.setAttribute("aria-rowcount", String(this.shown.length + 1));
    this.viewport.setAttribute("aria-colcount", String(this.model.columns.length));
    this.focus = clampFocus(this.focus, this.shown.length, this.model.columns.length);
    this.spacer.style.height = `${this.shown.length * ROW_HEIGHT}px`;
    this.windowKey = "";
    this.render();
  }

  private template(): string {
    return gridTemplate(this.widths);
  }

  /** A fixed set of row elements, enough for the viewport and the overscan, each with its cells. */
  private buildPool(): void {
    const height = Math.max(this.viewport.clientHeight, window.innerHeight);
    const size = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2 + 2;
    const columns = this.model.columns.length;
    this.pool = Array.from({ length: size }, () => {
      const row = h("div", { class: "vt-row", attrs: { role: "row" } });
      for (let c = 0; c < columns; c++)
        row.append(h("div", { class: "vt-td", attrs: { role: "gridcell", "aria-colindex": c + 1 } }));
      return row;
    });
    this.body.replaceChildren(...this.pool);
    this.applyTemplate();
  }

  private applyTemplate(): void {
    const template = this.template();
    this.header.style.gridTemplateColumns = template;
    for (const row of this.pool) row.style.gridTemplateColumns = template;
  }

  private renderHeader(): void {
    // A sort click rebuilds the header: the focus goes back to the same column's button.
    const had = document.activeElement as HTMLElement | null;
    const refocus = had && this.header.contains(had) ? had.dataset.focus : undefined;
    this.header.replaceChildren(
      ...this.model.columns.map((column, index) => {
        const active = this.sort?.column === column.name;
        const sorted = active ? (this.sort?.descending ? "descending" : "ascending") : "none";
        const sortButton = h(
          "button",
          {
            class: "vt-sort",
            title: `${column.name}${column.type ? ` (${column.type})` : ""}. Sort · Alt+←/→ resizes`,
            attrs: { tabindex: -1, "data-focus": `th:${column.name}` },
            on: {
              click: () => this.toggleSort(column.name),
              keydown: (event) => {
                const delta = event.altKey ? keyboardResizeDelta(event.key, event.shiftKey) : 0;
                if (delta) {
                  event.preventDefault();
                  this.resize(index, delta, true);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  this.focus = { row: 0, column: index };
                  this.viewport.focus();
                }
              },
            },
          },
          [
            h("span", { class: "vt-name", text: column.name }),
            active
              ? h("span", {
                  class: `codicon codicon-arrow-${this.sort?.descending ? "down" : "up"}`,
                  attrs: { "aria-hidden": "true" },
                })
              : null,
          ],
        );
        const handle = h("div", {
          class: "vt-resize",
          title: "Drag to resize; double-click to fit",
          attrs: { "aria-hidden": "true" },
          on: {
            pointerdown: (event) => this.startResize(event, index, handle),
            dblclick: () => this.fit(index),
            click: (event) => event.stopPropagation(),
          },
        });
        return h(
          "div",
          {
            class: "vt-th",
            attrs: { role: "columnheader", "aria-sort": sorted, "aria-colindex": index + 1 },
          },
          [sortButton, handle],
        );
      }),
    );
    if (refocus)
      this.header
        .querySelector<HTMLElement>(`[data-focus="${CSS.escape(refocus)}"]`)
        ?.focus({ preventScroll: true });
  }

  private startResize(event: PointerEvent, index: number, handle: HTMLElement): void {
    event.preventDefault();
    event.stopPropagation();
    const start = event.clientX;
    const startWidths = [...this.widths];
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    const onMove = (e: PointerEvent) => {
      this.widths = resizeColumn(startWidths, index, e.clientX - start);
      this.applyTemplate();
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      this.remember(index);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  private resize(index: number, delta: number, announceIt = false): void {
    this.widths = resizeColumn(this.widths, index, delta);
    this.applyTemplate();
    this.remember(index);
    if (announceIt)
      announce(`${this.model.columns[index]?.name ?? "Column"} ${this.widths[index]} pixels wide`);
  }

  /** Fit a column to its header and the visible cells. */
  private fit(index: number): void {
    const name = this.model.columns[index]?.name ?? "";
    const [width] = initialWidths(
      [name],
      (_c, r) => {
        const row = this.shown[r];
        return row === undefined ? 0 : this.model.text(row, index).length;
      },
      this.shown.length,
      { sample: 500 },
    );
    if (width) this.resize(index, width - (this.widths[index] ?? width));
  }

  private remember(index: number): void {
    const name = this.model.columns[index]?.name;
    const width = this.widths[index];
    if (name !== undefined && width !== undefined) this.chosenWidths.set(name, width);
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

  /** Draw the rows in view into the pool: text and classes only, no element created. */
  private render(): void {
    const columns = this.model.columns;
    const window_ = rowWindow({
      scrollTop: this.viewport.scrollTop,
      viewportHeight: this.viewport.clientHeight,
      rowHeight: ROW_HEIGHT,
      count: this.shown.length,
      overscan: OVERSCAN,
      headerHeight: this.header.offsetHeight,
    });
    const needed = window_.last - window_.first;
    if (needed > this.pool.length) this.buildPool();
    const key = `${window_.first}:${window_.last}:${this.focus.row}:${this.focus.column}`;
    if (key === this.windowKey) return;
    this.windowKey = key;
    this.body.style.transform = `translateY(${window_.offset}px)`;
    const kinds = this.model.kinds;
    this.pool.forEach((element, slot) => {
      const position = window_.first + slot;
      const index = this.shown[position];
      if (index === undefined || position >= window_.last) {
        if (!element.hidden) element.hidden = true;
        return;
      }
      if (element.hidden) element.hidden = false;
      element.setAttribute("aria-rowindex", String(position + 2));
      element.dataset.row = String(position);
      setClass(element, "odd", position % 2 === 1);
      const cells = element.children;
      for (let c = 0; c < columns.length; c++) {
        const cell = cells[c] as HTMLElement | undefined;
        if (!cell) continue;
        const text = this.model.text(index, c);
        setText(cell, text);
        const long = text.length > 40 ? text.slice(0, 2000) : "";
        if (cell.title !== long) cell.title = long;
        setClass(cell, "number", kinds[c] === "number");
        setClass(cell, "empty", text === "");
        const focused = this.focus.row === position && this.focus.column === c;
        setClass(cell, "focused", focused);
        if (focused) cell.id = "vt-active";
        else if (cell.id) cell.removeAttribute("id");
      }
    });
    if (columns.length > 0 && this.shown.length > 0)
      this.viewport.setAttribute("aria-activedescendant", "vt-active");
    else this.viewport.removeAttribute("aria-activedescendant");
  }

  private paintFocus(): void {
    this.windowKey = "";
    this.render();
  }

  private moveFocus(): void {
    const top = revealRow({
      row: this.focus.row,
      rowHeight: ROW_HEIGHT,
      scrollTop: this.viewport.scrollTop,
      viewportHeight: this.viewport.clientHeight,
      headerHeight: this.header.offsetHeight,
    });
    if (top !== undefined) this.viewport.scrollTop = top;
    // Keep the focused column in view horizontally as well.
    const left = this.widths.slice(0, this.focus.column).reduce((a, b) => a + b, 0);
    const width = this.widths[this.focus.column] ?? 0;
    if (left < this.viewport.scrollLeft) this.viewport.scrollLeft = left;
    else if (left + width > this.viewport.scrollLeft + this.viewport.clientWidth)
      this.viewport.scrollLeft = left + width - this.viewport.clientWidth;
    this.paintFocus();
    if (document.activeElement !== this.viewport) this.viewport.focus({ preventScroll: true });
  }

  private cellAt(target: EventTarget | null): { row: number; column: number } | undefined {
    const cell = (target as HTMLElement | null)?.closest?.(".vt-td") as HTMLElement | null;
    const row = cell?.parentElement?.dataset.row;
    if (!cell || row === undefined) return undefined;
    const column = Array.prototype.indexOf.call(cell.parentElement?.children ?? [], cell) as number;
    return { row: Number(row), column };
  }

  private onClick(event: MouseEvent): void {
    const at = this.cellAt(event.target);
    if (!at) return;
    this.focus = at;
    this.moveFocus();
  }

  private onContextMenu(event: MouseEvent): void {
    const at = this.cellAt(event.target);
    if (!at) return;
    event.preventDefault();
    this.focus = at;
    this.moveFocus();
    this.openCellMenu({ x: event.clientX, y: event.clientY });
  }

  private openCellMenu(at: { x: number; y: number } | undefined): void {
    const text = this.focusedCell();
    const row = this.focusedRow();
    const column = this.model.columns[this.focus.column]?.name;
    if (text === undefined || !row || column === undefined) return;
    const anchor = document.getElementById("vt-active");
    const where = at ?? (anchor ? { anchor } : { x: 40, y: 40 });
    // After a menu action the focus returns to the grid, on the same cell.
    const back = (action: () => void) => () => {
      action();
      this.viewport.focus({ preventScroll: true });
    };
    showMenu(
      [
        {
          label: "Copy cell",
          icon: "copy",
          description: "Ctrl+C",
          run: back(() => this.options.onCopy("cell", text)),
        },
        {
          label: "Copy row as JSON",
          icon: "json",
          description: "Ctrl+Shift+C",
          run: back(() => this.options.onCopy("row", JSON.stringify(row))),
        },
        "separator",
        {
          label: `Filter ${column} to this value`,
          icon: "filter",
          disabled: text === "",
          run: back(() => this.filterTo(column, text)),
        },
        {
          label: "Clear filter",
          icon: "clear-all",
          disabled: this.filterInput.value === "",
          run: back(() => this.filterTo("", "")),
        },
        "separator",
        {
          label: `Sort by ${column}`,
          icon: "sort-precedence",
          run: back(() => this.toggleSort(column)),
        },
      ],
      where,
      "Cell",
    );
  }

  private filterTo(column: string, text: string): void {
    this.filterInput.value = text;
    this.columnSelect.value = column;
    this.pendingColumn = undefined;
    this.changed();
    this.viewport.focus();
  }

  private onKey(event: KeyboardEvent): void {
    const rows = this.shown.length;
    const columns = this.model.columns.length;
    if (rows === 0 || columns === 0) return;
    const page = pageRows(this.viewport.clientHeight, ROW_HEIGHT);
    const { row, column } = this.focus;
    const moves: Record<string, () => void> = {
      ArrowDown: () => (this.focus.row = Math.min(rows - 1, row + 1)),
      ArrowUp: () => {
        if (row === 0) {
          this.header.querySelector<HTMLElement>(`.vt-th:nth-child(${column + 1}) .vt-sort`)?.focus();
          return;
        }
        this.focus.row = row - 1;
      },
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
    if (move && !event.altKey) {
      event.preventDefault();
      move();
      if (document.activeElement === this.viewport) this.moveFocus();
      return;
    }
    const current = this.focusedRow();
    const name = this.model.columns[this.focus.column]?.name;
    if (!current || name === undefined) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      if (event.shiftKey) this.options.onCopy("row", JSON.stringify(current));
      else this.options.onCopy("cell", cellText(current[name]));
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      this.openCellMenu(undefined);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey || !this.options.onActivate) this.toggleSort(name);
      else this.options.onActivate(current);
    } else if (event.key === "/" || (event.ctrlKey && event.key.toLowerCase() === "f")) {
      // VS Code's find widget is for the page; "/" goes to the table's own filter.
      if (event.key === "/") {
        event.preventDefault();
        this.filterInput.focus();
      }
    }
  }
}
