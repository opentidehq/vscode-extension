// `opentide --json deploy --dry-run` documents as the deploy plan panel shows them. vscode-free, node-free
// (the webview imports its types).

export type Action = "create" | "update" | "upsert" | "disable" | "delete";

export interface ChangeRow {
  readonly uuid: string;
  readonly name: string;
  readonly status: string;
  readonly action: Action | string;
  /** The rule could not compile, so it is not counted. */
  readonly fails: boolean;
}

export interface TenantPlan {
  /** null: the platform has no tenant configured yet. */
  readonly tenant: string | null;
  readonly changes: readonly ChangeRow[];
}

export interface PayloadRow {
  /** `<platform>/<uuid>`: what the host opens as an `opentide-payload:` document. */
  readonly key: string;
  readonly uuid: string;
  readonly name: string;
  readonly failed: boolean;
  readonly error: string | null;
  readonly code: string | null;
  readonly help: string | null;
  readonly file: string | null;
  readonly hasRequest: boolean;
  /** The plan carries what is deployed now, so the request can be diffed against it. */
  readonly hasDeployed: boolean;
}

export interface PlatformPlan {
  readonly platform: string;
  readonly tenants: readonly TenantPlan[];
  readonly payloads: readonly PayloadRow[];
  /** The platform file with no `[[tenants]]`, when a real deploy would stop there. */
  readonly missingTenants: string | null;
}

export interface SkippedRow {
  readonly rule: string;
  readonly uuid: string;
  readonly platform: string;
  readonly status: string;
  readonly strategy: string;
}

export interface DiagnosticRow {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly help: string | null;
  readonly path: string | null;
  readonly filePath: string | null;
  readonly platform: string;
  readonly uuid: string | null;
  readonly name: string | null;
}

export interface PlanView {
  readonly ok: boolean;
  readonly status: string;
  readonly message: string;
  readonly exitCode: number;
  readonly strategies: readonly string[];
  readonly scope: string | null;
  readonly detail: string | null;
  readonly advice: string | null;
  readonly warnings: readonly string[];
  readonly counts: Readonly<Record<Action, number>>;
  readonly platforms: readonly PlatformPlan[];
  readonly skipped: readonly SkippedRow[];
  readonly diagnostics: readonly DiagnosticRow[];
  /** `--uuid`/`--file` values that matched no rule (exit 1). */
  readonly unmatched: readonly string[];
  readonly failure: { readonly code: string; readonly message: string } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const ACTIONS: readonly Action[] = ["create", "update", "upsert", "disable", "delete"];

/** Keys a payload may carry with what is deployed now; none of opentide 0.21's plans do. */
const DEPLOYED_KEYS = ["deployed_request", "deployed"] as const;

export function deployedRequest(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  for (const key of DEPLOYED_KEYS) if (isRecord(payload[key])) return payload[key] as Record<string, unknown>;
  return undefined;
}

export function planView(document: unknown): PlanView {
  const d = isRecord(document) ? document : {};
  const changes = Array.isArray(d.changes) ? d.changes.filter(isRecord) : [];
  const payloads = isRecord(d.payloads) ? d.payloads : {};
  const missing = isRecord(d.missing_tenants) ? d.missing_tenants : {};
  const order: string[] = [];
  const see = (platform: string) => {
    if (!order.includes(platform)) order.push(platform);
  };
  for (const platform of Object.keys(isRecord(d.plan) ? d.plan : {})) see(platform);
  for (const change of changes) if (typeof change.platform === "string") see(change.platform);
  for (const platform of Object.keys(payloads)) see(platform);
  for (const platform of Object.keys(missing)) see(platform);

  const platforms = order.map((platform): PlatformPlan => {
    const tenants: TenantPlan[] = [];
    for (const change of changes.filter((c) => c.platform === platform)) {
      const tenant = str(change.tenant);
      let entry = tenants.find((t) => t.tenant === tenant);
      if (!entry) {
        entry = { tenant, changes: [] };
        tenants.push(entry);
      }
      (entry.changes as ChangeRow[]).push({
        uuid: str(change.uuid) ?? "",
        name: str(change.name) ?? str(change.uuid) ?? "?",
        status: str(change.status) ?? "",
        action: str(change.action) ?? "?",
        fails: change.fails === true,
      });
    }
    const rows = Array.isArray(payloads[platform]) ? (payloads[platform] as unknown[]).filter(isRecord) : [];
    return {
      platform,
      tenants,
      payloads: rows.map((p): PayloadRow => {
        const uuid = str(p.uuid) ?? "";
        return {
          key: `${platform}/${uuid}`,
          uuid,
          name: str(p.name) ?? uuid,
          failed: p.status === "failed",
          error: str(p.error),
          code: str(p.code),
          help: str(p.help),
          file: str(p.file),
          hasRequest: isRecord(p.api_request),
          hasDeployed: deployedRequest(p) !== undefined,
        };
      }),
      missingTenants: str(missing[platform]),
    };
  });

  const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<Action, number>;
  for (const change of changes) {
    const action = change.action as Action;
    if (ACTIONS.includes(action) && change.fails !== true) counts[action]++;
  }
  const failure = isRecord(d.failure)
    ? { code: str(d.failure.code) ?? "failed", message: str(d.failure.message) ?? "" }
    : null;
  return {
    ok: d.ok === true,
    status: str(d.status) ?? "",
    message: str(d.message) ?? "",
    exitCode: typeof d.exit_code === "number" ? d.exit_code : 0,
    strategies: strings(d.strategies),
    scope: str(d.scope),
    detail: str(d.detail),
    advice: str(d.advice),
    warnings: strings(d.warnings),
    counts,
    platforms,
    skipped: (Array.isArray(d.skipped) ? d.skipped.filter(isRecord) : []).map((s) => ({
      rule: str(s.rule) ?? "",
      uuid: str(s.uuid) ?? "",
      platform: str(s.platform) ?? "",
      status: str(s.status) ?? "",
      strategy: str(s.strategy) ?? "",
    })),
    diagnostics: (Array.isArray(d.diagnostics) ? d.diagnostics.filter(isRecord) : []).map((x) => ({
      code: str(x.code) ?? "",
      severity: x.severity === "warning" ? "warning" : "error",
      message: str(x.message) ?? str(x.code) ?? "",
      help: str(x.help),
      path: str(x.path),
      filePath: str(x.file_path),
      platform: str(x.platform) ?? "",
      uuid: str(x.uuid),
      name: str(x.name),
    })),
    unmatched: strings(d.unmatched),
    failure,
  };
}

/** The api_request (and what is deployed, when the plan carries it) of each payload, by `PayloadRow.key`. */
export function payloadDocuments(
  document: unknown,
): Map<
  string,
  { readonly request: unknown; readonly deployed?: unknown; readonly name: string; readonly platform: string }
> {
  const out = new Map<string, { request: unknown; deployed?: unknown; name: string; platform: string }>();
  const payloads = isRecord(document) && isRecord(document.payloads) ? document.payloads : {};
  for (const [platform, rows] of Object.entries(payloads)) {
    if (!Array.isArray(rows)) continue;
    for (const payload of rows.filter(isRecord)) {
      const uuid = str(payload.uuid) ?? "";
      const deployed = deployedRequest(payload);
      out.set(`${platform}/${uuid}`, {
        request: payload.api_request ?? null,
        ...(deployed ? { deployed } : {}),
        name: str(payload.name) ?? uuid,
        platform,
      });
    }
  }
  return out;
}
