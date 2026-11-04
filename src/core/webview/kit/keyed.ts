// Keyed updates: what changes between two lists of keys, so a view updates the items that changed instead
// of rebuilding everything (SPEC §14: no full re-render on a state update). vscode-free, DOM-free.

export interface KeyedPlan {
  /** Keys that leave. */
  readonly remove: readonly string[];
  /** Keys that arrive. */
  readonly add: readonly string[];
  /** Keys in both, whose items are updated in place. */
  readonly keep: readonly string[];
  /** Whether the kept and added items end up in a different order than the DOM has them. */
  readonly reorder: boolean;
}

export function keyedPlan(previous: readonly string[], next: readonly string[]): KeyedPlan {
  const before = new Set(previous);
  const after = new Set(next);
  const remove = previous.filter((key) => !after.has(key));
  const add = next.filter((key) => !before.has(key));
  const keep = next.filter((key) => before.has(key));
  const survivors = previous.filter((key) => after.has(key));
  const reorder =
    add.length > 0 ? !isSuffixAppend(previous, next, after) : survivors.some((k, i) => k !== keep[i]);
  return { remove, add, keep, reorder };
}

/** `next` is `previous` (less the removed keys) with new keys only at the end. */
function isSuffixAppend(previous: readonly string[], next: readonly string[], after: Set<string>): boolean {
  const survivors = previous.filter((key) => after.has(key));
  for (let i = 0; i < survivors.length; i++) if (next[i] !== survivors[i]) return false;
  return true;
}

/** A cheap fingerprint of an item's displayed data: re-render it only when this changes. */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value) ?? "";
}
