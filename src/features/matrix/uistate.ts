// What the matrix panel keeps in the webview's own state (`setState`), so a hidden panel that VS Code
// disposed (no retainContextWhenHidden) comes back as it was. The selected technique is not here: the
// host owns it and re-posts its detail when the page says `ready`. vscode-free and DOM-free.

export interface UiState {
  /** Techniques whose sub-techniques are shown. */
  expanded: string[];
  find: string;
  hideEmpty: boolean;
  /** The grid's scroll offset. */
  scroll: { left: number; top: number };
  /** The focused cell, as `column:technique` (roving tabindex). */
  focused: string | undefined;
}

const offset = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** The saved state, field by field: anything of the wrong shape falls back to its default. */
export function restoreUi(saved: unknown): UiState {
  const s = typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>) : {};
  const scroll =
    typeof s.scroll === "object" && s.scroll !== null ? (s.scroll as Record<string, unknown>) : {};
  return {
    expanded: Array.isArray(s.expanded) ? s.expanded.filter((e): e is string => typeof e === "string") : [],
    find: typeof s.find === "string" ? s.find : "",
    hideEmpty: s.hideEmpty === true,
    scroll: { left: offset(scroll.left), top: offset(scroll.top) },
    focused: typeof s.focused === "string" && /^\d+:/.test(s.focused) ? s.focused : undefined,
  };
}
