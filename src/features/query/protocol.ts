// Messages between the query results panel and the host. Shared by both sides: no vscode, no DOM.
import { is, type Protocol, type Validators } from "../../core/webview/protocol";
import type { Column, CopyFormat, Row } from "./format";

export type TenantStatus = "pending" | "ok" | "failed";

/**
 * Why a tenant failed, for its next action: `credentials` (a `$VAR` is unset: Set Credential…), `auth`
 * (the tenant refused the credentials: Set Credential…), `network` (unreachable or timed out: Re-run).
 */
export type TenantErrorKind = "credentials" | "auth" | "network" | "other";

/** One result tab: a tenant, or a tenant and one of a rule's queries (`label`). */
export interface TenantTab {
  readonly key: string;
  readonly tenant: string;
  readonly label: string | null;
  readonly status: TenantStatus;
  readonly columns: readonly Column[];
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
  readonly truncated: boolean;
  readonly partial: boolean;
  readonly language: string | null;
  readonly sent: string | null;
  readonly vendorQueryId: string | null;
  readonly error: string | null;
  readonly detail: string | null;
  /** A failed tab's kind of error, and the `$VAR`s it names. */
  readonly errorKind: TenantErrorKind | null;
  readonly variables: readonly string[];
  readonly warnings: readonly string[];
  readonly elapsedMs: number | null;
}

/** `choosing`: opentide asked which tenants (several, none named) and the tenant picker is open. */
export type QueryPhase = "running" | "choosing" | "done" | "failed" | "cancelled";

export interface QueryPanelState {
  readonly title: string;
  /** The rule or query file's name, and the platform id. */
  readonly name: string;
  readonly platformId: string;
  /** Pinned to this query: another query opens its own panel. */
  readonly locked: boolean;
  /** The tenants named on the command line (none: the platform's only tenant, or `all`). */
  readonly tenants: readonly string[];
  readonly platform: string;
  readonly windowLabel: string;
  readonly limit: number;
  readonly maxLimit: number;
  /** What the run contacts, for the globe line: tenant names, or "the only tenant". */
  readonly contacts: string;
  readonly phase: QueryPhase;
  readonly startedAt: number;
  readonly durationMs: number | null;
  /** `opentide --json …` as it ran (redacted). */
  readonly argvDisplay: string;
  readonly message: string;
  /** A failure of the whole run (no tabs), with what to do next. */
  readonly failure: { readonly code: string; readonly message: string; readonly action?: string } | null;
  readonly tabs: readonly TenantTab[];
  /** Elastic Kuery writes preview alerts (the one write). */
  readonly writesPreviewAlerts: boolean;
  /** Windows: a vendor search may keep running after Cancel. */
  readonly cancelMayLeaveSearch: boolean;
  readonly query: string | null;
}

export interface TenantProgress {
  readonly tenant: string;
  readonly label: string | null;
  readonly status: "ok" | "failed";
  readonly rows: number | null;
  readonly elapsedMs: number | null;
}

export interface CopyRequest {
  readonly format: CopyFormat | "cell" | "row";
  readonly text: string;
}

export interface ExportRequest {
  readonly format: "csv" | "jsonl";
  readonly text: string;
  readonly name: string;
}

export interface QueryProtocol extends Protocol {
  toWebview: { state: QueryPanelState; progress: TenantProgress };
  toHost: {
    ready: undefined;
    rerun: { readonly limit?: number } | undefined;
    edit: undefined;
    cancel: undefined;
    copy: CopyRequest;
    export: ExportRequest;
    action: string;
    lock: boolean;
  };
}

const COPY_FORMATS = new Set(["csv", "json", "jsonl", "markdown", "cell", "row"]);

export const hostValidators: Validators<QueryProtocol["toHost"]> = {
  ready: is.nothing,
  rerun: (value): value is { limit?: number } | undefined =>
    is.nothing(value) || (is.object(value) && (value.limit === undefined || is.number(value.limit))),
  edit: is.nothing,
  cancel: is.nothing,
  copy: (value): value is CopyRequest =>
    is.object(value) &&
    typeof value.format === "string" &&
    COPY_FORMATS.has(value.format) &&
    is.string(value.text),
  export: (value): value is ExportRequest =>
    is.object(value) &&
    (value.format === "csv" || value.format === "jsonl") &&
    is.string(value.text) &&
    is.string(value.name),
  action: is.string,
  lock: is.boolean,
};

export const webviewValidators: Validators<QueryProtocol["toWebview"]> = {
  state: (value): value is QueryPanelState =>
    is.object(value) && is.string(value.title) && is.string(value.phase) && Array.isArray(value.tabs),
  progress: (value): value is TenantProgress =>
    is.object(value) && is.string(value.tenant) && (value.status === "ok" || value.status === "failed"),
};
