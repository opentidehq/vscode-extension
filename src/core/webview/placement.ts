// Where an object's panel opens and which panel shows it (SPEC §10 "Beside the object"). vscode-free.
//
// A panel about an object opens beside the editor it was invoked from, without taking the focus, and each
// kind of panel keeps one tab: a new object retargets the panel instead of opening another. A locked
// (pinned) panel stays on its object; the next object opens a panel of its own.

/** One open panel of a kind, as the pool sees it. */
export interface PoolEntry<T> {
  /** What the panel shows now. */
  readonly target: T;
  /** Pinned to its object: never retargeted. */
  readonly locked: boolean;
}

/** What to do for a target: show the panel that has it, retarget a free one, or open a new one. */
export type PoolChoice<E> =
  | { readonly kind: "reveal"; readonly entry: E }
  | { readonly kind: "retarget"; readonly entry: E }
  | { readonly kind: "create" };

/**
 * The open panels of one kind, most recently used last. `same` says whether two targets are the same
 * object (a panel already showing it is revealed, locked or not).
 */
export class PanelPool<T, E extends PoolEntry<T>> {
  private entries: E[] = [];

  constructor(private readonly same: (a: T, b: T) => boolean) {}

  /** The panel for `target`: one showing it, else the most recently used unlocked one, else none. */
  choose(target: T): PoolChoice<E> {
    const showing = [...this.entries].reverse().find((entry) => this.same(entry.target, target));
    if (showing) return { kind: "reveal", entry: showing };
    const free = [...this.entries].reverse().find((entry) => !entry.locked);
    return free ? { kind: "retarget", entry: free } : { kind: "create" };
  }

  add(entry: E): void {
    this.entries = [...this.entries.filter((e) => e !== entry), entry];
  }

  /** The panel became active (or was shown): it is the first to be retargeted next. */
  touch(entry: E): void {
    if (this.entries.includes(entry)) this.add(entry);
  }

  remove(entry: E): void {
    this.entries = this.entries.filter((e) => e !== entry);
  }

  all(): readonly E[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }
}

/** `name`, cut to `max` characters with an ellipsis at a word boundary when one is near. */
export function shorten(name: string, max = 28): string {
  const text = name.trim().replace(/\s+/g, " ");
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s·,;:-]+$/, "")}…`;
}

/** A panel's tab title: what it is, then the object, then its context ("Query · LSASS handle… · Sentinel"). */
export function panelTitle(kind: string, object?: string | null, context?: string | null): string {
  return [kind, object ? shorten(object) : null, context || null].filter(Boolean).join(" · ");
}

/** Where a panel opens: beside the editor it came from (keeping the focus there), else in the active group. */
export interface Placement {
  readonly beside: boolean;
  readonly preserveFocus: boolean;
}

export function placement(fromEditor: boolean): Placement {
  return fromEditor ? { beside: true, preserveFocus: true } : { beside: false, preserveFocus: false };
}

/**
 * The editor column a file opened from a panel goes to: beside the panel when the panel is in the first
 * group (so the panel stays visible), else the group left of it, where the object's editor is.
 * `undefined` means "beside".
 */
export function fileColumnFrom(panelColumn: number | undefined): number | undefined {
  return panelColumn !== undefined && panelColumn > 1 ? panelColumn - 1 : undefined;
}
