// Column widths for the kit's table: a first guess from the header and a sample of the cells, and
// resizing by drag or keyboard within bounds. vscode-free, DOM-free.

export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 1200;
/** The widest a column starts, however long its values. */
export const MAX_INITIAL_WIDTH = 420;

export interface SizingOptions {
  /** Pixels per character of the editor font (monospace). */
  readonly charWidth?: number;
  /** Rows sampled per column: sizing stays O(columns × sample), whatever the row count. */
  readonly sample?: number;
  /** Cell padding plus the sort indicator, in px. */
  readonly padding?: number;
}

/**
 * Each column's starting width: its longest text among the header and the first `sample` cells, between
 * the minimum and MAX_INITIAL_WIDTH.
 */
export function initialWidths(
  columns: readonly string[],
  cellLength: (column: number, row: number) => number,
  rowCount: number,
  options: SizingOptions = {},
): number[] {
  const charWidth = options.charWidth ?? 7.5;
  const padding = options.padding ?? 28;
  const sample = Math.min(rowCount, options.sample ?? 200);
  return columns.map((name, c) => {
    let longest = name.length + 2;
    for (let r = 0; r < sample; r++) longest = Math.max(longest, cellLength(c, r));
    return Math.round(Math.min(MAX_INITIAL_WIDTH, Math.max(80, longest * charWidth + padding)));
  });
}

/** `widths` with column `index` changed by `delta` px, kept within the bounds. */
export function resizeColumn(
  widths: readonly number[],
  index: number,
  delta: number,
  min = MIN_COLUMN_WIDTH,
  max = MAX_COLUMN_WIDTH,
): number[] {
  return widths.map((width, i) =>
    i === index ? Math.round(Math.min(max, Math.max(min, width + delta))) : width,
  );
}

/** A keyboard resize step: Alt+Left/Right by 16 px, with Shift by 64. */
export function keyboardResizeDelta(key: string, shift: boolean): number {
  const step = shift ? 64 : 16;
  return key === "ArrowRight" ? step : key === "ArrowLeft" ? -step : 0;
}

/** The CSS grid template for the widths. */
export function gridTemplate(widths: readonly number[]): string {
  return widths.map((w) => `${w}px`).join(" ");
}
