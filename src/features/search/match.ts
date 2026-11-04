// Matching a parsed query against the index, ranking the results, and counting facets. vscode-free.
import type { DateValue, Filter, FilterKey, ParsedQuery } from "./query";
import type { ItemPlatform, SearchIndex, SearchItem } from "./searchIndex";

export interface ItemProblems {
  readonly errors: number;
  readonly warnings: number;
  readonly placeholders: number;
}

export interface MatchContext {
  /** Milliseconds since the epoch: what ages are measured from. */
  readonly now: number;
  /** Problems panel counts of an item's file. */
  readonly problems?: (item: SearchItem) => ItemProblems | undefined;
  /**
   * `rules unreviewed --older-than <window>` per folder: the workspace-relative paths it listed. Absent
   * while it runs (`unreviewed:` then matches nothing and the result says it is pending).
   */
  readonly unreviewed?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface SearchResult {
  readonly item: SearchItem;
  readonly score: number;
}

export interface SearchOutcome {
  readonly results: readonly SearchResult[];
  /** Filters the index cannot answer (workspace symbols only carry names, types and paths). */
  readonly unsupported: readonly Filter[];
  /** `unreviewed:` is waiting for `rules unreviewed`. */
  readonly pending: boolean;
}

/** What `workspace/symbol` items can be filtered by. */
export const SYMBOL_KEYS: ReadonlySet<FilterKey> = new Set(["type", "path"]);

const TYPE_ORDER: Readonly<Record<string, number>> = { rule: 0, objective: 1, threat: 2, signal: 3 };
const DAY_MS = 86_400_000;

function normaliseType(value: string): string {
  const singular = value.endsWith("s") ? value.slice(0, -1) : value;
  return singular === "obj" ? "objective" : singular;
}

function dayMs(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(text);
  if (!match) return undefined;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3] ?? 1));
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    default:
      return a === b;
  }
}

/** Does the item's date (`YYYY-MM-DD…`) satisfy the filter? */
export function matchDate(value: string | undefined, filter: DateValue, now: number): boolean {
  if (filter.kind === "none") return !value;
  const day = value ? dayMs(value) : undefined;
  if (day === undefined) return false;
  if (filter.kind === "date") {
    const target = dayMs(filter.date);
    if (target === undefined) return false;
    // `2026-01` means the whole month for `=`.
    if (filter.op === "=" && /^\d{4}-\d{2}$/.test(filter.date)) {
      const [year, month] = filter.date.split("-").map(Number) as [number, number];
      return day >= target && day < Date.UTC(year, month, 1);
    }
    return compare(day, filter.op, target);
  }
  const today = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  const age = Math.round((today - day) / DAY_MS);
  return compare(age, filter.op, filter.days);
}

function matchPlatform(platform: ItemPlatform, filter: Filter): boolean {
  return filter.key === "platform"
    ? platform.id.toLowerCase() === filter.value
    : platform.status.toLowerCase() === filter.value;
}

function hasValue(item: SearchItem, value: string, context: MatchContext): boolean {
  const problems = context.problems?.(item);
  switch (value) {
    case "error":
    case "errors":
    case "problem":
    case "problems":
      return (
        Boolean(item.loadError) ||
        (problems?.errors ?? 0) > 0 ||
        (value.startsWith("problem") && (problems?.warnings ?? 0) > 0)
      );
    case "warning":
    case "warnings":
      return (problems?.warnings ?? 0) > 0;
    case "placeholder":
    case "placeholders":
      return (problems?.placeholders ?? 0) > 0;
    case "deployment":
    case "deployed":
      return item.deployed;
    case "technique":
    case "techniques":
      return item.techniques.length > 0;
    case "platform":
    case "platforms":
      return item.platforms.length > 0;
    case "load-error":
    case "loaderror":
      return Boolean(item.loadError);
    default:
      return false;
  }
}

/** Does one filter hold for the item (platform and status are checked together by the caller)? */
export function matchFilter(item: SearchItem, filter: Filter, context: MatchContext): boolean {
  const { keys } = item;
  switch (filter.key) {
    case "type":
      return item.type === normaliseType(filter.value);
    case "platform":
    case "status":
      return item.platforms.some((platform) => matchPlatform(platform, filter));
    case "technique":
      return keys.techniques.has(filter.value);
    case "tactic":
      return keys.tactics.some((tactic) => tactic === filter.value || tactic.includes(filter.value));
    case "actor":
      return keys.actors.some((actor) => actor.includes(filter.value));
    case "author":
      return keys.author.includes(filter.value);
    case "tlp":
      return keys.tlp === filter.value.replace(/^tlp:/, "");
    case "has":
      return hasValue(item, filter.value, context);
    case "uuid":
      return keys.uuid.startsWith(filter.value);
    case "path":
      return keys.path.includes(filter.value);
    case "created":
    case "modified":
    case "reviewed":
      return filter.date ? matchDate(item[filter.key], filter.date, context.now) : false;
    case "unreviewed":
      return item.type === "rule" && Boolean(context.unreviewed?.get(item.folder)?.has(item.path));
    default:
      return false;
  }
}

/** Positive platform and status filters must hold on one platform block: `p:sentinel s:production`. */
function matchBlocks(item: SearchItem, platforms: Filter[], statuses: Filter[]): boolean {
  if (platforms.length === 0 && statuses.length === 0) return true;
  return item.platforms.some(
    (platform) =>
      (platforms.length === 0 || platforms.some((filter) => matchPlatform(platform, filter))) &&
      (statuses.length === 0 || statuses.some((filter) => matchPlatform(platform, filter))),
  );
}

/** How well the free text matches the name: a name that starts with it first. */
function textScore(item: SearchItem, words: readonly string[]): number | undefined {
  let score = 0;
  for (const word of words) {
    const at = item.keys.name.indexOf(word);
    if (at === 0) score += 4;
    else if (at > 0) score += /[\s\-_:./]/.test(item.keys.name.charAt(at - 1)) ? 3 : 2;
    else if (item.keys.uuid.startsWith(word)) score += 2;
    else if (item.keys.path.includes(word)) score += 1;
    else return undefined;
  }
  return score;
}

export function search(index: SearchIndex, query: ParsedQuery, context: MatchContext): SearchOutcome {
  const unsupported = index.symbolsOnly ? query.filters.filter((filter) => !SYMBOL_KEYS.has(filter.key)) : [];
  const pending = query.filters.some((f) => f.key === "unreviewed") && context.unreviewed === undefined;
  if (unsupported.length > 0) return { results: [], unsupported, pending };

  const positive = new Map<FilterKey, Filter[]>();
  const negative: Filter[] = [];
  for (const filter of query.filters) {
    if (filter.negated) negative.push(filter);
    else {
      const group = positive.get(filter.key);
      if (group) group.push(filter);
      else positive.set(filter.key, [filter]);
    }
  }
  const platforms = positive.get("platform") ?? [];
  const statuses = positive.get("status") ?? [];
  positive.delete("platform");
  positive.delete("status");
  const groups = [...positive.values()];

  const results: SearchResult[] = [];
  for (const item of index.items) {
    const score = textScore(item, query.words);
    if (score === undefined) continue;
    if (query.excluded.some((word) => item.keys.name.includes(word) || item.keys.path.includes(word)))
      continue;
    if (!matchBlocks(item, platforms, statuses)) continue;
    if (!groups.every((group) => group.some((filter) => matchFilter(item, filter, context)))) continue;
    if (negative.some((filter) => matchFilter(item, filter, context))) continue;
    results.push({ item, score });
  }
  results.sort(
    (a, b) =>
      b.score - a.score ||
      (TYPE_ORDER[a.item.type] ?? 9) - (TYPE_ORDER[b.item.type] ?? 9) ||
      a.item.name.localeCompare(b.item.name) ||
      a.item.path.localeCompare(b.item.path),
  );
  return { results, unsupported, pending };
}

export interface Facets {
  readonly type: ReadonlyMap<string, number>;
  readonly platform: ReadonlyMap<string, number>;
  readonly status: ReadonlyMap<string, number>;
  readonly tactic: ReadonlyMap<string, number>;
  readonly tlp: ReadonlyMap<string, number>;
}

/** Counts per value over the results; an item counts once per value. */
export function facets(results: readonly SearchResult[]): Facets {
  const count = (map: Map<string, number>, values: Iterable<string>): void => {
    for (const value of new Set(values)) map.set(value, (map.get(value) ?? 0) + 1);
  };
  const type = new Map<string, number>();
  const platform = new Map<string, number>();
  const status = new Map<string, number>();
  const tactic = new Map<string, number>();
  const tlp = new Map<string, number>();
  for (const { item } of results) {
    count(type, [item.type]);
    count(
      platform,
      item.platforms.map((p) => p.id),
    );
    count(status, item.platforms.map((p) => p.status).filter(Boolean));
    count(tactic, item.tactics);
    if (item.tlp) count(tlp, [item.tlp]);
  }
  return { type, platform, status, tactic, tlp };
}
