// The deploy plan as a tree: platform → tenant → change rows, with the counts each level shows, the icon
// of each action, the summary line and the filters (SPEC §10.5). vscode-free: the view in index.ts turns
// these nodes into tree items. A plan of 5,000 changes builds in a few milliseconds.
import type { Strategy } from "./argv";
import type { Action, ChangeRow, PayloadRow, PlanView } from "./plan";

export type NodeKind =
  | "platform"
  | "tenant"
  | "change"
  | "missing"
  | "skippedGroup"
  | "skipped"
  | "unmatchedGroup"
  | "unmatched";

/** A codicon, and the theme colour it is drawn in. */
export interface NodeIcon {
  readonly id: string;
  readonly color?: string;
}

export interface TreeNode {
  /** Stable for the same plan, so the view keeps what is expanded when it is re-run. */
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon: NodeIcon;
  readonly expanded: boolean;
  readonly children: readonly TreeNode[];
  /** Space-separated words for `when` clauses: `viewItem =~ /\bchange\b/`. */
  readonly context: string;
  readonly platform?: string;
  readonly tenant?: string | null;
  readonly uuid?: string;
  /** `<platform>/<uuid>`: the payload this change opens. */
  readonly payloadKey?: string;
  readonly file?: string;
}

/** What the view shows of the plan: one platform, and one tenant of it. */
export interface PlanFilter {
  readonly platform?: string;
  /** A tenant name, or null for the platform's changes with no tenant. */
  readonly tenant?: string | null;
}

export interface PlanTree {
  readonly roots: readonly TreeNode[];
  readonly byId: ReadonlyMap<string, TreeNode>;
  /** The changes the plan makes (`create`, `update`, `upsert`, `disable`, `delete`; failed rules not counted). */
  readonly changes: number;
}

const ACTION_ORDER: readonly string[] = ["create", "update", "upsert", "disable", "delete"];

/** The icon of a change: by its action, or an error for a rule that did not compile. */
export function actionIcon(action: string, fails = false): NodeIcon {
  if (fails) return { id: "error", color: "errorForeground" };
  switch (action) {
    case "create":
      return { id: "add", color: "charts.green" };
    case "update":
      return { id: "edit", color: "charts.yellow" };
    case "upsert":
      return { id: "diff-modified", color: "charts.yellow" };
    case "delete":
      return { id: "trash", color: "charts.red" };
    case "disable":
      return { id: "circle-slash", color: "disabledForeground" };
    default:
      return { id: "circle-outline", color: "disabledForeground" };
  }
}

/** `+2 ~3 −1`: creates, updates (and upserts), deletes (and disables); a failed rule is `!1`. */
export function changeCounts(changes: readonly ChangeRow[]): string {
  let added = 0;
  let changed = 0;
  let removed = 0;
  let failed = 0;
  for (const change of changes) {
    if (change.fails) failed++;
    else if (change.action === "create") added++;
    else if (change.action === "update" || change.action === "upsert") changed++;
    else if (change.action === "delete" || change.action === "disable") removed++;
  }
  const parts = [
    added > 0 ? `+${added}` : "",
    changed > 0 ? `~${changed}` : "",
    removed > 0 ? `−${removed}` : "",
    failed > 0 ? `!${failed}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "no changes";
}

const byAction = (a: ChangeRow, b: ChangeRow): number =>
  ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) || a.name.localeCompare(b.name);

/** Tenants by name, the one with no tenant last. */
const byTenant = (a: string | null, b: string | null): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b);

function changeTooltip(change: ChangeRow, payload: PayloadRow | undefined, tenant: string | null): string {
  const lines = [
    change.name,
    `${change.action}${change.status ? ` · ${change.status}` : ""}${tenant ? ` · ${tenant}` : ""}`,
  ];
  if (change.fails) lines.push("The rule did not compile, so it is not counted.");
  if (payload?.error) lines.push(payload.error);
  if (payload?.help) lines.push(`help: ${payload.help}`);
  if (payload?.hasDeployed) lines.push("Opens a diff against what is deployed.");
  else if (payload?.hasRequest) lines.push("Opens the request that would be sent.");
  return lines.join("\n");
}

/** The tree of a plan, filtered. */
export function planTree(plan: PlanView, filter: PlanFilter = {}): PlanTree {
  const byId = new Map<string, TreeNode>();
  const add = (node: TreeNode): TreeNode => {
    byId.set(node.id, node);
    return node;
  };
  const roots: TreeNode[] = [];
  for (const platform of plan.platforms) {
    if (filter.platform !== undefined && platform.platform !== filter.platform) continue;
    const payloads = new Map(platform.payloads.map((p) => [p.uuid, p]));
    const tenants = platform.tenants
      .filter((t) => filter.tenant === undefined || t.tenant === filter.tenant)
      .sort((a, b) => byTenant(a.tenant, b.tenant));
    const children: TreeNode[] = [];
    for (const tenant of tenants) {
      const seen = new Map<string, number>();
      const rows = [...tenant.changes].sort(byAction).map((change): TreeNode => {
        const base = `change:${platform.platform}/${tenant.tenant ?? ""}/${change.uuid}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const payload = payloads.get(change.uuid);
        return add({
          id: n === 0 ? base : `${base}#${n}`,
          kind: "change",
          label: change.name,
          description: `${change.action}${change.status ? ` · ${change.status}` : ""}`,
          tooltip: changeTooltip(change, payload, tenant.tenant),
          icon: actionIcon(change.action, change.fails),
          expanded: false,
          children: [],
          context: [
            "change",
            payload?.hasRequest ? "request" : "",
            payload?.hasDeployed ? "deployed" : "",
            payload?.file ? "file" : "",
          ]
            .filter(Boolean)
            .join(" "),
          platform: platform.platform,
          tenant: tenant.tenant,
          uuid: change.uuid,
          ...(payload ? { payloadKey: payload.key } : {}),
          ...(payload?.file ? { file: payload.file } : {}),
        });
      });
      children.push(
        add({
          id: `tenant:${platform.platform}/${tenant.tenant ?? ""}`,
          kind: "tenant",
          label: tenant.tenant ?? "no tenant configured",
          description: changeCounts(tenant.changes),
          icon: { id: "server-environment" },
          expanded: rows.length <= 200,
          children: rows,
          context: "tenant",
          platform: platform.platform,
          tenant: tenant.tenant,
        }),
      );
    }
    if (platform.missingTenants && filter.tenant === undefined)
      children.push(
        add({
          id: `missing:${platform.platform}`,
          kind: "missing",
          label: "No tenants configured",
          description: platform.missingTenants,
          tooltip: `${platform.missingTenants}\nA real deploy would stop here. Add a [[tenants]] entry to the platform's configuration.`,
          icon: { id: "warning", color: "list.warningForeground" },
          expanded: false,
          children: [],
          context: "missing",
          platform: platform.platform,
        }),
      );
    const all = tenants.flatMap((t) => t.changes);
    roots.push(
      add({
        id: `platform:${platform.platform}`,
        kind: "platform",
        label: platform.platform,
        description: changeCounts(all),
        icon: { id: "cloud" },
        expanded: true,
        children,
        context: "platform",
        platform: platform.platform,
      }),
    );
  }
  const skipped = plan.skipped.filter((s) => filter.platform === undefined || s.platform === filter.platform);
  if (skipped.length > 0)
    roots.push(
      add({
        id: "skipped",
        kind: "skippedGroup",
        label: "Skipped",
        description: String(skipped.length),
        icon: { id: "debug-step-over" },
        expanded: false,
        context: "skippedGroup",
        children: skipped.map((s, i) =>
          add({
            id: `skipped:${s.platform}/${s.uuid}#${i}`,
            kind: "skipped",
            label: s.rule || s.uuid,
            description: `${s.platform} · ${s.strategy || s.status}`,
            tooltip: `${s.rule}\nSkipped on ${s.platform}: status ${s.status}, strategy ${s.strategy}.`,
            icon: { id: "circle-slash", color: "disabledForeground" },
            expanded: false,
            children: [],
            context: "skipped",
            platform: s.platform,
            uuid: s.uuid,
          }),
        ),
      }),
    );
  if (plan.unmatched.length > 0)
    roots.push(
      add({
        id: "unmatched",
        kind: "unmatchedGroup",
        label: "Not matched",
        description: String(plan.unmatched.length),
        tooltip: "--uuid and --file values that matched no rule.",
        icon: { id: "question", color: "list.warningForeground" },
        expanded: true,
        context: "unmatchedGroup",
        children: plan.unmatched.map((value, i) =>
          add({
            id: `unmatched:${i}`,
            kind: "unmatched",
            label: value,
            icon: { id: "question", color: "list.warningForeground" },
            expanded: false,
            children: [],
            context: "unmatched",
          }),
        ),
      }),
    );
  const changes = Object.values(plan.counts).reduce((sum, n) => sum + n, 0);
  return { roots, byId, changes };
}

/** The platforms and tenants of a plan, for the filter's picker. */
export function filterChoices(plan: PlanView): {
  readonly platforms: readonly string[];
  readonly tenants: readonly { readonly platform: string; readonly tenant: string | null }[];
} {
  return {
    platforms: plan.platforms.map((p) => p.platform),
    tenants: plan.platforms.flatMap((p) =>
      [...p.tenants]
        .sort((a, b) => byTenant(a.tenant, b.tenant))
        .map((t) => ({ platform: p.platform, tenant: t.tenant })),
    ),
  };
}

const COUNT_LABELS: readonly (readonly [Action, string])[] = [
  ["create", "create"],
  ["update", "update"],
  ["upsert", "create or update"],
  ["disable", "disable"],
  ["delete", "delete"],
];

/** The view's message: what the run was and what it found ("Dry run · PREVIEW · 3 create or update · 1 skipped"). */
export function planMessage(
  plan: PlanView,
  strategies: readonly Strategy[],
  filter: PlanFilter = {},
): string {
  const parts = ["Dry run", strategies.length > 0 ? strategies.join(" + ") : "PREVIEW"];
  const counted = COUNT_LABELS.flatMap(([action, label]) =>
    plan.counts[action] > 0 ? [`${plan.counts[action]} ${label}`] : [],
  );
  parts.push(counted.length > 0 ? counted.join(", ") : "no changes");
  if (plan.skipped.length > 0) parts.push(`${plan.skipped.length} skipped`);
  const failed = plan.platforms
    .flatMap((p) => p.tenants.flatMap((t) => t.changes))
    .filter((c) => c.fails).length;
  if (failed > 0) parts.push(`${failed} failed to compile`);
  if (plan.unmatched.length > 0) parts.push(`${plan.unmatched.length} not matched`);
  if (filter.platform !== undefined || filter.tenant !== undefined)
    parts.push(
      `filtered: ${[filter.platform, filter.tenant === null ? "no tenant" : filter.tenant].filter((v) => v !== undefined).join(" / ")}`,
    );
  return parts.join(" · ");
}
