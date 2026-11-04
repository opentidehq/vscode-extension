// The search query language (SPEC §10.3): free text plus `key:value` filters. vscode-free.
//
//   lsass t:T1003 p:sentinel s:production -tlp:red author:"Jane Doe" modified:<30d unreviewed:>90d
//
// - Free text: every word must appear in the name, UUID or path (case-insensitive).
// - Filters with the same key are alternatives (OR); different keys must all hold (AND).
// - `-key:value` and `-word` exclude. Values may be quoted. A key without a value (`t:`) is ignored while typing.
// - Dates (`created`, `modified`, `reviewed`) take `>`, `>=`, `<`, `<=` or `=` with an ISO date
//   (`>2026-01-01`: after it) or an age (`<30d`: less than 30 days old; `d`, `w`, `m`, `y`).
// - `unreviewed:>90d` (or `unreviewed:90d`) asks `opentide rules unreviewed --older-than 90d`.

export type FilterKey =
  | "type"
  | "platform"
  | "status"
  | "technique"
  | "tactic"
  | "actor"
  | "author"
  | "tlp"
  | "has"
  | "uuid"
  | "path"
  | "created"
  | "modified"
  | "reviewed"
  | "unreviewed";

/** Every spelling a key accepts, by key. The first is the canonical one. */
export const KEY_ALIASES: Readonly<Record<FilterKey, readonly string[]>> = {
  type: ["type", "k", "kind", "is"],
  platform: ["platform", "p"],
  status: ["status", "s"],
  technique: ["technique", "t", "tech"],
  tactic: ["tactic", "ta"],
  actor: ["actor", "a"],
  author: ["author", "au", "by"],
  tlp: ["tlp"],
  has: ["has"],
  uuid: ["uuid", "id"],
  path: ["path", "file", "in"],
  created: ["created"],
  modified: ["modified", "updated"],
  reviewed: ["reviewed"],
  unreviewed: ["unreviewed"],
};

const KEYS = new Map<string, FilterKey>(
  Object.entries(KEY_ALIASES).flatMap(([key, aliases]) => aliases.map((alias) => [alias, key as FilterKey])),
);

export const DATE_KEYS: ReadonlySet<FilterKey> = new Set(["created", "modified", "reviewed"]);

export type Comparison = ">" | ">=" | "<" | "<=" | "=";

/** A date filter: an absolute day, or an age in days. */
export type DateValue =
  | { readonly kind: "date"; readonly op: Comparison; readonly date: string }
  | { readonly kind: "age"; readonly op: Comparison; readonly days: number }
  | { readonly kind: "none" };

export interface Filter {
  readonly key: FilterKey;
  /** Lower-cased, unquoted. */
  readonly value: string;
  readonly negated: boolean;
  /** For date keys. */
  readonly date?: DateValue;
  /** The text as typed, for display. */
  readonly raw: string;
}

export interface ParsedQuery {
  /** Lower-cased free-text words. */
  readonly words: readonly string[];
  /** Lower-cased words after a `-`: results must not contain them. */
  readonly excluded: readonly string[];
  readonly filters: readonly Filter[];
  /** `key:value` tokens whose key is not a known filter, or whose value does not parse. */
  readonly problems: readonly string[];
  /** The `--older-than` window `unreviewed:` asks for (`90d`), if any. */
  readonly unreviewed?: string;
}

/**
 * Split on whitespace, keeping quoted runs together (`author:"Jane Doe"`, `'two words'`). A quote opens
 * only at the start of a token or right after `key:` (or a leading `-`); elsewhere it is text, so
 * `attacker's tool` stays two words. A quote never closed after `key:` is the value typed so far;
 * anywhere else it is text, and what follows it splits as usual.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  /** The token as it was when the quote opened, and the raw text since. */
  let before = "";
  let raw = "";
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
      else {
        current += char;
        raw += char;
      }
    } else if (
      (char === '"' || char === "'") &&
      (current === "" || current === "-" || current.endsWith(":"))
    ) {
      quote = char;
      before = current;
      raw = "";
    } else if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (quote) {
    // `author:"Jane Do` while typing: the value so far. A quote elsewhere is text.
    if (before.endsWith(":")) tokens.push(`${before}${raw}`);
    else {
      const [first = "", ...rest] = raw.split(/\s+/);
      tokens.push(`${before}${quote}${first}`, ...rest.filter(Boolean));
    }
    return tokens;
  }
  if (current) tokens.push(current);
  return tokens;
}

const AGE = /^(\d+(?:\.\d+)?)\s*(d|w|m|y|days?|weeks?|months?|years?)$/i;
const DAY = /^\d{4}-\d{2}(-\d{2})?$/;

/** An age (`90d`, `12w`, `6m`, `1y`) in days, or undefined. */
export function ageInDays(text: string): number | undefined {
  const match = AGE.exec(text.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "d").charAt(0).toLowerCase();
  const factor = unit === "w" ? 7 : unit === "m" ? 30 : unit === "y" ? 365 : 1;
  return amount * factor;
}

export function parseDate(text: string): DateValue | undefined {
  if (/^(none|never|null|unset)$/i.test(text)) return { kind: "none" };
  const match = /^(>=|<=|>|<|=)?(.*)$/.exec(text);
  const op = (match?.[1] ?? "=") as Comparison;
  const rest = (match?.[2] ?? "").trim();
  const days = ageInDays(rest);
  if (days !== undefined) return { kind: "age", op, days };
  if (DAY.test(rest)) return { kind: "date", op, date: rest };
  return undefined;
}

/** The `--older-than` window for `unreviewed:`: `>90d`, `90d`, `90` and `true` (90d) all work. */
export function unreviewedWindow(text: string): string | undefined {
  const value = text.replace(/^>=?/, "").trim().toLowerCase();
  if (value === "" || value === "true" || value === "yes") return "90d";
  if (/^\d+$/.test(value)) return `${value}d`;
  // `m` is months, as everywhere in the search language (`modified:<6m`); opentide reads `m` as
  // minutes, so months go as days and minutes take `min`.
  if (/^\d+[dh]$/.test(value)) return value;
  const minutes = /^(\d+)\s*min(ute)?s?$/.exec(value);
  if (minutes) return `${minutes[1]}m`;
  const days = ageInDays(value);
  return days !== undefined && Number.isInteger(days) ? `${days}d` : undefined;
}

export function parseQuery(text: string): ParsedQuery {
  const words: string[] = [];
  const excluded: string[] = [];
  const filters: Filter[] = [];
  const problems: string[] = [];
  let unreviewed: string | undefined;
  for (const token of tokenize(text)) {
    const negated = token.startsWith("-") && token.length > 1 && token.includes(":");
    const body = negated ? token.slice(1) : token;
    const colon = body.indexOf(":");
    // `T1003.001`, a UUID, `lsadump::dcsync`, `http://…`: only `word:` with letters, then a value, is a
    // filter key.
    const key = colon > 0 ? body.slice(0, colon).toLowerCase() : "";
    const after = body.charAt(colon + 1);
    if (!key || !/^[a-z]+$/.test(key) || after === ":" || after === "/") {
      if (token.startsWith("-") && token.length > 1 && colon < 0) excluded.push(token.slice(1).toLowerCase());
      else words.push(token.toLowerCase());
      continue;
    }
    const value = body.slice(colon + 1).trim();
    const canonical = KEYS.get(key);
    if (!canonical) {
      // Not a filter: say so, and still search for it as text (rule names have colons).
      problems.push(token);
      if (negated) excluded.push(body.toLowerCase());
      else words.push(token.toLowerCase());
      continue;
    }
    if (!value) continue; // still typing
    if (DATE_KEYS.has(canonical)) {
      const date = parseDate(value);
      if (!date) {
        problems.push(token);
        continue;
      }
      filters.push({ key: canonical, value: value.toLowerCase(), negated, date, raw: token });
      continue;
    }
    if (canonical === "unreviewed") {
      const window = unreviewedWindow(value);
      if (!window) {
        problems.push(token);
        continue;
      }
      unreviewed = window;
      filters.push({ key: canonical, value: window, negated, raw: token });
      continue;
    }
    filters.push({ key: canonical, value: value.toLowerCase(), negated, raw: token });
  }
  return { words, excluded, filters, problems, ...(unreviewed ? { unreviewed } : {}) };
}

/** Is the query empty (nothing to match on)? */
export function isEmptyQuery(query: ParsedQuery): boolean {
  return query.words.length === 0 && query.excluded.length === 0 && query.filters.length === 0;
}
