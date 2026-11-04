// What each platform can do, and its tenants, from `opentide --json info` (`can_query`, `can_validate`,
// and `tenants` where the active opentide reports them, CONTRACTS.md). One document per folder, loaded
// lazily and dropped when the folder's configuration changes. vscode-free.

export interface TenantVariable {
  readonly name: string;
  /** The opentide process environment sets it (credentials stored in the editor are added at run time). */
  readonly set: boolean;
}

export interface TenantInfo {
  readonly name: string;
  readonly description: string;
  readonly strategies: readonly string[];
  readonly manual: boolean;
  readonly variables: readonly TenantVariable[];
}

export interface PlatformCaps {
  readonly name: string;
  readonly enabled: boolean;
  readonly canQuery: boolean;
  readonly canValidate: boolean;
  readonly canDeploy: boolean;
  /** Undefined when the active opentide does not list tenants in `info`. */
  readonly tenants?: readonly TenantInfo[];
}

/** AGENTS.md's capability matrix, used when `info` cannot be read. */
const FALLBACK: Readonly<Record<string, { canQuery: boolean; canValidate: boolean }>> = {
  sentinel: { canQuery: true, canValidate: true },
  defender_for_endpoint: { canQuery: true, canValidate: true },
  elastic: { canQuery: true, canValidate: true },
  splunk: { canQuery: true, canValidate: true },
  sentinel_one: { canQuery: true, canValidate: true },
  carbon_black_cloud: { canQuery: true, canValidate: true },
  crowdstrike: { canQuery: true, canValidate: false },
  harfanglab: { canQuery: true, canValidate: false },
  sysdig: { canQuery: false, canValidate: false },
};

export function fallbackCaps(name: string): PlatformCaps {
  const known = FALLBACK[name];
  return {
    name,
    enabled: true,
    canQuery: known?.canQuery ?? false,
    canValidate: known?.canValidate ?? false,
    canDeploy: known !== undefined,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseTenant(value: unknown): TenantInfo | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  const variables = Array.isArray(value.variables)
    ? value.variables
        .filter(isRecord)
        .flatMap((v) => (typeof v.name === "string" ? [{ name: v.name, set: v.set === true }] : []))
    : [];
  return {
    name: value.name,
    description: typeof value.description === "string" ? value.description : "",
    strategies: Array.isArray(value.strategies)
      ? value.strategies.filter((s): s is string => typeof s === "string")
      : [],
    manual: value.manual === true,
    variables,
  };
}

/** `info`'s `platforms[]`, by name; undefined when the document has none. */
export function parseInfoPlatforms(document: unknown): Map<string, PlatformCaps> | undefined {
  if (!isRecord(document) || !Array.isArray(document.platforms)) return undefined;
  const out = new Map<string, PlatformCaps>();
  for (const entry of document.platforms) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    const fallback = fallbackCaps(entry.name);
    const tenants = Array.isArray(entry.tenants)
      ? entry.tenants.map(parseTenant).filter((t): t is TenantInfo => t !== undefined)
      : undefined;
    out.set(entry.name, {
      name: entry.name,
      enabled: entry.enabled !== false,
      canQuery: typeof entry.can_query === "boolean" ? entry.can_query : fallback.canQuery,
      canValidate: typeof entry.can_validate === "boolean" ? entry.can_validate : fallback.canValidate,
      canDeploy: entry.can_deploy !== false,
      ...(tenants ? { tenants } : {}),
    });
  }
  return out;
}

/** The variables a tenant needs that neither the opentide environment nor the editor's store has. */
export function missingVariables(tenant: TenantInfo, stored: ReadonlySet<string>): string[] {
  return tenant.variables.filter((v) => !v.set && !stored.has(v.name)).map((v) => v.name);
}

export interface PlatformInfoDeps {
  /** `opentide --json info` in the folder; resolves with the document, rejects when none came back. */
  run(folder: string): Promise<{ document: unknown; exitCode: number }>;
}

/**
 * One `info` per folder, single-flight; `invalidate` drops it. An `info` that answers without platforms
 * (a configuration TOML that does not parse) is kept too, until the configuration changes and
 * `invalidate` runs, or every query lens would run `info` again; a run that rejects is retried.
 */
export class PlatformInfoCache {
  private readonly entries = new Map<string, Promise<Map<string, PlatformCaps> | undefined>>();

  constructor(private readonly deps: PlatformInfoDeps) {}

  get(folder: string): Promise<Map<string, PlatformCaps> | undefined> {
    let entry = this.entries.get(folder);
    if (!entry) {
      const settled = this.deps.run(folder).then(
        (result) => ({ value: parseInfoPlatforms(result.document) }),
        () => undefined,
      );
      entry = settled.then((outcome) => outcome?.value);
      this.entries.set(folder, entry);
      // A run that rejected (no document came back) is not cached: the next call tries again.
      const current = entry;
      void settled.then((outcome) => {
        if (outcome === undefined && this.entries.get(folder) === current) this.entries.delete(folder);
      });
    }
    return entry;
  }

  /** The caps of one platform: from `info`, else the built-in matrix. */
  async caps(folder: string, platform: string): Promise<PlatformCaps> {
    return (await this.get(folder))?.get(platform) ?? fallbackCaps(platform);
  }

  invalidate(folder?: string): void {
    if (folder === undefined) this.entries.clear();
    else this.entries.delete(folder);
  }
}
