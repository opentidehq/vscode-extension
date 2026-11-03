// Which tenants a command reaches, from `opentide --json info` (tenants: opentide#754), and the credentials
// they need. vscode-free.

export interface TenantVariable {
  readonly name: string;
  /** opentide's process environment sets it. */
  readonly set: boolean;
}

export interface Tenant {
  readonly name: string;
  readonly description?: string;
  readonly variables: readonly TenantVariable[];
}

export interface PlatformReach {
  readonly platform: string;
  readonly enabled: boolean;
  /** Undefined when the active opentide does not list tenants (before opentide#754). */
  readonly tenants?: readonly Tenant[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function tenantOf(value: unknown): Tenant | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  const variables = Array.isArray(value.variables)
    ? value.variables
        .filter(isRecord)
        .filter((v) => typeof v.name === "string")
        .map((v) => ({ name: String(v.name), set: v.set === true }))
    : [];
  return {
    name: value.name,
    ...(typeof value.description === "string" && value.description ? { description: value.description } : {}),
    variables,
  };
}

/**
 * The platforms of an `info` document: `only` restricts them (the argv's `--platform`); otherwise the
 * enabled ones.
 */
export function reachOf(info: unknown, only?: readonly string[]): PlatformReach[] {
  if (!isRecord(info) || !Array.isArray(info.platforms)) return [];
  const out: PlatformReach[] = [];
  for (const entry of info.platforms) {
    if (!isRecord(entry)) continue;
    const platform =
      typeof entry.name === "string" ? entry.name : typeof entry.id === "string" ? entry.id : "";
    if (!platform) continue;
    const enabled = entry.enabled === true;
    if (only ? !only.includes(platform) : !enabled) continue;
    const tenants = Array.isArray(entry.tenants)
      ? entry.tenants.map(tenantOf).filter((t): t is Tenant => t !== undefined)
      : undefined;
    out.push({ platform, enabled, ...(tenants ? { tenants } : {}) });
  }
  return out;
}

/** "sentinel (prod, staging) · elastic", for a confirmation or a quick pick separator. */
export function describeReach(reach: readonly PlatformReach[], fallback?: readonly string[]): string {
  if (reach.length === 0)
    return fallback && fallback.length > 0 ? fallback.join(", ") : "the enabled platforms";
  return reach
    .map(({ platform, tenants }) =>
      tenants === undefined
        ? platform
        : tenants.length === 0
          ? `${platform} (no tenants configured)`
          : `${platform} (${tenants.map((t) => t.name).join(", ")})`,
    )
    .join(" · ");
}

/**
 * Variables a tenant needs that nothing sets: not in opentide's environment, not stored, not in the
 * extension host's environment. Sorted, without duplicates.
 */
export function missingVariables(
  reach: readonly PlatformReach[],
  stored: ReadonlySet<string>,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const missing = new Set<string>();
  for (const { tenants } of reach) {
    for (const tenant of tenants ?? []) {
      for (const variable of tenant.variables) {
        if (!variable.set && !stored.has(variable.name) && !env[variable.name]) missing.add(variable.name);
      }
    }
  }
  return [...missing].sort();
}
