// Messages between the ATT&CK matrix panel and the host. Shared by both sides: no vscode, no DOM.
import { is, type Protocol, type Validators } from "../../core/webview/protocol";
import type { CellDetail, Layer, MatrixFilters, MatrixView } from "./model";

export interface MatrixState {
  readonly status: "loading" | "ready" | "unavailable" | "error" | "no-folder";
  readonly folder: { readonly path: string; readonly name: string } | null;
  readonly folders: readonly { readonly path: string; readonly name: string }[];
  readonly view: MatrixView | null;
  readonly filters: MatrixFilters;
  /** Unavailable or error: why, and the next action. */
  readonly message: string | null;
  readonly action: { readonly id: string; readonly label: string } | null;
  /** A refresh is running over the data shown. */
  readonly refreshing: boolean;
  /** Commands other features own, when the window has them. */
  readonly features: {
    readonly search: boolean;
    readonly newObjective: boolean;
    readonly navigator: boolean;
  };
}

export interface MatrixProtocol extends Protocol {
  /** `detail` null: no technique selected (the folder changed). */
  toWebview: { state: MatrixState; detail: CellDetail | null; focus: string };
  toHost: {
    ready: undefined;
    filters: MatrixFilters;
    select: string;
    open: string;
    search: string;
    newObjective: string;
    exportNavigator: undefined;
    folder: string;
    action: string;
  };
}

const LAYERS = new Set<Layer>(["rules", "planned", "unaddressed"]);
const optionalString = (value: unknown) => value === undefined || typeof value === "string";

export function isFilters(value: unknown): value is MatrixFilters {
  return (
    is.object(value) &&
    typeof value.layer === "string" &&
    LAYERS.has(value.layer as Layer) &&
    is.boolean(value.excludeInert) &&
    is.boolean(value.inherited) &&
    optionalString(value.platform) &&
    optionalString(value.tenant)
  );
}

const technique = (value: unknown): value is string => is.string(value) && /^T\d{4}(\.\d{3})?$/i.test(value);

export const hostValidators: Validators<MatrixProtocol["toHost"]> = {
  ready: is.nothing,
  filters: isFilters,
  select: technique,
  open: is.string,
  search: technique,
  newObjective: technique,
  exportNavigator: is.nothing,
  folder: is.string,
  action: is.string,
};

export const webviewValidators: Validators<MatrixProtocol["toWebview"]> = {
  state: (value): value is MatrixState =>
    is.object(value) && is.string(value.status) && isFilters(value.filters),
  detail: (value): value is CellDetail | null =>
    value === null || (is.object(value) && is.string(value.id) && Array.isArray(value.rules)),
  focus: is.string,
};
