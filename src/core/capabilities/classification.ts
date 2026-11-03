// What each opentide command does to the workspace and to tenants (SPEC §11). vscode-free.
//
// The backend uses it to queue writers, to decide where credentials go, and to keep long or outward
// commands in a process of their own. The generic runner uses it for its icons and confirmations. A test
// fails when the pinned opentide has a command this table does not classify.
import { stripGlobalOptions } from "./tree";

export type CommandClass = "read-only" | "writes-workspace" | "contacts-tenant" | "deploys" | "shares";

export interface Classification {
  readonly class: CommandClass;
  /** Changes workspace files: runs one at a time, and the catalogue refreshes afterwards. */
  readonly writes: boolean;
  /** Reaches a platform tenant or sharing target: gets credentials, and the UI says so. */
  readonly contactsTenant: boolean;
  /** Runs as a process of its own even when `opentide serve` is available (SPEC D2). */
  readonly spawn: boolean;
}

/** A command the table does not know: treated as writing (queued), never given credentials. */
export const UNCLASSIFIED: Classification & { readonly unclassified: true } = {
  class: "writes-workspace",
  writes: true,
  contactsTenant: false,
  spawn: true,
  unclassified: true,
};

type Rule = (args: ReadonlySet<string>) => Classification;

const c = (cls: CommandClass, writes: boolean, contactsTenant: boolean, spawn = false): Classification => ({
  class: cls,
  writes,
  contactsTenant,
  spawn,
});

const READ = c("read-only", false, false);
const READ_SPAWN = c("read-only", false, false, true);
const WRITE = c("writes-workspace", true, false);
const WRITE_SPAWN = c("writes-workspace", true, false, true);
const TENANT_SPAWN = c("contacts-tenant", false, true, true);
const DEPLOYS = c("deploys", true, true, true);
const SHARES = c("shares", true, true, true);

const always =
  (classification: Classification): Rule =>
  () =>
    classification;

/** Keyed by command path. Groups that run alone (`validate`, `generate`) have their own entry. */
export const COMMAND_CLASSES: Readonly<Record<string, Rule>> = {
  validate: (a) => (a.has("--fix") && !a.has("--dry-run") ? WRITE : READ),
  "validate query": (a) => (a.has("--live") ? TENANT_SPAWN : READ),
  query: always(TENANT_SPAWN),
  lint: (a) => (a.has("--fix") ? WRITE : READ),
  info: always(READ),
  new: always(WRITE),
  "new threat": always(WRITE),
  "new objective": always(WRITE),
  "new rule": always(WRITE),
  generate: always(WRITE_SPAWN),
  "generate explorer": always(WRITE_SPAWN),
  "generate docs": always(WRITE_SPAWN),
  "generate docs rules": always(WRITE_SPAWN),
  "generate docs objectives": always(WRITE_SPAWN),
  "generate docs threats": always(WRITE_SPAWN),
  "generate docs index": always(WRITE_SPAWN),
  "generate exports": always(WRITE_SPAWN),
  "generate exports navigator": always(WRITE_SPAWN),
  "generate exports objects": always(WRITE_SPAWN),
  "generate exports revisions": always(WRITE_SPAWN),
  "generate extract": always(c("contacts-tenant", true, true, true)),
  "generate extract sentinel": always(c("contacts-tenant", true, true, true)),
  "generate extract defender": always(c("contacts-tenant", true, true, true)),
  "generate extract elastic": always(c("contacts-tenant", true, true, true)),
  "generate inflight": always(WRITE_SPAWN),
  "generate inflight prune": always(WRITE_SPAWN),
  rules: always(READ),
  "rules unreviewed": always(READ),
  deploy: (a) => (a.has("--dry-run") ? READ_SPAWN : DEPLOYS),
  "deploy migrate-state": always(DEPLOYS),
  share: always(SHARES),
  "share push": always(SHARES),
  "share retract": always(SHARES),
  "share preview": always(READ),
  "share status": always(READ),
  "share targets": always(READ),
  setup: (a) => (a.has("--plan") ? READ_SPAWN : WRITE_SPAWN),
  "setup repo": always(WRITE_SPAWN),
  "setup platforms": always(WRITE_SPAWN),
  "setup ci": always(WRITE_SPAWN),
  "setup env": always(WRITE_SPAWN),
  "setup hooks": always(WRITE_SPAWN),
  "setup mcp": always(WRITE_SPAWN),
  "setup vscode": always(WRITE_SPAWN),
  "setup skills": always(WRITE_SPAWN),
  "setup skills discover": always(READ_SPAWN),
  "setup skills show": always(READ_SPAWN),
  doctor: (a) => (a.has("--offline") ? READ_SPAWN : TENANT_SPAWN),
  migrate: always(READ_SPAWN),
  "migrate objects": (a) => (a.has("--apply") ? WRITE_SPAWN : READ_SPAWN),
  "migrate vocab-scope": (a) => (a.has("--apply") ? WRITE_SPAWN : READ_SPAWN),
  tui: always(READ_SPAWN),
  explain: always(READ),
  commands: always(READ),
  mcp: always(READ_SPAWN),
  "mcp start": always(READ_SPAWN),
  lsp: always(READ_SPAWN),
  "lsp start": always(READ_SPAWN),
  serve: always(READ_SPAWN),
};

/** A classifier a feature registers; it answers first, or returns undefined to defer. */
export type Classifier = (path: string, args: readonly string[]) => Classification | undefined;

/** The longest table path at the start of argv (after global options), and the remaining args. */
export function splitCommandPath(argv: readonly string[]): { path: string; rest: string[] } {
  const args = stripGlobalOptions(argv);
  let best = 0;
  for (let n = 1; n <= Math.min(args.length, 4); n++) {
    if (Object.hasOwn(COMMAND_CLASSES, args.slice(0, n).join(" "))) best = n;
  }
  return { path: args.slice(0, best).join(" "), rest: args.slice(best) };
}

export function classify(
  argv: readonly string[],
  classifiers: readonly Classifier[] = [],
): Classification & { readonly unclassified?: true } {
  const { path, rest } = splitCommandPath(argv);
  for (const classifier of classifiers) {
    const answer = classifier(path, rest);
    if (answer) return answer;
  }
  const rule = path ? COMMAND_CLASSES[path] : undefined;
  if (!rule) return UNCLASSIFIED;
  const flags = new Set(
    rest.map((arg) => (arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg)),
  );
  return rule(flags);
}
