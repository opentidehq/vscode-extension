// `# opentide:placeholder` lines, the values to select on them, and the "Mark as done" edit (SPEC §7
// "Placeholders"). Offsets are UTF-16, like VS Code's and JavaScript's strings. vscode-free.

/** The marker `opentide new` ends every placeholder line with, and the spaces before it. */
const MARKER = /\s*#\s*opentide:placeholder\s*$/;

export interface Span {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

/** 0-based lines that carry the marker. Commented-out keys (`#key: …`) are skipped. */
export function placeholderLines(lines: readonly string[]): number[] {
  const out: number[] = [];
  lines.forEach((text, line) => {
    if (MARKER.test(text) && !/^\s*#/.test(text)) out.push(line);
  });
  return out;
}

/** The value text of a line without the marker: after `key:` or `- `, trimmed. */
function valueRange(text: string): { start: number; end: number } {
  const marker = MARKER.exec(text);
  const end = marker ? marker.index : text.length;
  const head = text.slice(0, end);
  const key = /^(\s*(?:-\s+)?)([^\s#'"][^:]*?|"[^"]*"|'[^']*'):(\s+|$)/.exec(head);
  let start: number;
  if (key) start = key[0].length;
  else {
    const item = /^\s*-\s+/.exec(head);
    start = item ? item[0].length : head.length - head.trimStart().length;
  }
  let stop = end;
  while (stop > start && /\s/.test(head[stop - 1] ?? "")) stop--;
  return { start, end: Math.max(start, stop) };
}

/** A block scalar's indicator (`|`, `>`, `|-`, `>+2`…). */
const isBlockIndicator = (value: string): boolean => /^[|>][+-]?\d?[+-]?$/.test(value);

/**
 * What "Next placeholder" selects: the value on the line, or for a block scalar (`description: |`) the
 * first line of the block. An empty value selects nothing at the end of the key.
 */
export function placeholderSelection(lines: readonly string[], line: number): Span {
  const text = lines[line] ?? "";
  const { start, end } = valueRange(text);
  const value = text.slice(start, end);
  if (isBlockIndicator(value)) {
    const next = lines[line + 1];
    if (next?.trim()) {
      const indent = next.length - next.trimStart().length;
      return { line: line + 1, start: indent, end: next.trimEnd().length };
    }
  }
  return { line, start, end };
}

/** The next (or previous) placeholder line after (before) `from`, wrapping around; undefined when none. */
export function nextPlaceholder(
  placeholders: readonly number[],
  from: number,
  direction: 1 | -1,
): number | undefined {
  if (placeholders.length === 0) return undefined;
  if (direction === 1) return placeholders.find((line) => line > from) ?? placeholders[0];
  return [...placeholders].reverse().find((line) => line < from) ?? placeholders[placeholders.length - 1];
}

/** The text a placeholder holds: its value, or the block's lines for a block scalar. */
export function placeholderValue(lines: readonly string[], line: number): string {
  const text = lines[line] ?? "";
  const { start, end } = valueRange(text);
  const value = text.slice(start, end);
  if (!isBlockIndicator(value)) return value;
  const indent = text.length - text.trimStart().length;
  const block: string[] = [];
  for (let next = line + 1; next < lines.length; next++) {
    const body = lines[next] ?? "";
    if (body.trim() && body.length - body.trimStart().length <= indent) break;
    block.push(body.trim());
  }
  return block.join("\n").trim();
}

/** A placeholder's identity across edits: its key path text and how many same-keyed lines come before. */
export function placeholderKey(lines: readonly string[], line: number): string {
  const head = (text: string): string => text.slice(0, valueRange(text).start).trim();
  const key = head(lines[line] ?? "");
  const earlier = placeholderLines(lines).filter(
    (other) => other < line && head(lines[other] ?? "") === key,
  ).length;
  return `${key}#${earlier}`;
}

/** The values of every placeholder, by key: what `opentide new` wrote, to tell an edited one apart. */
export function placeholderSnapshot(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of placeholderLines(lines))
    out.set(placeholderKey(lines, line), placeholderValue(lines, line));
  return out;
}

/** Values `opentide new` writes for a value nobody chose yet. */
const UNFILLED = new Set(["", "...", "…"]);

/**
 * Whether "Mark as done" applies to this placeholder line: its value differs from the one first seen
 * (`original`), or, with nothing seen, it is no longer the template's `...`.
 */
export function isChanged(lines: readonly string[], line: number, original: string | undefined): boolean {
  const value = placeholderValue(lines, line);
  if (original !== undefined) return value !== original && !UNFILLED.has(value);
  return !UNFILLED.has(value);
}

/** The range "Mark as done" deletes: the marker and the spaces before it. */
export function markerRange(lines: readonly string[], line: number): Span | undefined {
  const text = lines[line] ?? "";
  const marker = MARKER.exec(text);
  return marker ? { line, start: marker.index, end: text.length } : undefined;
}
