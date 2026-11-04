// `has:placeholders` from the files themselves: the `# opentide:placeholder` lines `opentide new` writes,
// counted as the editor counts them. Only `opentide lint` reports a `placeholder` finding, and with the
// default settings lint runs on the files saved this session only, so a draft nobody saved matched
// nothing (#48). vscode-free: the file reads are injected.
import { placeholderLines } from "../new-object/placeholders";

export interface PlaceholderSources {
  /** The text of an open editor for `file` (it may have unsaved edits), or undefined. */
  openText(file: string): string | undefined;
  /** What changes when the file does (size and mtime), or undefined when it cannot be read. */
  stamp(file: string): string | undefined;
  read(file: string): string | undefined;
}

export function countPlaceholders(text: string): number {
  return placeholderLines(text.split(/\r?\n/)).length;
}

/** Placeholder lines per file, read once per version of the file. */
export class PlaceholderCounts {
  private readonly cache = new Map<string, { readonly stamp: string; readonly count: number }>();

  constructor(private readonly sources: PlaceholderSources) {}

  count(file: string): number {
    const open = this.sources.openText(file);
    if (open !== undefined) return countPlaceholders(open);
    const stamp = this.sources.stamp(file);
    if (stamp === undefined) return 0;
    const known = this.cache.get(file);
    if (known?.stamp === stamp) return known.count;
    const text = this.sources.read(file);
    const count = text === undefined ? 0 : countPlaceholders(text);
    this.cache.set(file, { stamp, count });
    return count;
  }
}

/** Whether a query asks about placeholders (`has:placeholder`, `has:placeholders`, negated or not). */
export function asksPlaceholders(
  filters: readonly { readonly key: string; readonly value: string }[],
): boolean {
  return filters.some((filter) => filter.key === "has" && /^placeholders?$/.test(filter.value));
}
