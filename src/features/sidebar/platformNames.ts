// Display names of opentide's platform ids. Unknown ids show as they are. vscode-free.

interface PlatformName {
  /** In trees and badges. */
  readonly short: string;
  /** In the Platforms view and the wizard. */
  readonly long: string;
  /** The query languages opentide checks offline or on a tenant, for the wizard's badges. */
  readonly languages?: string;
}

const NAMES: Readonly<Record<string, PlatformName>> = {
  sentinel: { short: "Sentinel", long: "Microsoft Sentinel", languages: "KQL" },
  defender_for_endpoint: { short: "Defender", long: "Microsoft Defender for Endpoint", languages: "KQL" },
  splunk: { short: "Splunk", long: "Splunk", languages: "SPL" },
  elastic: { short: "Elastic", long: "Elastic Security", languages: "Kuery, Lucene, EQL, ES|QL" },
  crowdstrike: { short: "CrowdStrike", long: "CrowdStrike Falcon", languages: "CQL" },
  sentinel_one: { short: "SentinelOne", long: "SentinelOne", languages: "S1QL" },
  carbon_black_cloud: { short: "Carbon Black", long: "Carbon Black Cloud", languages: "Lucene" },
  harfanglab: { short: "HarfangLab", long: "HarfangLab" },
  sysdig: { short: "Sysdig", long: "Sysdig Secure (Falco)", languages: "Falco" },
};

export function platformName(id: string): PlatformName {
  return NAMES[id] ?? { short: id, long: id };
}

/** `defender_for_endpoint` → `--defender-for-endpoint`: the flag `setup platforms` takes. */
export function platformFlag(id: string): string {
  return `--${id.replaceAll("_", "-")}`;
}

/** The platform's configuration file, relative to the workspace. */
export function platformToml(id: string): string {
  return `.opentide/configurations/platforms/${id}.toml`;
}
