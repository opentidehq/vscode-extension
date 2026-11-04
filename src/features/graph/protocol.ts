// The messages between the graph panel and its webview (webview/graph/main.ts). No vscode, no DOM.
import { is, type Protocol, type Validators } from "../../core/webview/protocol";
import { isNodeAction, type NodeAction } from "./actions";
import type { ModelPatch } from "./diff";
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
  /** The whole model (the first time, or after a resync); with `patch`, neither. */
  readonly model?: GraphModel;
  /** What changed since the revision the webview has (`patch.from`). */
  readonly patch?: ModelPatch;
  /** The model's revision, with `model`, `patch` or neither (unchanged). */
  readonly revision?: number;
  /** A refresh is running (the model is the last good one). */
  readonly refreshing: boolean;
}

/** Whether the graph follows the active editor (`following`) or is pinned to its object. */
export interface FollowState {
  readonly following: boolean;
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

/** A node context-menu action (another feature's command) on the node with this id. */
export interface NodeActionRequest {
  readonly action: NodeAction;
  readonly id: string;
}

export interface GraphProtocol extends Protocol {
  toWebview: {
    data: GraphData;
    problems: ProblemMap;
    focus: FocusRequest;
    /** The node actions whose commands this window has. */
    actions: readonly NodeAction[];
    follow: FollowState;
  };
  toHost: {
    ready: undefined;
    /** Open the node's file at its line, beside the graph. */
    open: string;
    /** Follow the active editor (true) or keep the graph on its object (false: pinned). */
    follow: boolean;
    /** The webview's model is not the revision a patch applies to: send the whole model. */
    resync: undefined;
    copy: string;
    export: ExportRequest;
    action: GraphAction;
    nodeAction: NodeActionRequest;
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
  follow: is.boolean,
  resync: is.nothing,
  copy: (value): value is string => is.string(value) && value.length <= 10_000,
  export: (value): value is ExportRequest =>
    is.object(value) &&
    typeof value.format === "string" &&
    EXPORT_FORMATS.includes(value.format) &&
    typeof value.data === "string" &&
    value.data.length <= MAX_EXPORT,
  action: (value): value is GraphAction =>
    typeof value === "string" && (GRAPH_ACTIONS as readonly string[]).includes(value),
  nodeAction: (value): value is NodeActionRequest =>
    is.object(value) && isNodeAction(value.action) && is.string(value.id) && value.id.length <= 1000,
  log: (value): value is string => is.string(value) && value.length <= 2000,
};

const isModel = (value: unknown): value is GraphModel =>
  is.object(value) && Array.isArray(value.nodes) && Array.isArray(value.edges);

const isPatch = (value: unknown): value is ModelPatch =>
  is.object(value) &&
  is.number(value.from) &&
  is.number(value.to) &&
  Array.isArray(value.nodes) &&
  is.stringArray(value.removedNodes) &&
  Array.isArray(value.edges) &&
  is.stringArray(value.removedEdges);

export const webviewValidators: Validators<GraphProtocol["toWebview"]> = {
  data: (value): value is GraphData =>
    is.object(value) &&
    typeof value.status === "string" &&
    typeof value.folder === "string" &&
    typeof value.refreshing === "boolean" &&
    (value.model === undefined || isModel(value.model)) &&
    (value.patch === undefined || isPatch(value.patch)) &&
    (value.revision === undefined || is.number(value.revision)),
  problems: (value): value is ProblemMap => is.object(value),
  focus: (value): value is FocusRequest =>
    is.object(value) && is.stringArray(value.ids) && typeof value.explicit === "boolean",
  actions: (value): value is readonly NodeAction[] => Array.isArray(value) && value.every(isNodeAction),
  follow: (value): value is FollowState => is.object(value) && is.boolean(value.following),
};
