// The deploy plan's command lines (SPEC §10.5, D6): the editor only ever runs `deploy --dry-run`; the
// real deploy is a command line to copy into a terminal or CI. vscode-free.
import { shellQuote } from "../../core/runtime/env";

import type { Strategy } from "./protocol";

export type { Strategy };

export type DeployScope =
  /** The CLI's default: the rule files the run changed (git diff). */
  | { readonly kind: "changed" }
  /** `--all`: every rule file. */
  | { readonly kind: "all" }
  /** `--uuid` / `--file` (opentide#753): these rules. */
  | { readonly kind: "selected"; readonly uuids: readonly string[]; readonly files: readonly string[] };

export interface DeployPlanOptions {
  readonly strategies: readonly Strategy[];
  readonly scope: DeployScope;
  /** One platform (`--platform`), or every platform. */
  readonly platform?: string;
}

export const STRATEGIES: readonly Strategy[] = ["PREVIEW", "RELEASE"];

/** The flags both the dry run and the real deploy take. */
function selection(options: DeployPlanOptions): string[] {
  const argv: string[] = [];
  for (const strategy of options.strategies.length ? options.strategies : ["PREVIEW"])
    argv.push("--strategy", strategy);
  if (options.scope.kind === "all") argv.push("--all");
  if (options.scope.kind === "selected") {
    for (const uuid of options.scope.uuids) argv.push("--uuid", uuid);
    for (const file of options.scope.files) argv.push("--file", file);
  }
  if (options.platform) argv.push("--platform", options.platform);
  return argv;
}

/** `deploy --dry-run …`: the only deploy the editor runs. */
export function dryRunArgv(options: DeployPlanOptions): string[] {
  const argv = ["deploy", "--dry-run", ...selection(options)];
  assertDryRun(argv);
  return argv;
}

/** Throws unless `argv` is a `deploy --dry-run` (D6: nothing deploys for real from the editor). */
export function assertDryRun(argv: readonly string[]): void {
  if (argv[0] !== "deploy" || !argv.includes("--dry-run") || argv[1] === "migrate-state") {
    throw new Error(`refusing to run ${argv.join(" ")}: the editor only previews deploys (--dry-run)`);
  }
}

/** The real deploy, as a command line to copy. Never run by the extension. */
export function deployCommand(options: DeployPlanOptions): string {
  return ["opentide", "deploy", ...selection(options)].map(shellQuote).join(" ");
}

/** The dry run as a person types it (no `--json`). */
export function dryRunCommand(options: DeployPlanOptions): string {
  return ["opentide", "deploy", "--dry-run", ...selection(options)].map(shellQuote).join(" ");
}

/** `$VAR`s a plan's warnings say a real deploy needs ("a real deploy would need $SPLUNK_TOKEN, …"). */
export function neededVariables(warnings: readonly string[]): string[] {
  const names = new Set<string>();
  for (const warning of warnings) {
    if (!/real deploy would need/i.test(warning)) continue;
    for (const match of warning.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g))
      if (match[1]) names.add(match[1]);
  }
  return [...names].sort();
}

/** What `ciVariables` reads of `opentide --json info`'s platforms (opentide#754's tenants). */
export interface InfoPlatform {
  readonly name: string;
  /** Undefined when the active opentide's `info` lists no tenants. */
  readonly tenants?: readonly {
    readonly name: string;
    readonly strategies: readonly string[];
    readonly variables: readonly { readonly name: string }[];
  }[];
}

/** The tenants a plan sends to, by platform, from its `changes` (`null`: the platform has none). */
export interface PlannedPlatform {
  readonly platform: string;
  readonly tenants: readonly { readonly tenant: string | null }[];
}

/**
 * The secrets the CI step's real deploy needs: every credential variable of each tenant the plan deploys
 * to, from `info` (a tenant the plan names, else each tenant of the platform whose strategies include one
 * of the deploy's), whether or not it is set here; plus what the plan's warnings name, for an opentide
 * whose `info` lists no tenants. The warning alone names only unset variables, and at most three.
 */
export function ciVariables(
  options: DeployPlanOptions,
  info: readonly InfoPlatform[],
  planned: readonly PlannedPlatform[],
  warnings: readonly string[],
): string[] {
  const names = new Set(neededVariables(warnings));
  const strategies = options.strategies.length ? options.strategies : ["PREVIEW"];
  const platforms = planned.length
    ? planned.map((p) => p.platform)
    : options.platform
      ? [options.platform]
      : info.map((p) => p.name);
  for (const platform of platforms) {
    const tenants = info.find((p) => p.name === platform)?.tenants ?? [];
    const named = new Set(
      (planned.find((p) => p.platform === platform)?.tenants ?? []).flatMap((t) =>
        t.tenant ? [t.tenant] : [],
      ),
    );
    for (const tenant of tenants) {
      const reached = named.size
        ? named.has(tenant.name)
        : tenant.strategies.length === 0 || tenant.strategies.some((s) => strategies.includes(s as Strategy));
      if (reached) for (const variable of tenant.variables) names.add(variable.name);
    }
  }
  return [...names].sort();
}

/** A GitHub Actions step that runs the real deploy in CI, with the secrets it needs. */
export function ciStep(options: DeployPlanOptions, variables: readonly string[] = []): string {
  const strategies = options.strategies.length ? options.strategies.join(", ") : "PREVIEW";
  // A block scalar: a plain `run:` scalar ends at ` #` (a comment) and breaks at `: ` in a rule path.
  const lines = [`- name: Deploy detections (${strategies})`, "  run: |", `    ${deployCommand(options)}`];
  if (variables.length > 0) {
    lines.push("  env:");
    for (const name of variables) lines.push(`    ${name}: \${{ secrets.${name} }}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Runs the plan. Every argv it sends passed `assertDryRun`: the panel has no other way to run deploy. */
export class DeployPlanner<Extra, Result> {
  constructor(
    private readonly run: (folder: string, argv: readonly string[], extra: Extra) => Promise<Result>,
  ) {}

  plan(folder: string, options: DeployPlanOptions, extra: Extra): Promise<Result> {
    const argv = dryRunArgv(options);
    assertDryRun(argv);
    return this.run(folder, argv, extra);
  }
}
