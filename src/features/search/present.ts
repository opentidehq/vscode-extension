// What the quick pick shows for a query: results grouped by type, notices, and syntax hints.
// vscode-free: the glue turns these into QuickPickItems.
import type { ItemProblems, SearchOutcome, SearchResult } from "./match";
import type { ParsedQuery } from "./query";
import type { SearchIndex, SearchItem } from "./searchIndex";

export const TYPE_ICONS: Readonly<Record<string, string>> = {
  threat: "warning",
  objective: "target",
  signal: "pulse",
  rule: "shield",
};

const TYPE_GROUPS: Readonly<Record<string, string>> = {
  rule: "Rules",
  objective: "Objectives",
  threat: "Threats",
  signal: "Signals",
};

export interface Hint {
  /** Inserted into the query. */
  readonly token: string;
  readonly description: string;
}

export const HINTS: readonly Hint[] = [
  { token: "type:", description: "rule, objective, threat or signal" },
  { token: "t:", description: "ATT&CK technique; T1003 also finds its sub-techniques" },
  { token: "p:", description: "platform, e.g. sentinel" },
  { token: "s:", description: "status, e.g. production (with p:, on that platform)" },
  { token: "tactic:", description: "e.g. credential-access or TA0006" },
  { token: "actor:", description: "e.g. G0016" },
  { token: "author:", description: "part of the author's name; quote spaces" },
  { token: "tlp:", description: "clear, green, amber, amber+strict or red" },
  { token: "has:errors", description: "errors in Problems, or the file did not load" },
  { token: "has:placeholders", description: "values opentide new left to fill in" },
  { token: "modified:<30d", description: "dates: created, modified, reviewed; >2026-01-01 or <30d" },
  { token: "unreviewed:>90d", description: "rules not reviewed in 90 days (opentide rules unreviewed)" },
  { token: "-", description: "before a word or filter excludes it: -p:splunk" },
];

export type Row =
  | { readonly kind: "separator"; readonly label: string }
  | { readonly kind: "notice"; readonly label: string; readonly detail?: string }
  | { readonly kind: "hint"; readonly hint: Hint }
  | {
      readonly kind: "result";
      readonly result: SearchResult;
      readonly icon: string;
      readonly label: string;
      readonly description: string;
      readonly detail: string;
    };

export interface PresentOptions {
  /** More than one workspace folder: say which one each result is in. */
  readonly folderNames?: ReadonlyMap<string, string>;
  readonly problems?: (item: SearchItem) => ItemProblems | undefined;
  /** At most this many results are listed. */
  readonly limit?: number;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** One line about an item: its techniques, then each platform and status. */
export function describeItem(item: SearchItem): string {
  const parts: string[] = [];
  if (item.techniques.length > 0)
    parts.push(
      item.techniques.length > 3
        ? `${item.techniques.slice(0, 3).join(", ")}, …`
        : item.techniques.join(", "),
    );
  if (item.platforms.length > 0)
    parts.push(item.platforms.map((p) => (p.status ? `${p.id} ${p.status}` : p.id)).join(", "));
  return parts.join(" · ");
}

export function detailItem(item: SearchItem, options: PresentOptions): string {
  const parts: string[] = [];
  const folder = options.folderNames?.get(item.folder);
  parts.push(folder ? `${folder}: ${item.path}` : item.path);
  if (item.loadError) parts.push(`$(error) failed to load: ${item.loadError}`);
  const problems = options.problems?.(item);
  if (problems?.errors) parts.push(`$(error) ${plural(problems.errors, "error")}`);
  if (problems?.warnings) parts.push(`$(warning) ${plural(problems.warnings, "warning")}`);
  if (item.type === "signal") parts.push("signal");
  return parts.join("  ");
}

/** The rows for a query: notices first, then results grouped by type with counts. */
export function present(
  query: ParsedQuery,
  index: SearchIndex,
  outcome: SearchOutcome | undefined,
  options: PresentOptions = {},
): Row[] {
  const rows: Row[] = [];
  if (query.problems.length > 0) {
    rows.push({
      kind: "notice",
      label: `$(warning) Not a filter: ${query.problems.join(" ")}`,
      detail:
        "Filters: type, t, p, s, tactic, actor, author, tlp, has, uuid, path, created, modified, reviewed, unreviewed",
    });
  }
  if (outcome && outcome.unsupported.length > 0) {
    rows.push({
      kind: "notice",
      label: `$(info) ${outcome.unsupported.map((f) => f.raw).join(" ")} needs a newer opentide`,
      detail: "One whose command tree has `info catalog`. Without it, search matches names, types and paths.",
    });
  }
  if (outcome?.pending)
    rows.push({ kind: "notice", label: "$(sync~spin) Asking opentide rules unreviewed…" });
  if (index.loading.length > 0 && index.items.length === 0)
    rows.push({ kind: "notice", label: "$(sync~spin) Loading the catalogue…" });
  if (index.items.length === 0 && index.loading.length === 0) {
    const reason = [...index.unavailable.values()][0];
    rows.push({
      kind: "notice",
      label: "$(info) Nothing to search yet",
      detail:
        reason ?? "No Tide objects found. Create one with opentide: New…, or open a folder with objects/.",
    });
  }

  const empty = query.words.length === 0 && query.excluded.length === 0 && query.filters.length === 0;
  if (empty && query.problems.length === 0) {
    rows.push({ kind: "separator", label: "Filters" });
    for (const hint of HINTS) rows.push({ kind: "hint", hint });
  }
  if (!outcome) return rows;

  const limit = options.limit ?? 500;
  const shown = outcome.results.slice(0, limit);
  const byType = new Map<string, SearchResult[]>();
  for (const result of shown) {
    const list = byType.get(result.item.type);
    if (list) list.push(result);
    else byType.set(result.item.type, [result]);
  }
  const counts = new Map<string, number>();
  for (const result of outcome.results) counts.set(result.item.type, (counts.get(result.item.type) ?? 0) + 1);
  const order = ["rule", "objective", "threat", "signal"];
  const types = [...byType.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib) || a.localeCompare(b);
  });
  for (const type of types) {
    rows.push({ kind: "separator", label: `${TYPE_GROUPS[type] ?? type} (${counts.get(type) ?? 0})` });
    for (const result of byType.get(type) ?? []) {
      const { item } = result;
      rows.push({
        kind: "result",
        result,
        icon: item.loadError ? "error" : (TYPE_ICONS[item.type] ?? "symbol-misc"),
        label: item.name,
        description: describeItem(item),
        detail: detailItem(item, options),
      });
    }
  }
  if (outcome.results.length > limit) {
    rows.push({
      kind: "notice",
      label: `$(info) Showing ${plural(limit, "result")} of ${outcome.results.length.toLocaleString("en-US")}`,
      detail: "Narrow the search, or show them all in the graph.",
    });
  }
  if (!empty && outcome.results.length === 0 && outcome.unsupported.length === 0 && !outcome.pending) {
    rows.push({ kind: "notice", label: "$(search-stop) No detection matches", detail: "Try fewer filters." });
  }
  return rows;
}

/** The value after inserting a hint: a space before it, and none after a `key:` still to fill. */
export function insertHint(value: string, hint: Hint): string {
  const base = value.trimEnd();
  return `${base}${base ? " " : ""}${hint.token}${hint.token.endsWith(":") || hint.token === "-" ? "" : " "}`;
}

/** The folder most results are in, and the UUIDs of its results (for "Show in graph"). */
export function graphSelection(
  results: readonly SearchResult[],
): { folder: string; uuids: string[] } | undefined {
  const byFolder = new Map<string, string[]>();
  for (const { item } of results) {
    if (item.source !== "catalog") continue;
    const list = byFolder.get(item.folder);
    if (list) list.push(item.id);
    else byFolder.set(item.folder, [item.id]);
  }
  let best: { folder: string; uuids: string[] } | undefined;
  for (const [folder, uuids] of byFolder)
    if (!best || uuids.length > best.uuids.length) best = { folder, uuids };
  return best;
}

/** Paths `rules unreviewed` listed (`{rules: [{path}]}`), or undefined when the document has none. */
export function unreviewedPaths(document: unknown): Set<string> | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const rules = (document as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return undefined;
  const paths = new Set<string>();
  for (const rule of rules) {
    const path = (rule as { path?: unknown } | null)?.path;
    if (typeof path === "string") paths.add(path.replaceAll("\\", "/"));
  }
  return paths;
}

export interface SearchArgs {
  readonly query?: string;
  /** A workspace folder's path: search only that folder's catalogue. */
  readonly folder?: string;
}

/** `opentide.search.open` takes `{query?, folder?}` (the matrix, the graph) or a bare query string. */
export function parseSearchArgs(value: unknown): SearchArgs {
  if (typeof value === "string") return { query: value };
  if (typeof value !== "object" || value === null) return {};
  const { query, folder } = value as { query?: unknown; folder?: unknown };
  return {
    ...(typeof query === "string" ? { query } : {}),
    ...(typeof folder === "string" && folder ? { folder } : {}),
  };
}

/**
 * The Catalogue view's filter for a query, when it can say the same thing: the sidebar filters on one
 * substring of a name, UUID, path or technique, so only plain words, or a single `t:`, `uuid:` or
 * `path:` filter, carry over. Undefined otherwise (the action is not offered).
 */
export function catalogueFilterOf(query: ParsedQuery): string | undefined {
  if (query.excluded.length > 0 || query.problems.length > 0) return undefined;
  if (query.filters.length === 0) return query.words.length > 0 ? query.words.join(" ") : undefined;
  const [only, ...rest] = query.filters;
  if (rest.length > 0 || query.words.length > 0 || !only || only.negated) return undefined;
  return only.key === "technique" || only.key === "uuid" || only.key === "path" ? only.value : undefined;
}

export interface DiagnosticLike {
  /** VS Code's DiagnosticSeverity: 0 error, 1 warning, 2 information, 3 hint. */
  readonly severity: number;
  readonly code?: string | number | { readonly value: string | number };
}

/** A file's Problems panel counts; `placeholder` is the code opentide gives a stand-in value. */
export function countProblems(diagnostics: readonly DiagnosticLike[]): ItemProblems {
  let errors = 0;
  let warnings = 0;
  let placeholders = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 0) errors += 1;
    else if (diagnostic.severity === 1) warnings += 1;
    const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
    if (code === "placeholder") placeholders += 1;
  }
  return { errors, warnings, placeholders };
}
