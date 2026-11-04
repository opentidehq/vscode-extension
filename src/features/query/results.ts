// `opentide --json query` documents as the results panel shows them. vscode-free.
import type { Column, Row } from "./format";
import { type TableViewState, tableViewState } from "./format";
import type { QueryPanelState, TenantErrorKind, TenantProgress, TenantTab } from "./protocol";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** `$VAR` names in a tenant's error ("Sentinel credentials are unset ($AZURE_CLIENT_ID, …)"). */
export function errorVariables(text: string): string[] {
  return [...new Set([...text.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)].map((m) => m[1] ?? ""))].filter(
    Boolean,
  );
}

/** What kind of failure a tenant's `error` and `detail` describe, for the tab's next action. */
export function tenantErrorKind(error: string | null, detail: string | null): TenantErrorKind {
  const text = `${error ?? ""} ${detail ?? ""}`;
  if (/credentials? (are|is) unset|environment variables? .*(not set|unset)|not set:? \$/i.test(text))
    return "credentials";
  if (
    /\b(401|403)\b|unauthori[sz]ed|forbidden|authenticat|AuthorizationFailed|invalid[_ ]client|access denied/i.test(
      text,
    )
  )
    return "auth";
  if (
    /unreachable|cannot reach|timed? ?out|did not answer|connection (refused|reset)|name resolution/i.test(
      text,
    )
  )
    return "network";
  return "other";
}

export function tabKey(tenant: string, label: string | null | undefined): string {
  return label ? `${tenant}\u0000${label}` : tenant;
}

/** One tab per `results[]` entry (a tenant, or a tenant and one of a rule's queries). */
export function tabsFromDocument(document: unknown): TenantTab[] {
  if (!isRecord(document) || !Array.isArray(document.results)) return [];
  return document.results.filter(isRecord).map((result): TenantTab => {
    const tenant = str(result.tenant) ?? "?";
    const label = str(result.label);
    const columns: Column[] = Array.isArray(result.columns)
      ? result.columns
          .filter(isRecord)
          .flatMap((c) => (typeof c.name === "string" ? [{ name: c.name, type: str(c.type) }] : []))
      : [];
    const rows: Row[] = Array.isArray(result.rows) ? result.rows.filter(isRecord) : [];
    // A platform that names no columns: take them from the rows, in first-seen order.
    if (columns.length === 0 && rows.length > 0) {
      const seen = new Set<string>();
      for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
      for (const name of seen) columns.push({ name, type: null });
    }
    const status = result.status === "ok" ? "ok" : "failed";
    const error = str(result.error);
    const detail = str(result.detail);
    return {
      key: tabKey(tenant, label),
      tenant,
      label,
      status,
      columns,
      rows,
      rowCount: num(result.row_count) ?? (result.status === "ok" ? rows.length : null),
      truncated: result.truncated === true,
      partial: result.partial === true,
      language: str(result.language),
      sent: str(result.sent),
      vendorQueryId: str(result.vendor_query_id),
      error,
      detail,
      errorKind: status === "failed" ? tenantErrorKind(error, detail) : null,
      variables: status === "failed" ? errorVariables(`${error ?? ""} ${detail ?? ""}`) : [],
      warnings: Array.isArray(result.warnings)
        ? result.warnings.filter((w): w is string => typeof w === "string")
        : [],
      elapsedMs: num(result.elapsed_ms),
    };
  });
}

/** Tabs before any result: one pending tab per tenant the run contacts. */
export function pendingTabs(tenants: readonly string[]): TenantTab[] {
  return tenants.map(pendingTab);
}

function pendingTab(tenant: string): TenantTab {
  return {
    key: tabKey(tenant, null),
    tenant,
    label: null,
    status: "pending",
    columns: [],
    rows: [],
    rowCount: null,
    truncated: false,
    partial: false,
    language: null,
    sent: null,
    vendorQueryId: null,
    error: null,
    detail: null,
    errorKind: null,
    variables: [],
    warnings: [],
    elapsedMs: null,
  };
}

/** A `tenant` progress event (opentide#756) as a tab update: rows and elapsed time, before the rows arrive. */
export function progressFromEvent(event: Readonly<Record<string, unknown>>): TenantProgress | undefined {
  if (event.event !== "tenant" || typeof event.tenant !== "string") return undefined;
  if (event.status !== "ok" && event.status !== "failed") return undefined;
  return {
    tenant: event.tenant,
    label: str(event.label),
    status: event.status,
    rows: num(event.rows),
    elapsedMs: num(event.elapsed_ms),
  };
}

/** Apply a progress event to the tabs (adding the tab when the run had no tenant list). */
export function applyProgress(tabs: readonly TenantTab[], progress: TenantProgress): TenantTab[] {
  const key = tabKey(progress.tenant, progress.label);
  const base =
    tabs.find((t) => t.key === key) ?? tabs.find((t) => t.key === progress.tenant && t.status === "pending");
  const updated: TenantTab = {
    ...(base ?? pendingTab(progress.tenant)),
    key,
    label: progress.label,
    status: progress.status,
    rowCount: progress.rows,
    elapsedMs: progress.elapsedMs,
  };
  if (!base) return [...tabs, updated];
  return tabs.map((t) => (t === base ? updated : t));
}

/** "120 rows · 1.8 s", "403 Forbidden", "running…" for a tab's chip. */
export function tabSummary(tab: TenantTab): string {
  if (tab.status === "pending") return "running…";
  const time = tab.elapsedMs === null ? "" : ` · ${formatMs(tab.elapsedMs)}`;
  if (tab.status === "failed") return `failed${time}`;
  const n = tab.rowCount ?? tab.rows.length;
  return `${n} row${n === 1 ? "" : "s"}${tab.truncated ? "+" : ""}${time}`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/**
 * The state while the tenant picker is open: the run that asked which tenants is over (opentide answered
 * exit 2 with the choices), so the panel stops its timer and Cancel, and says what it waits for.
 */
export function choosingState(state: QueryPanelState, durationMs: number): QueryPanelState {
  return {
    ...state,
    phase: "choosing",
    durationMs,
    message: `Pick the ${state.platform} tenants to query`,
    tabs: [],
    failure: null,
  };
}

/**
 * Whether a closed panel's state may be kept for `opentide.query.retainResults`: only a finished run. A
 * state closed mid-run is `running` with pending tabs, and reopening it showed a Cancel that cancelled
 * nothing and no Re-run, for the rest of the session.
 */
export function keepable<T extends { readonly phase: string }>(state: T | undefined): state is T {
  return state !== undefined && state.phase !== "running" && state.phase !== "choosing";
}

/**
 * Whether Re-run and "Tenants and window…" are on: not while a run is going (Cancel stands in for
 * Re-run) nor while its tenant picker is open, whose run would be abandoned.
 */
export function canStartRun(phase: string): boolean {
  return phase !== "running" && phase !== "choosing";
}

/**
 * Whether the selected tab has rows to copy or export. A failed, empty or pending tab has none of its
 * own, and the table may still hold the previous tab's rows: exporting them under this tenant's name
 * wrote one tenant's data as another's.
 */
export function exportable(tab: TenantTab | undefined, phase: string): boolean {
  return phase !== "running" && tab?.status === "ok" && tab.rows.length > 0;
}

/** The query panel's webview state (vscode.getState): the selected tab and the table's view. */
export interface QueryViewState {
  readonly selected?: string;
  readonly table?: TableViewState;
}

export function queryViewState(value: unknown): QueryViewState {
  if (typeof value !== "object" || value === null) return {};
  const v = value as Record<string, unknown>;
  const table = tableViewState(v.table);
  return {
    ...(typeof v.selected === "string" ? { selected: v.selected } : {}),
    ...(table ? { table } : {}),
  };
}
