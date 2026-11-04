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

/** A rectangle in viewport coordinates. */
export interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Where a menu or hover card goes: below the anchor, flipped above when there is no room below. With
 * `bounds` (the region it belongs to, such as the matrix's grid), it stays inside them: when it does not
 * fit right of the anchor's left edge, it ends at the anchor's right edge instead, so it never covers
 * what is beside the region (the matrix's side list).
 */
export function placePopup(input: {
  readonly anchor: Box;
  readonly size: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly align?: "start" | "end";
  readonly gap?: number;
  readonly bounds?: Box;
}): { left: number; top: number } {
  const gap = input.gap ?? 4;
  const { anchor, size, viewport } = input;
  const area = input.bounds ?? { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const minLeft = Math.max(4, area.left + 4);
  const maxRight = Math.min(viewport.width, area.right) - 4;
  let left = input.align === "end" ? anchor.right - size.width : anchor.left;
  if (left + size.width > maxRight) left = input.bounds ? anchor.right - size.width : maxRight - size.width;
  left = Math.max(minLeft, Math.min(left, maxRight - size.width));
  let top = anchor.bottom + gap;
  if (top + size.height > viewport.height - 4 && anchor.top - gap - size.height >= 4)
    top = anchor.top - gap - size.height;
  return { left: Math.round(left), top: Math.round(Math.max(4, top)) };
}
