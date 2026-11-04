// The command lines the query feature runs: `query` and `validate query --live`. vscode-free.

/** What a query run sends. */
export type QuerySource =
  /** A Tide rule's query on a platform: by its workspace-relative file, else by UUID. */
  | { readonly kind: "rule"; readonly file?: string; readonly uuid?: string; readonly name: string }
  /** A saved query file, by absolute path (the CLI resolves it against its own working directory). */
  | { readonly kind: "query-file"; readonly path: string; readonly name: string }
  /** Query text (an unsaved buffer). */
  | { readonly kind: "text"; readonly text: string; readonly name: string };

/** The time window: a look-back (`--since`) or an explicit range (`--from`/`--to`). */
export type QueryWindow =
  | { readonly kind: "since"; readonly since: string }
  | { readonly kind: "range"; readonly from: string; readonly to?: string };

export interface QueryOptions {
  readonly platform: string;
  readonly source: QuerySource;
  /** Undefined: let opentide pick the only tenant (exit 2 with `choices` when there are several). */
  readonly tenants?: readonly string[];
  readonly window: QueryWindow;
  readonly limit: number;
  /** Elastic only. */
  readonly language?: string;
}

export const MAX_LIMIT = 5000;
export const DEFAULT_LIMIT = 100;

/** `--since` values opentide accepts: 15m, 24h, 7d, PT1H. */
export function isDuration(value: string): boolean {
  return /^\d+[smhdw]$/i.test(value.trim()) || /^P(?=\d|T\d)(\d+[YMWD])*(T(\d+[HMS])+)?$/i.test(value.trim());
}

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

export function queryArgv(options: QueryOptions): string[] {
  const argv = ["query", "--platform", options.platform];
  for (const tenant of options.tenants ?? []) argv.push("--tenant", tenant);
  const { source } = options;
  if (source.kind === "rule") {
    if (source.file) argv.push("--file", source.file);
    else if (source.uuid) argv.push("--rule", source.uuid);
    else throw new Error("a rule query needs the rule's file or UUID");
  } else if (source.kind === "query-file") {
    argv.push("--query-file", source.path);
  }
  if (options.window.kind === "since") argv.push("--since", options.window.since);
  else {
    argv.push("--from", options.window.from);
    if (options.window.to) argv.push("--to", options.window.to);
  }
  argv.push("--limit", String(clampLimit(options.limit)));
  if (options.language && options.platform === "elastic") argv.push("--language", options.language);
  // Query text is positional; `--` keeps a query that starts with `-` from reading as an option.
  if (source.kind === "text") argv.push("--", source.text);
  return argv;
}

/** `validate query --live` for one rule on one platform. */
export function validateLiveArgv(platform: string, rule: { file?: string; uuid?: string }): string[] {
  const select = rule.uuid ? ["--uuid", rule.uuid] : rule.file ? ["--file", rule.file] : undefined;
  if (!select) throw new Error("validate query --live needs the rule's UUID or file");
  return ["validate", "query", "--live", "--platform", platform, ...select];
}

/** A run refused because several tenants exist and none was named: the CLI's exit-2 case with `choices`. */
export function tenantChoices(document: {
  readonly exit_code?: number;
  readonly failure?: { readonly argument?: string | null } | null;
  readonly [key: string]: unknown;
}): string[] | undefined {
  if (document.exit_code !== 2 || document.failure?.argument !== "--tenant") return undefined;
  const choices = document.choices;
  if (!Array.isArray(choices)) return undefined;
  const names = choices.filter((c): c is string => typeof c === "string");
  return names.length > 0 ? names : undefined;
}

/** A short label for the window: `last 24h`, or `2026-11-01 → now`. */
export function windowLabel(window: QueryWindow): string {
  if (window.kind === "since") return `last ${window.since}`;
  return `${window.from} → ${window.to ?? "now"}`;
}

/** A stable key for "the same query on the same platform", so a re-run reuses its panel. */
export function sourceKey(platform: string, source: QuerySource): string {
  const what =
    source.kind === "rule"
      ? `rule:${source.uuid ?? source.file ?? ""}`
      : source.kind === "query-file"
        ? `file:${source.path}`
        : `text:${source.name}`;
  return `${platform}|${what}`;
}
