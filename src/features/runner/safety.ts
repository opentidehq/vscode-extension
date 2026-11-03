// What the runner does with a command before it runs: as picked, behind a confirmation, as a dry run, or
// not at all (SPEC §11, D6: nothing deploys, pushes or retracts from the editor). vscode-free.
import type { Classification } from "../../core/capabilities/classification";

export type RunPlan =
  /** Runs as picked. */
  | { readonly kind: "run"; readonly argv: readonly string[] }
  /**
   * A deploy or share: a modal confirmation naming the platforms, tenants and rule count first. `argv` is
   * the dry run that runs on confirmation; `dryRunAdded` when the runner added `--dry-run` itself.
   */
  | { readonly kind: "confirm"; readonly argv: readonly string[]; readonly dryRunAdded: boolean }
  /** Never from the editor: `reason`, and the command line to run in CI instead. */
  | { readonly kind: "refuse"; readonly reason: string; readonly alternative?: string };

export const DRY_RUN = "--dry-run";

/** Flags that skip opentide's own confirmation of a destructive share. */
const UNCONFIRMED = new Set(["--yes", "-y"]);

/**
 * The plan for `argv` (a command path and its arguments, without `--json`). `hasDryRun` says whether the
 * command takes `--dry-run`.
 */
export function planRun(
  argv: readonly string[],
  path: string,
  classification: Classification,
  hasDryRun: boolean,
): RunPlan {
  if (classification.class !== "deploys" && classification.class !== "shares") return { kind: "run", argv };
  const verb = classification.class === "deploys" ? "deploys" : "shares";
  if (argv.includes(DRY_RUN)) {
    const filtered = argv.filter((arg) => !UNCONFIRMED.has(arg));
    return { kind: "confirm", argv: filtered, dryRunAdded: false };
  }
  if (hasDryRun) {
    return {
      kind: "confirm",
      argv: [...argv.filter((arg) => !UNCONFIRMED.has(arg)), DRY_RUN],
      dryRunAdded: true,
    };
  }
  const alternative = path.startsWith("share") ? "opentide share preview" : undefined;
  return {
    kind: "refuse",
    reason:
      `\`opentide ${path}\` ${verb === "deploys" ? "changes what is deployed" : "changes what is shared"} ` +
      "and has no dry run. The editor never runs it: run it in CI.",
    ...(alternative ? { alternative } : {}),
  };
}

/** The values of a flag in an argv (`--platform sentinel` or `--platform=sentinel`), in order. */
export function flagValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === flag && i + 1 < argv.length) values.push(argv[++i] ?? "");
    else if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
  }
  return values;
}

/** The platforms a tenant-contacting argv names: `--platform`, or `generate extract <platform>`. */
export function platformsOf(argv: readonly string[]): string[] | undefined {
  const named = flagValues(argv, "--platform");
  if (named.length > 0) return named;
  const extract = argv.indexOf("extract");
  if (argv[0] === "generate" && extract === 1 && argv[2] && !argv[2].startsWith("-")) {
    // `generate extract defender` is the Defender for Endpoint platform.
    return [argv[2] === "defender" ? "defender_for_endpoint" : argv[2]];
  }
  return undefined;
}

/** How many rules a deploy selects, when the argv says: `--uuid`/`--file` given, else undefined. */
export function selectedRuleCount(argv: readonly string[]): number | undefined {
  const count = flagValues(argv, "--uuid").length + flagValues(argv, "--file").length;
  return count > 0 ? count : undefined;
}
