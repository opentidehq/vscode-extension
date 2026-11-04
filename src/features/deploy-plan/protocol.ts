// Messages between the deploy plan panel and the host. Shared by both sides: no vscode, no DOM.
import { is, type Protocol, type Validators } from "../../core/webview/protocol";
import type { PlanView } from "./plan";

export type Strategy = "PREVIEW" | "RELEASE";

export type ScopeKind = "changed" | "all" | "selected";

export interface DeployPanelState {
  readonly phase: "running" | "done" | "failed" | "cancelled";
  readonly folder: string;
  readonly strategies: readonly Strategy[];
  readonly scope: ScopeKind;
  readonly platform: string | null;
  /** The rules picked for `selected` ("Suspicious LSASS Access", "3 rules"), when there are any. */
  readonly selection: string | null;
  /** The active opentide has `deploy --uuid` / `--file` (opentide#753). */
  readonly canSelect: boolean;
  /** Rules the panel was opened for, highlighted in the plan. */
  readonly focus: readonly string[];
  readonly platforms: readonly string[];
  readonly argvDisplay: string;
  readonly dryRunCommand: string;
  readonly deployCommand: string;
  readonly plan: PlanView | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  /** The last progress step ("sentinel 1/2"). */
  readonly progress: string | null;
  readonly note: string | null;
  readonly startedAt: number;
  readonly durationMs: number | null;
}

export interface RunRequest {
  readonly strategies: readonly Strategy[];
  readonly scope: ScopeKind;
  readonly platform: string | null;
}

export interface DeployPlanProtocol extends Protocol {
  toWebview: { state: DeployPanelState; progress: string };
  toHost: {
    ready: undefined;
    run: RunRequest;
    cancel: undefined;
    payload: string;
    diff: string;
    open: string;
    copy: "dryRun" | "deploy" | "ci";
    action: string;
  };
}

const STRATEGY = new Set(["PREVIEW", "RELEASE"]);
const SCOPES = new Set(["changed", "all", "selected"]);

export const hostValidators: Validators<DeployPlanProtocol["toHost"]> = {
  ready: is.nothing,
  run: (value): value is RunRequest =>
    is.object(value) &&
    Array.isArray(value.strategies) &&
    value.strategies.length > 0 &&
    value.strategies.every((s) => typeof s === "string" && STRATEGY.has(s)) &&
    typeof value.scope === "string" &&
    SCOPES.has(value.scope) &&
    (value.platform === null || (is.string(value.platform) && /^[a-z_]+$/.test(value.platform))),
  cancel: is.nothing,
  payload: is.string,
  diff: is.string,
  open: is.string,
  copy: (value): value is "dryRun" | "deploy" | "ci" =>
    value === "dryRun" || value === "deploy" || value === "ci",
  action: is.string,
};

export const webviewValidators: Validators<DeployPlanProtocol["toWebview"]> = {
  state: (value): value is DeployPanelState =>
    is.object(value) && is.string(value.phase) && is.string(value.argvDisplay),
  progress: is.string,
};
