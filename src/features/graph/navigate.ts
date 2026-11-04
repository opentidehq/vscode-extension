// Moving the selection with the arrow keys on the canvas: to the neighbour that lies that way, else to
// the nearest drawn node that way. vscode-free and DOM-free.
import type { Point } from "./layout";

export type ArrowDirection = "left" | "right" | "up" | "down";

export function arrowDirection(key: string): ArrowDirection | undefined {
  switch (key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    default:
      return undefined;
  }
}

const AXIS: Readonly<Record<ArrowDirection, Point>> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

/**
 * The candidate that lies in `direction` from `from` (within 60° of it), the closest first, an
 * off-axis one counting as farther. `candidates` are tried in order: the neighbours, then every node.
 */
export function nodeInDirection(
  from: Point,
  direction: ArrowDirection,
  ...candidates: readonly (readonly (readonly [string, Point])[])[]
): string | undefined {
  const axis = AXIS[direction];
  for (const group of candidates) {
    let best: string | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [id, point] of group) {
      const dx = point.x - from.x;
      const dy = point.y - from.y;
      const along = dx * axis.x + dy * axis.y;
      if (along <= 0) continue;
      const across = Math.abs(dx * axis.y - dy * axis.x);
      // tan 60° ≈ 1.73: wider than that is another direction.
      if (across > along * 1.73) continue;
      const score = along + across * 2;
      if (score < bestScore || (score === bestScore && best !== undefined && id < best)) {
        best = id;
        bestScore = score;
      }
    }
    if (best !== undefined) return best;
  }
  return undefined;
}
