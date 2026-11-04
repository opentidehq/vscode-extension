// Terminal links (SPEC §11): object UUIDs open the object, `error[<code>]` opens Explain. vscode-free.
import { findByUuid } from "../../core/catalog/rows";
import type { CatalogObject } from "../../core/catalog/types";

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

/**
 * What a UUID link opens: the first folder's object with that UUID (a loaded object before a file that
 * did not load and carries it). Rows without a UUID, such as most files that did not load, are skipped.
 */
export function linkedObject(
  catalogs: Iterable<readonly CatalogObject[] | undefined>,
  uuid: string,
): { name: string; file_path: string; line: number } | undefined {
  for (const objects of catalogs) {
    const object = findByUuid(objects ?? [], uuid);
    if (object?.file_path)
      return { name: object.name || object.file_path, file_path: object.file_path, line: object.line };
  }
  return undefined;
}
