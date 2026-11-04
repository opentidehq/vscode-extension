// CLI positions (1-based lines, 1-based columns in Unicode code points) to editor positions (0-based
// lines, 0-based UTF-16 offsets). vscode-free; `toVsRange` in core/vscodePositions.ts wraps it.

export interface Position0 {
  readonly line: number;
  readonly character: number;
}

export interface Range0 {
  readonly start: Position0;
  readonly end: Position0;
}

/** The text of a document, line by line (a `vscode.TextDocument` qualifies through `lineAt`). */
export interface LineSource {
  readonly lineCount: number;
  lineText(line0: number): string;
}

/** The UTF-16 offset of 1-based code-point column `column1` in `text`, clamped to the line. */
export function codePointColumnToUtf16(text: string, column1: number): number {
  if (!Number.isFinite(column1) || column1 <= 1) return 0;
  let offset = 0;
  let points = 1;
  while (points < column1 && offset < text.length) {
    const code = text.codePointAt(offset) ?? 0;
    offset += code > 0xffff ? 2 : 1;
    points++;
  }
  return offset;
}

/** The 1-based code-point column of UTF-16 offset `character` (the inverse, for sending positions to the CLI). */
export function utf16ToCodePointColumn(text: string, character: number): number {
  let points = 1;
  let offset = 0;
  while (offset < character && offset < text.length) {
    const code = text.codePointAt(offset) ?? 0;
    offset += code > 0xffff ? 2 : 1;
    points++;
  }
  return points;
}

function clampLine(source: LineSource, line1: number): number {
  const line0 = Math.max(0, Math.floor(line1) - 1);
  return Math.min(line0, Math.max(0, source.lineCount - 1));
}

/** A CLI position. Without a column, the start of the line. */
export function cliPosition(source: LineSource, line1: number, column1?: number | null): Position0 {
  const line = clampLine(source, line1);
  const text = source.lineCount > 0 ? source.lineText(line) : "";
  return { line, character: column1 == null ? 0 : codePointColumnToUtf16(text, column1) };
}

export interface CliSpan {
  readonly line: number;
  readonly column?: number | null;
  readonly end_line?: number | null;
  /** Exclusive, 1-based code points. */
  readonly end_column?: number | null;
}

/**
 * A CLI span as an editor range. No column: the whole line. No end column: to the end of the end line
 * when `end_line` differs, else a one-character range clamped to the line.
 */
export function cliRange(source: LineSource, span: CliSpan): Range0 {
  const startLine = clampLine(source, span.line);
  const startText = source.lineCount > 0 ? source.lineText(startLine) : "";
  if (span.column == null) {
    const endLine = span.end_line == null ? startLine : clampLine(source, span.end_line);
    const endText = source.lineCount > 0 ? source.lineText(endLine) : "";
    return { start: { line: startLine, character: 0 }, end: { line: endLine, character: endText.length } };
  }
  const start = { line: startLine, character: codePointColumnToUtf16(startText, span.column) };
  const endLine = span.end_line == null ? startLine : Math.max(startLine, clampLine(source, span.end_line));
  const endText = endLine === startLine ? startText : source.lineText(endLine);
  let endCharacter: number;
  if (span.end_column != null) endCharacter = codePointColumnToUtf16(endText, span.end_column);
  else if (endLine !== startLine) endCharacter = endText.length;
  else endCharacter = Math.min(endText.length, start.character + 1);
  if (endLine === startLine && endCharacter < start.character) endCharacter = start.character;
  return { start, end: { line: endLine, character: endCharacter } };
}

/** A `LineSource` over a string. */
export function linesOf(text: string): LineSource {
  const lines = text.split(/\r\n|\r|\n/);
  return { lineCount: lines.length, lineText: (line0) => lines[line0] ?? "" };
}
