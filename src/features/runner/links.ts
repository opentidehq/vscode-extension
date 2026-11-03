// Terminal links (SPEC §11): object UUIDs open the object, `error[<code>]` opens Explain. vscode-free.

export interface TerminalMatch {
  readonly start: number;
  readonly length: number;
  readonly kind: "uuid" | "code";
  /** The UUID (lower case) or the diagnostic code. */
  readonly value: string;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CODE = /\b(?:error|warning|note|help)\[([a-z][a-z0-9_]*)\]/g;

/** The links in one terminal line, in order. */
export function terminalMatches(line: string): TerminalMatch[] {
  const out: TerminalMatch[] = [];
  for (const match of line.matchAll(UUID)) {
    out.push({ start: match.index, length: match[0].length, kind: "uuid", value: match[0].toLowerCase() });
  }
  for (const match of line.matchAll(CODE)) {
    out.push({ start: match.index, length: match[0].length, kind: "code", value: match[1] ?? "" });
  }
  return out.sort((a, b) => a.start - b.start);
}
