// The Platforms & tenants view (SPEC §9): `opentide --json info`'s platforms, and with opentide#754 their
// tenants and the credential variables each needs, with where each one is set. vscode-free.
import type { DoctorCheck } from "./health";
import { branch, messageNode, type TreeNode } from "./node";
import { platformName, platformToml } from "./platformNames";

export interface TenantVariable {
  readonly name: string;
  readonly set: boolean;
}

export interface Tenant {
  readonly name: string;
  readonly description?: string | null;
  readonly strategies: readonly string[];
  readonly manual: boolean;
  readonly variables: readonly TenantVariable[];
}

export interface PlatformInfo {
  readonly name: string;
  readonly enabled: boolean;
  readonly can_deploy: boolean;
  readonly can_validate: boolean;
  readonly can_query: boolean;
  /** Undefined: this opentide's `info` has no tenants (older than opentide#754). */
  readonly tenants?: readonly Tenant[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseTenant(value: unknown): Tenant | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  const variables = Array.isArray(value.variables)
    ? value.variables
        .filter(isRecord)
        .flatMap((v) => (typeof v.name === "string" ? [{ name: v.name, set: v.set === true }] : []))
    : [];
  return {
    name: value.name,
    description: typeof value.description === "string" ? value.description : null,
    strategies: Array.isArray(value.strategies)
      ? value.strategies.filter((s): s is string => typeof s === "string")
      : [],
    manual: value.manual === true,
    variables,
  };
}

/** The `platforms` of an `info` document. */
export function parsePlatforms(document: unknown): PlatformInfo[] {
  if (!isRecord(document) || !Array.isArray(document.platforms)) return [];
  return document.platforms.filter(isRecord).flatMap((p): PlatformInfo[] => {
    if (typeof p.name !== "string") return [];
    return [
      {
        name: p.name,
        enabled: p.enabled === true,
        can_deploy: p.can_deploy === true,
        can_validate: p.can_validate === true,
        can_query: p.can_query === true,
        ...(Array.isArray(p.tenants)
          ? { tenants: p.tenants.map(parseTenant).filter((t): t is Tenant => !!t) }
          : {}),
      },
    ];
  });
}

/** Where a variable's value comes from. */
export type VariableSource = "stored" | "environment" | "unset";

/** `stored` (SecretStorage) wins: the backend injects it over the environment. */
export function variableSource(variable: TenantVariable, stored: ReadonlySet<string>): VariableSource {
  if (stored.has(variable.name)) return "stored";
  return variable.set ? "environment" : "unset";
}

const SOURCE_TEXT: Readonly<Record<VariableSource, string>> = {
  stored: "set · stored in VS Code",
  environment: "set · from the environment",
  unset: "not set",
};

export function capabilitiesText(p: PlatformInfo): string {
  const can = [p.can_deploy && "deploy", p.can_validate && "validate", p.can_query && "query"].filter(
    Boolean,
  );
  return can.join(", ");
}

/** Tree nodes for one folder's platforms. Enabled platforms first. */
export function platformNodes(
  platforms: readonly PlatformInfo[],
  stored: ReadonlySet<string>,
  folder: string,
  prefix = "",
): TreeNode[] {
  const sorted = [...platforms].sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) ||
      platformName(a.name).long.localeCompare(platformName(b.name).long),
  );
  return sorted.map((p) => {
    const id = `${prefix}platform:${p.name}`;
    const label = platformName(p.name).long;
    const can = capabilitiesText(p);
    const children: TreeNode[] = [];
    if (p.enabled) {
      if (p.tenants === undefined) {
        children.push(
          messageNode(`${id}/tenants-need`, "Tenants need a newer opentide", "info", {
            description: "one whose info lists tenants",
            tooltip: "opentide info lists each platform's tenants from opentide#754 on.",
          }),
        );
      } else if (p.tenants.length === 0) {
        children.push(
          messageNode(`${id}/no-tenants`, "No tenant configured", "info", {
            description: `add [[tenants]] to ${p.name}.toml`,
            command: { command: "opentide.sidebar.openPlatformToml", title: "Open", args: [folder, p.name] },
          }),
        );
      } else {
        for (const tenant of p.tenants) children.push(tenantNode(tenant, p.name, stored, folder, id));
      }
    }
    const tenants = p.tenants?.length ?? 0;
    return branch(
      {
        id,
        label,
        description: p.enabled
          ? [`enabled`, tenants ? `${tenants} tenant${tenants === 1 ? "" : "s"}` : "", can]
              .filter(Boolean)
              .join(" · ")
          : `off${can ? ` · can ${can}` : ""}`,
        tooltip: [
          `${label} (${p.name})`,
          p.enabled ? "Enabled" : "Not enabled",
          `Deploy: ${p.can_deploy ? "yes" : "no"} · Validate queries: ${p.can_validate ? "yes" : "no"} · Query: ${p.can_query ? "yes" : "no"}`,
          platformToml(p.name),
        ].join("\n"),
        icon: p.enabled ? "pass-filled" : "circle-large-outline",
        ...(p.enabled ? { iconColor: "testing.iconPassed" } : {}),
        contextValue: p.enabled ? "platform.enabled" : "platform.disabled",
        ref: { kind: "platform", folder, id: p.name, enabled: p.enabled },
        search: `${p.name}\n${label}`.toLowerCase(),
      },
      children,
      "expanded",
    );
  });
}

function tenantNode(
  tenant: Tenant,
  platform: string,
  stored: ReadonlySet<string>,
  folder: string,
  parentId: string,
): TreeNode {
  const id = `${parentId}/tenant:${tenant.name}`;
  const sources = tenant.variables.map((v) => variableSource(v, stored));
  const set = sources.filter((s) => s !== "unset").length;
  const all = set === tenant.variables.length;
  const children = tenant.variables.map((variable, index): TreeNode => {
    const source = sources[index] ?? "unset";
    return {
      id: `${id}/var:${variable.name}`,
      label: variable.name,
      description: SOURCE_TEXT[source],
      tooltip:
        source === "stored"
          ? `$${variable.name} is in VS Code's secret storage and passed to commands that contact ${platform}/${tenant.name}. It is never written to a file.`
          : source === "environment"
            ? `$${variable.name} is set in opentide's environment.`
            : `$${variable.name} is not set. Set it to reach ${platform}/${tenant.name}.`,
      icon: source === "unset" ? "circle-slash" : "key",
      iconColor: source === "unset" ? "problemsWarningIcon.foreground" : "testing.iconPassed",
      contextValue: `variable.${source}`,
      ref: { kind: "variable", folder, platform, tenant: tenant.name, name: variable.name },
      search: variable.name.toLowerCase(),
    };
  });
  return branch(
    {
      id,
      label: tenant.name,
      description: [
        tenant.variables.length ? `${set} of ${tenant.variables.length} credentials set` : "no credentials",
        tenant.strategies.join(", "),
        tenant.manual ? "manual" : "",
      ]
        .filter(Boolean)
        .join(" · "),
      tooltip: [tenant.description ?? "", `Strategies: ${tenant.strategies.join(", ") || "—"}`]
        .filter(Boolean)
        .join("\n"),
      icon: "cloud",
      iconColor: all ? "testing.iconPassed" : "problemsWarningIcon.foreground",
      contextValue: tenant.variables.length ? "tenant.credentials" : "tenant",
      ref: {
        kind: "tenant",
        folder,
        platform,
        tenant: tenant.name,
        variables: tenant.variables.map((v) => v.name),
      },
      search: `${tenant.name}\n${platform}`.toLowerCase(),
    },
    children,
    all ? "collapsed" : "expanded",
  );
}

/** `doctor`'s `credentials` check of one tenant (subject `platform/tenant`), or of the platform. */
export function tenantCheck(
  checks: readonly DoctorCheck[],
  platform: string,
  tenant: string,
): DoctorCheck | undefined {
  const credentials = checks.filter((c) => c.code === "credentials");
  return (
    credentials.find((c) => c.subject === `${platform}/${tenant}`) ??
    credentials.find((c) => c.subject === platform)
  );
}
