// Back and Forward through the graph's selection (Alt+← / Alt+→, the toolbar's arrows), as an editor's
// navigation history: a new selection after going back drops what was ahead. vscode-free and DOM-free.

export class SelectionHistory {
  private entries: string[] = [];
  private index = -1;

  constructor(private readonly limit = 100) {}

  get current(): string | undefined {
    return this.entries[this.index];
  }

  get canBack(): boolean {
    return this.index > 0;
  }

  get canForward(): boolean {
    return this.index < this.entries.length - 1;
  }

  /** Record a selection; the same node again is not a new entry. */
  visit(id: string): void {
    if (this.current === id) return;
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(id);
    if (this.entries.length > this.limit) this.entries = this.entries.slice(this.entries.length - this.limit);
    this.index = this.entries.length - 1;
  }

  back(): string | undefined {
    if (!this.canBack) return undefined;
    this.index -= 1;
    return this.current;
  }

  forward(): string | undefined {
    if (!this.canForward) return undefined;
    this.index += 1;
    return this.current;
  }

  /**
   * Drop the entries `keep` rejects (nodes no longer in the catalogue) and the repeats that leaves
   * side by side; the current entry stays the closest one kept.
   */
  retain(keep: (id: string) => boolean): void {
    const next: string[] = [];
    let index = -1;
    this.entries.forEach((id, at) => {
      if (!keep(id)) return;
      if (next[next.length - 1] !== id) next.push(id);
      if (at <= this.index) index = next.length - 1;
    });
    this.entries = next;
    this.index = next.length === 0 ? -1 : Math.max(0, index);
  }

  clear(): void {
    this.entries = [];
    this.index = -1;
  }
}

export interface Pointed {
  readonly selected: string | undefined;
  readonly hovered: string | undefined;
}

/**
 * The selected and hovered nodes once a catalogue change has been applied: a selection the model no
 * longer has, or a hover over a node no longer drawn, is gone, so its emphasis and details do not
 * outlive it (a removed node never gets its mouseout).
 */
export function withoutGone(
  pointed: Pointed,
  inModel: (id: string) => boolean,
  drawn: (id: string) => boolean,
): Pointed {
  return {
    selected: pointed.selected !== undefined && inModel(pointed.selected) ? pointed.selected : undefined,
    hovered: pointed.hovered !== undefined && drawn(pointed.hovered) ? pointed.hovered : undefined,
  };
}
