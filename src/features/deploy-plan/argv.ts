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

/** A GitHub Actions step that runs the real deploy in CI, with the secrets it needs. */
export function ciStep(options: DeployPlanOptions, variables: readonly string[] = []): string {
  const strategies = options.strategies.length ? options.strategies.join(", ") : "PREVIEW";
  const lines = [`- name: Deploy detections (${strategies})`, `  run: ${deployCommand(options)}`];
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
