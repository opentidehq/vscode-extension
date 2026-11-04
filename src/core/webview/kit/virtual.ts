// Window math for virtualised lists and tables: which rows to draw for a scroll position, and where to
// scroll to keep a row in view. vscode-free, DOM-free.

export interface WindowInput {
  readonly scrollTop: number;
  /** The scrolling element's client height; 0 before layout (then `fallbackHeight`). */
  readonly viewportHeight: number;
  readonly rowHeight: number;
  readonly count: number;
  /** Rows drawn above and below the visible ones, so a fast scroll shows no gap. */
  readonly overscan?: number;
  /** A sticky header inside the scrolling element, above the first row. */
  readonly headerHeight?: number;
  readonly fallbackHeight?: number;
}

export interface RowWindow {
  /** The first row to draw. */
  readonly first: number;
  /** One past the last row to draw. */
  readonly last: number;
  /** Where the first drawn row sits, in px from the top of the rows. */
  readonly offset: number;
  /** The height of every row together: the spacer that gives the scrollbar its size. */
  readonly total: number;
}

export function rowWindow(input: WindowInput): RowWindow {
  const rowHeight = Math.max(1, input.rowHeight);
  const overscan = Math.max(0, input.overscan ?? 8);
  const height = input.viewportHeight > 0 ? input.viewportHeight : (input.fallbackHeight ?? 400);
  const count = Math.max(0, input.count);
  const top = Math.max(0, input.scrollTop - (input.headerHeight ?? 0));
  const first = Math.min(count, Math.max(0, Math.floor(top / rowHeight) - overscan));
  const last = Math.min(count, Math.ceil((top + height) / rowHeight) + overscan);
  return { first, last: Math.max(first, last), offset: first * rowHeight, total: count * rowHeight };
}

/** Rows that fit in the viewport, less one (PageUp/PageDown move this far). */
export function pageRows(viewportHeight: number, rowHeight: number): number {
  return Math.max(1, Math.floor(viewportHeight / Math.max(1, rowHeight)) - 1);
}

/**
 * The scrollTop that brings `row` into view between a sticky header and the bottom edge, or undefined
 * when it is in view already.
 */
export function revealRow(input: {
  readonly row: number;
  readonly rowHeight: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly headerHeight?: number;
}): number | undefined {
  const header = input.headerHeight ?? 0;
  const top = input.row * input.rowHeight;
  if (top < input.scrollTop) return top;
  const visible = input.viewportHeight - header;
  if (top + input.rowHeight > input.scrollTop + visible) return Math.max(0, top + input.rowHeight - visible);
  return undefined;
}
