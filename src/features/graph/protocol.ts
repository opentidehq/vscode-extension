// The messages between the graph panel and its webview (webview/graph/main.ts). No vscode, no DOM.
import { is, type Protocol, type Validators } from "../../core/webview/protocol";
import type { GraphModel, ProblemMap } from "./model";
import type { GraphMode } from "./view";

export type GraphStatus = "loading" | "ready" | "unavailable" | "error" | "no-folder";

export interface GraphData {
  readonly status: GraphStatus;
  /** The workspace folder's name. */
  readonly folder: string;
  /** What to tell the user when there is no graph to draw. */
  readonly message?: string;
  /** `needs-command`: the command path the active opentide lacks. */
  readonly needs?: string;
  /** Why the catalogue is unavailable (`untrusted`, `no-runtime`, `editor-only`, `needs-command`). */
  readonly reason?: string;
  readonly model?: GraphModel;
  /** A refresh is running (the model is the last good one). */
  readonly refreshing: boolean;
}

export interface FocusRequest {
  readonly ids: readonly string[];
  /** Switch to focus mode even when the user picked another (a reveal, or Show in Graph). */
  readonly explicit: boolean;
  readonly mode?: GraphMode;
}

export type ExportFormat = "svg" | "png" | "mermaid";

export interface ExportRequest {
  readonly format: ExportFormat;
  /** SVG or Mermaid text, or PNG bytes as base64. */
  readonly data: string;
}

/** Host commands the webview may ask for; nothing else runs from a webview message. */
export const GRAPH_ACTIONS = ["refresh", "switchRuntime", "showOutput", "manageTrust", "search"] as const;
export type GraphAction = (typeof GRAPH_ACTIONS)[number];

export interface GraphProtocol extends Protocol {
  toWebview: {
    data: GraphData;
    problems: ProblemMap;
    focus: FocusRequest;
  };
  toHost: {
    ready: undefined;
    /** Open the node's file at its line. */
    open: string;
    copy: string;
    export: ExportRequest;
    action: GraphAction;
    /** A timing or note for the output channel. */
    log: string;
  };
}

const EXPORT_FORMATS: readonly string[] = ["svg", "png", "mermaid"];
/** 64 MB of text: a PNG of a 5,000-node graph at scale 2 stays well below. */
const MAX_EXPORT = 64 * 1024 * 1024;

export const hostValidators: Validators<GraphProtocol["toHost"]> = {
  ready: is.nothing,
  open: is.string,
  copy: (value): value is string => is.string(value) && value.length <= 10_000,
  export: (value): value is ExportRequest =>
    is.object(value) &&
    typeof value.format === "string" &&
    EXPORT_FORMATS.includes(value.format) &&
    typeof value.data === "string" &&
    value.data.length <= MAX_EXPORT,
  action: (value): value is GraphAction =>
    typeof value === "string" && (GRAPH_ACTIONS as readonly string[]).includes(value),
  log: (value): value is string => is.string(value) && value.length <= 2000,
};

const isModel = (value: unknown): value is GraphModel =>
  is.object(value) && Array.isArray(value.nodes) && Array.isArray(value.edges);

export const webviewValidators: Validators<GraphProtocol["toWebview"]> = {
  data: (value): value is GraphData =>
    is.object(value) &&
    typeof value.status === "string" &&
    typeof value.folder === "string" &&
    typeof value.refreshing === "boolean" &&
    (value.model === undefined || isModel(value.model)),
  problems: (value): value is ProblemMap => is.object(value),
  focus: (value): value is FocusRequest =>
    is.object(value) && is.stringArray(value.ids) && typeof value.explicit === "boolean",
};
