// Keyboard movement in the kit's menus (export menu, a table cell's context menu). vscode-free, DOM-free.

/** The item index a key moves to among `enabled` flags, or undefined for keys that do not move. */
export function menuMove(key: string, index: number, enabled: readonly boolean[]): number | undefined {
  const count = enabled.length;
  if (count === 0 || !enabled.some(Boolean)) return undefined;
  const step = (from: number, delta: number): number => {
    let at = from;
    for (let i = 0; i < count; i++) {
      at = (at + delta + count) % count;
      if (enabled[at]) return at;
    }
    return from;
  };
  switch (key) {
    case "ArrowDown":
      return step(index, 1);
    case "ArrowUp":
      return step(index < 0 ? 0 : index, -1);
    case "Home":
      return step(-1, 1);
    case "End":
      return step(0, -1);
    default:
      return undefined;
  }
}

/** Where a menu or hover card goes: below the anchor, flipped above or left to stay in the viewport. */
export function placePopup(input: {
  readonly anchor: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  readonly size: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly align?: "start" | "end";
  readonly gap?: number;
}): { left: number; top: number } {
  const gap = input.gap ?? 4;
  const { anchor, size, viewport } = input;
  let left = input.align === "end" ? anchor.right - size.width : anchor.left;
  left = Math.max(4, Math.min(left, viewport.width - size.width - 4));
  let top = anchor.bottom + gap;
  if (top + size.height > viewport.height - 4 && anchor.top - gap - size.height >= 4)
    top = anchor.top - gap - size.height;
  return { left: Math.round(left), top: Math.round(Math.max(4, top)) };
}
