// The lenses above a query: what each says and runs. vscode-free; index.ts turns them into CodeLenses.
import type { PlatformCaps } from "./platforms";
import { compiledMethod, type LspRange, writesPreviewAlerts } from "./targets";

/** Where a lens's query is: a rule's platform block, or a whole query file. */
export interface LensTarget {
  readonly uri: string;
  readonly range: LspRange;
  readonly platform: string;
  readonly language: string;
  readonly kind: "rule" | "query-file";
  /** Rule lenses: the rule's UUID and name, from the outline. */
  readonly uuid?: string;
  readonly name?: string;
}

export interface LensSpec {
  readonly range: LspRange;
  readonly title: string;
  readonly tooltip: string;
  readonly command:
    | "opentide.query.run"
    | "opentide.query.validateLive"
    | "opentide.query.showCompiled"
    | "opentide.query.configureTenant";
  readonly target: LensTarget;
}

export interface LensContext {
  /** Commands can run (a trusted opentide runtime). */
  readonly canRun: boolean;
  /** The platform's caps; undefined when not known yet. */
  readonly caps?: PlatformCaps;
}

const LABELS: Readonly<Record<string, string>> = {
  sentinel: "Sentinel",
  defender_for_endpoint: "Defender",
  elastic: "Elastic",
  splunk: "Splunk",
  sentinel_one: "SentinelOne",
  carbon_black_cloud: "Carbon Black",
  crowdstrike: "CrowdStrike",
  harfanglab: "HarfangLab",
  sysdig: "Sysdig",
};

export function platformLabel(id: string): string {
  return LABELS[id] ?? id;
}

/** "prod", "prod and dev", "3 tenants". */
export function tenantPhrase(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} tenants`;
}

export function lensesFor(target: LensTarget, context: LensContext): LensSpec[] {
  const out: LensSpec[] = [];
  const { caps } = context;
  const where = platformLabel(target.platform);
  if (context.canRun && caps?.canQuery) {
    const tenants = caps.tenants?.map((t) => t.name);
    const writes = writesPreviewAlerts(target.platform, target.language);
    const suffix = writes ? " · writes preview alerts" : "";
    if (tenants && tenants.length === 0) {
      out.push({
        range: target.range,
        title: `$(globe) No ${where} tenant: configure one…`,
        tooltip: `Open ${target.platform}.toml to add a [[tenants]] entry`,
        command: "opentide.query.configureTenant",
        target,
      });
    } else {
      const title = tenants
        ? tenants.length === 1
          ? `$(globe) Run on ${tenants[0]}`
          : `$(globe) Run on ${where} tenants…`
        : `$(globe) Run on ${where}…`;
      out.push({
        range: target.range,
        title: `${title}${suffix}`,
        tooltip:
          `opentide query: sends this query to ${tenants ? tenantPhrase(tenants) : `${where} tenants`} (read-only)` +
          (writes ? ". Kuery runs as a rule preview, which writes preview alerts to the preview index" : ""),
        command: "opentide.query.run",
        target,
      });
    }
  }
  if (context.canRun && caps?.canValidate && target.kind === "rule" && caps.tenants?.length !== 0) {
    // It sends the query to the platform's tenants (P5): a globe, and the tenants it reaches.
    const tenants = caps.tenants?.map((t) => t.name);
    out.push({
      range: target.range,
      title: `$(globe) Validate live${tenants ? ` on ${tenantPhrase(tenants)}` : ""}`,
      tooltip: `opentide validate query --live: sends this rule's ${where} query to ${tenants ? tenantPhrase(tenants) : `the ${where} tenants`} for validation`,
      command: "opentide.query.validateLive",
      target,
    });
  }
  if (compiledMethod(target.language)) {
    out.push({
      range: target.range,
      title: "$(file-code) Compiled query",
      tooltip: `The ${target.language.toUpperCase()} ${where} runs, from the language server`,
      command: "opentide.query.showCompiled",
      target,
    });
  }
  return out;
}
