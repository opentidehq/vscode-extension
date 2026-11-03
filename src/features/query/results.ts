// `opentide --json query` documents as the results panel shows them. vscode-free.
import type { Column, Row } from "./format";
import type { TenantProgress, TenantTab } from "./protocol";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

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
    return {
      key: tabKey(tenant, label),
      tenant,
      label,
      status: result.status === "ok" ? "ok" : "failed",
      columns,
      rows,
      rowCount: num(result.row_count) ?? (result.status === "ok" ? rows.length : null),
      truncated: result.truncated === true,
      partial: result.partial === true,
      language: str(result.language),
      sent: str(result.sent),
      vendorQueryId: str(result.vendor_query_id),
      error: str(result.error),
      detail: str(result.detail),
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
