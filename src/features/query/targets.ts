// Which queries a document holds, from the language server's document symbols (never YAML parsed here),
// and which platforms can run a standalone query file. vscode-free.

/** LSP `SymbolKind` values (1-based, as the protocol sends them). */
export const LSP_SYMBOL_KIND = { Class: 5, Namespace: 3, Object: 19, String: 15 } as const;

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

/** A `DocumentSymbol` as the server sends it. */
export interface LspDocumentSymbol {
  readonly name: string;
  readonly detail?: string | null;
  readonly kind: number;
  readonly range: LspRange;
  readonly selectionRange?: LspRange;
  readonly children?: readonly LspDocumentSymbol[];
}

/** A query in a Tide rule: `configurations.<platform>.<field>`. */
export interface RuleQueryTarget {
  readonly kind: "rule";
  readonly platform: string;
  /** The query's key under the platform block (`query`, `query.0`, …). */
  readonly field: string;
  /** The engine's language id (`kql`, `spl`, `esql`, `eql`, `kuery`, `lucene`, `falco`). */
  readonly language: string;
  readonly range: LspRange;
  /** The rule's `metadata.uuid`, when the outline names one. */
  readonly uuid?: string;
  readonly ruleName: string;
}

/**
 * The queries of a Tide rule. The server's outline is object → sections → (under `configurations`) one
 * node per platform block → one String node per query, whose `detail` is its language.
 */
export function ruleQueryTargets(
  symbols: readonly LspDocumentSymbol[] | null | undefined,
): RuleQueryTarget[] {
  const out: RuleQueryTarget[] = [];
  for (const object of symbols ?? []) {
    if (object.kind !== LSP_SYMBOL_KIND.Class) continue;
    const uuid = object.detail?.trim() || undefined;
    for (const section of object.children ?? []) {
      if (section.name !== "configurations") continue;
      for (const block of section.children ?? []) {
        for (const query of block.children ?? []) {
          if (query.kind !== LSP_SYMBOL_KIND.String || !query.detail) continue;
          out.push({
            kind: "rule",
            platform: block.name,
            field: query.name,
            language: query.detail,
            range: query.range,
            ...(uuid ? { uuid } : {}),
            ruleName: object.name,
          });
        }
      }
    }
  }
  return out;
}

/** Query-file languages (VS Code language ids) and the platforms that run them, in preference order. */
export const QUERY_FILE_PLATFORMS: Readonly<Record<string, readonly string[]>> = {
  kql: ["sentinel", "defender_for_endpoint"],
  spl: ["splunk"],
  esql: ["elastic"],
  eql: ["elastic"],
  kuery: ["elastic"],
  lucene: ["elastic", "carbon_black_cloud"],
};

/** Languages the language server compiles (`opentide/compiledKql`, `opentide/compiledSpl`). */
export function compiledMethod(
  language: string,
): "opentide/compiledKql" | "opentide/compiledSpl" | undefined {
  if (language === "kql") return "opentide/compiledKql";
  if (language === "spl") return "opentide/compiledSpl";
  return undefined;
}

/** `--language` for a query on Elastic; other platforms have one language. */
export function elasticLanguage(platform: string, language: string): string | undefined {
  return platform === "elastic" && ["esql", "eql", "lucene", "kuery"].includes(language)
    ? language
    : undefined;
}

/** Elastic Kuery runs as a rule preview, which writes preview alerts: the one write (AGENTS.md). */
export function writesPreviewAlerts(platform: string, language: string): boolean {
  return platform === "elastic" && language === "kuery";
}

/**
 * The query text under an outline range. A block scalar's range starts at its first character and runs
 * to the line after it, so each later line loses the first line's indentation; a quoted scalar loses
 * its quotes.
 */
export function queryText(lines: readonly string[], range: LspRange): string {
  const indent = range.start.character;
  const last =
    range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;
  const out: string[] = [];
  for (let line = range.start.line; line <= last && line < lines.length; line++) {
    let text = lines[line] ?? "";
    if (line === range.start.line)
      text = text.slice(indent, line === range.end.line ? range.end.character : undefined);
    else if (line === range.end.line) text = text.slice(0, range.end.character);
    if (line !== range.start.line) {
      const leading = text.length - text.trimStart().length;
      text = text.slice(Math.min(leading, indent));
    }
    out.push(text);
  }
  while (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
  const joined = out.join("\n");
  if (out.length === 1) {
    const single = joined.trim();
    if (single.length >= 2 && single.startsWith('"') && single.endsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(single);
        if (typeof parsed === "string") return parsed;
      } catch {
        return single.slice(1, -1);
      }
    }
    if (single.length >= 2 && single.startsWith("'") && single.endsWith("'"))
      return single.slice(1, -1).replaceAll("''", "'");
    return single;
  }
  return joined;
}
