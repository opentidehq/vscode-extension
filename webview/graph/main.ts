// The graph webview (SPEC §10.1): Cytoscape draws, layout.ts lays out, the details pane says what the
// selected node points to and what points to it, and "View as list" shows the same as a keyboard tree.
// Selection and hover only change Cytoscape classes (no re-render, no layout); expanding a node places
// its neighbours beside it. Every action goes to the host.
import "@vscode/codicons/dist/codicon.css";
import cytoscape from "cytoscape";
import { NODE_ACTION_LABELS, type NodeAction, nodeActions } from "../../src/features/graph/actions";
import { canvasColor } from "../../src/features/graph/colors";
import { DetailsIndex, type NodeDetails } from "../../src/features/graph/details";
import { applyPatch } from "../../src/features/graph/diff";
import {
  DIM_CLASS,
  DIM_LIMIT,
  DIM_SLICE,
  type EmphasisClass,
  emphasisOf,
  Incidence,
  planEmphasis,
  slices,
} from "../../src/features/graph/emphasis";
import {
  collapsibleNeighbours,
  hiddenNeighbours,
  NO_OVERRIDES,
  type Overrides,
  placeNear,
  withOverrides,
} from "../../src/features/graph/expand";
import { type ExportPalette, KIND_SHAPES, toMermaid, toSvg, truncate } from "../../src/features/graph/export";
import { SelectionHistory } from "../../src/features/graph/history";
import {
  bounds,
  HUGE_LAYOUT,
  layout,
  NODE_BOX,
  type Point,
  stabilize,
} from "../../src/features/graph/layout";
import {
  describe,
  keptFocus,
  type ListGroup,
  listGroups,
  listKey,
  opensMenu,
} from "../../src/features/graph/list";
import {
  ALL_KINDS,
  edgeLabel,
  facets,
  type GraphModel,
  type GraphNode,
  KIND_LABELS,
  type NodeKind,
  OBJECT_KINDS,
  OPTIONAL_KINDS,
  type ProblemMap,
} from "../../src/features/graph/model";
import { type ArrowDirection, arrowDirection, nodeInDirection } from "../../src/features/graph/navigate";
import {
  type ExportFormat,
  type GraphData,
  type GraphProtocol,
  webviewValidators,
} from "../../src/features/graph/protocol";
import {
  clampDepth,
  computeView,
  type GraphMode,
  type GraphView,
  hasErrors,
  initialMode,
  passesFilters,
  searchNodes,
  type ViewOptions,
} from "../../src/features/graph/view";
import { NODE_ICONS, themeVar } from "../../src/features/graph/words";
import { createChannel, vscodeApi } from "../shared/channel";
import { paneContent, paneSkeleton } from "./detailsPane";
import { CSS_ESCAPE, h, icon, iconButton, reducedMotion } from "./dom";
import { glyphUri } from "./glyphs";
import { CSS } from "./styles";

// ---------------------------------------------------------------------------------------------- setup

const script = document.currentScript as HTMLScriptElement | null;
const scriptNonce = script?.nonce ?? "";
const style = document.createElement("style");
style.nonce = scriptNonce;
style.textContent = CSS;
document.head.append(style);
// The codicon font and its stylesheet, bundled next to this script (dist/webview/graph.css).
if (script?.src) {
  const link = h("link", { rel: "stylesheet", href: script.src.replace(/\.js(\?.*)?$/, ".css") });
  link.nonce = scriptNonce;
  document.head.append(link);
}

const channel = createChannel<GraphProtocol>(webviewValidators);

interface Persisted {
  depth: number;
  kinds: NodeKind[];
  list: boolean;
  problemsOnly: boolean;
  details: boolean;
  /** The details pane's width as the user set it; 0: a third of the panel. */
  detailsWidth: number;
}

const DEFAULTS: Persisted = {
  // One hop plus the chain the focus serves: a rule shows its objective and threat.
  depth: 1,
  kinds: [...OBJECT_KINDS],
  list: false,
  problemsOnly: false,
  details: true,
  detailsWidth: 0,
};

function restore(): Persisted {
  const saved = vscodeApi().getState() as Partial<Persisted> | undefined;
  return {
    depth: clampDepth(typeof saved?.depth === "number" ? saved.depth : DEFAULTS.depth),
    kinds: Array.isArray(saved?.kinds)
      ? saved.kinds.filter((kind): kind is NodeKind => (ALL_KINDS as readonly string[]).includes(kind))
      : DEFAULTS.kinds,
    list: typeof saved?.list === "boolean" ? saved.list : DEFAULTS.list,
    problemsOnly: typeof saved?.problemsOnly === "boolean" ? saved.problemsOnly : DEFAULTS.problemsOnly,
    details: typeof saved?.details === "boolean" ? saved.details : DEFAULTS.details,
    detailsWidth:
      typeof saved?.detailsWidth === "number" && Number.isFinite(saved.detailsWidth)
        ? Math.min(800, Math.max(0, saved.detailsWidth))
        : DEFAULTS.detailsWidth,
  };
}

const settings = restore();
const save = (): void => vscodeApi().setState(settings);

let data: GraphData | undefined;
let model: GraphModel | undefined;
let revision: number | undefined;
let problems: ProblemMap = {};
let mode: GraphMode | undefined;
let focus: string[] = [];
let platform = "";
let status = "";
let searchText = "";
let view: GraphView = { nodes: [], edges: [], unknownFocus: [] };
let lastKey = "";
let lastIds = "";
let positions = new Map<string, Point>();
let cy: cytoscape.Core | undefined;
/** The canvas was made for a large view (textures while panning, no edges while zooming). */
let cyLarge = false;
let nodesById = new Map<string, GraphNode>();
let viewIndex = new Incidence([]);
let modelIndex = new Incidence([]);
let detailsIndex: DetailsIndex | undefined;
let overrides: Overrides = NO_OVERRIDES;
let selected: string | undefined;
let hovered: string | undefined;
let following = true;
let firstPaint = true;
const history = new SelectionHistory();

// -------------------------------------------------------------------------------------------- DOM

const root = document.getElementById("root") ?? document.body;
root.removeAttribute("role");

const backButton = iconButton("arrow-left", "Back (Alt+Left)");
const forwardButton = iconButton("arrow-right", "Forward (Alt+Right)");
const targetIcon = icon("circle-large-outline");
const targetState = h("span", { class: "follow-state", text: "Following" });
const targetName = h("span", { class: "name", text: "—", role: "button", tabindex: "0" });
const pinButton = iconButton("pin", "Pin: stay on this object instead of following the editor", {
  pressed: false,
});
const target = h(
  "span",
  { class: "target", role: "group", "aria-label": "Graph target" },
  targetIcon,
  targetState,
  targetName,
  pinButton,
);
const modeButtons: Record<GraphMode, HTMLButtonElement> = {
  focus: h("button", {
    type: "button",
    "aria-pressed": "false",
    text: "Focus",
    title: "The object and its neighbours",
  }),
  catalogue: h("button", {
    type: "button",
    "aria-pressed": "false",
    text: "Catalogue",
    title: "Every object",
  }),
  chains: h("button", {
    type: "button",
    "aria-pressed": "false",
    text: "Chains",
    title: "Threats and their chaining",
  }),
};
const modeGroup = h(
  "span",
  { class: "segmented", role: "group", "aria-label": "Scope" },
  modeButtons.focus,
  modeButtons.catalogue,
  modeButtons.chains,
);
const depthSelect = h(
  "select",
  { "aria-label": "Hops around the focus", title: "Hops around the focus" },
  h("option", { value: "1", text: "1 hop" }),
  h("option", { value: "2", text: "2 hops" }),
  h("option", { value: "3", text: "3 hops" }),
);
const kindsBox = h("div", { role: "group", "aria-label": "Kinds of node to show" });
const platformSelect = h("select", { "aria-label": "Platform" });
const statusSelect = h("select", { "aria-label": "Status" });
const problemsBox = h("input", { type: "checkbox" });
const clearFiltersButton = h("button", { type: "button", class: "item", text: "Clear filters" });
const filtersBadge = h("span", { class: "badge", hidden: true });
const filtersPopup = h(
  "div",
  { class: "popup" },
  h("span", { class: "heading", text: "Kinds" }),
  kindsBox,
  h("span", { class: "heading", text: "Rules" }),
  platformSelect,
  statusSelect,
  h("label", {}, problemsBox, "Problems only"),
  clearFiltersButton,
);
const filtersSummary = h(
  "summary",
  { class: "icon-button", role: "button", "aria-label": "Filters", title: "Filters" },
  icon("filter"),
  h("span", { class: "text", text: "Filters" }),
  filtersBadge,
);
const filtersMenu = h("details", { class: "menu" }, filtersSummary, filtersPopup);
const searchBox = h("input", {
  type: "search",
  placeholder: "Search",
  "aria-label": "Search the graph: name, UUID, path or technique. Enter jumps to the next match.",
});
const searchCount = h("span", { class: "count", "aria-live": "polite" });
const search = h("span", { class: "search" }, icon("search"), searchBox, searchCount);
const fitButton = iconButton("screen-full", "Fit the graph to the panel (0)");
const relayoutButton = iconButton("refresh", "Lay the graph out again");
const listButton = iconButton("list-tree", "View as list", { pressed: false });
const detailsButton = iconButton("layout-sidebar-right", "Show the details pane", { pressed: true });
const exportPopup = h(
  "div",
  { class: "popup", role: "menu" },
  h("button", { type: "button", class: "item", role: "menuitem", "data-format": "svg", text: "SVG…" }),
  h("button", { type: "button", class: "item", role: "menuitem", "data-format": "png", text: "PNG…" }),
  h("button", {
    type: "button",
    class: "item",
    role: "menuitem",
    "data-format": "mermaid",
    text: "Mermaid…",
  }),
);
const exportMenu = h(
  "details",
  { class: "menu right" },
  h(
    "summary",
    { class: "icon-button", role: "button", "aria-label": "Export", title: "Export" },
    icon("export"),
  ),
  exportPopup,
);

const toolbar = h(
  "div",
  { class: "toolbar", role: "toolbar", "aria-label": "Graph" },
  h("span", { class: "group", role: "group", "aria-label": "History" }, backButton, forwardButton),
  h("span", { class: "group" }, target),
  h("span", { class: "group", role: "group", "aria-label": "Scope" }, modeGroup, depthSelect),
  h("span", { class: "group" }, filtersMenu, search),
  h("span", { class: "spacer" }),
  h(
    "span",
    { class: "group", role: "group", "aria-label": "View" },
    fitButton,
    relayoutButton,
    listButton,
    detailsButton,
  ),
  h("span", { class: "group" }, exportMenu),
);
const progress = h("div", { class: "progress", role: "progressbar", "aria-label": "Loading", hidden: false });
const statusLine = h("div", { class: "status", role: "status", "aria-live": "polite" });
const canvas = h("div", {
  id: "canvas",
  tabindex: "0",
  role: "application",
  "aria-roledescription": "graph",
  "aria-label":
    "Graph. Arrow keys move between nodes, Enter opens, Escape clears the selection, plus and minus expand or collapse the selected node (or zoom), 0 fits, Shift+F10 opens the node's menu. View as list reads it as a tree.",
});
const list = h("ul", { id: "list", role: "tree", "aria-label": "Graph as a list", hidden: true });
const stateBox = h("div", { class: "state", hidden: true });
const tooltip = h("div", { class: "tooltip", role: "tooltip", hidden: true });
const contextMenu = h("div", { class: "context-menu", role: "menu", hidden: true });
const expandButton = iconButton("add", "Show its hidden neighbours (+)");
const collapseButton = iconButton("remove", "Hide its neighbours that link to nothing else (−)");
const nodeTools = h(
  "div",
  { class: "node-tools", role: "group", "aria-label": "Selected node", hidden: true },
  expandButton,
  collapseButton,
);
const main = h("div", { class: "main" }, canvas, list, stateBox, tooltip, contextMenu, nodeTools);
const splitter = h("div", {
  class: "splitter",
  role: "separator",
  tabindex: "0",
  "aria-orientation": "vertical",
  "aria-label": "Resize the details pane",
  "aria-valuemin": "200",
  "aria-valuemax": "800",
});
const details = h("aside", { class: "details", "aria-label": "Details", tabindex: "-1" });
const body = h("div", { class: "body" }, main, splitter, details);
const legend = h("div", { class: "legend", "aria-label": "Legend" });
root.append(toolbar, progress, statusLine, body, legend);

function renderLegend(): void {
  const entry = (...children: (Node | string)[]): HTMLElement => h("span", { class: "entry" }, ...children);
  legend.replaceChildren(
    entry(h("span", { class: "line out", "aria-hidden": "true" }), "→ out"),
    entry(h("span", { class: "line in", "aria-hidden": "true" }), "← in"),
    h("span", { class: "sep", "aria-hidden": "true" }),
    ...ALL_KINDS.filter((kind) => kind !== "missing" && (settings.kinds.includes(kind) || mode === "chains"))
      .filter((kind) => mode !== "chains" || kind === "threat")
      .map((kind) => {
        const visual = NODE_ICONS[kind];
        const glyph = icon(visual.codicon);
        glyph.style.color = `var(${themeVar(visual.themeColor)})`;
        return entry(glyph, KIND_LABELS[kind]);
      }),
    h("span", { class: "sep", "aria-hidden": "true" }),
    entry(h("span", { class: "line missing", "aria-hidden": "true" }), icon("warning", "error"), "missing"),
    entry(h("span", { class: "error", "aria-hidden": "true", text: "✗" }), "has errors"),
  );
}

function renderKinds(): void {
  kindsBox.replaceChildren(
    ...[...OBJECT_KINDS, ...OPTIONAL_KINDS].map((kind) => {
      const box = h("input", { type: "checkbox", value: kind });
      box.checked = settings.kinds.includes(kind);
      box.addEventListener("change", () => {
        settings.kinds = box.checked
          ? [...new Set([...settings.kinds, kind])]
          : settings.kinds.filter((known) => known !== kind);
        save();
        renderLegend();
        render();
      });
      const visual = NODE_ICONS[kind];
      const glyph = icon(visual.codicon);
      glyph.style.color = `var(${themeVar(visual.themeColor)})`;
      return h("label", {}, box, glyph, KIND_LABELS[kind]);
    }),
  );
}

function fillSelect(
  select: HTMLSelectElement,
  all: string,
  values: readonly string[],
  current: string,
): void {
  select.replaceChildren(
    h("option", { value: "", text: all }),
    ...values.map((value) => h("option", { value, text: value })),
  );
  select.value = values.includes(current) ? current : "";
}

// ------------------------------------------------------------------------------------------ colours

function cssVar(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

interface Palette extends ExportPalette {
  readonly focus: string;
  readonly match: string;
  readonly muted: string;
  readonly out: string;
  readonly in: string;
  readonly contrast: string | undefined;
}

function palette(): Palette {
  const color = (name: string, fallback: string): string => canvasColor(cssVar(name), fallback).color;
  const foreground = color("--vscode-editor-foreground", color("--vscode-foreground", "#888888"));
  const kinds = Object.fromEntries(
    ALL_KINDS.map((kind) => [kind, color(themeVar(NODE_ICONS[kind].themeColor), foreground)]),
  ) as Record<NodeKind, string>;
  const contrast = cssVar("--vscode-contrastBorder");
  return {
    background: color("--vscode-editor-background", "#1e1e1e"),
    foreground,
    edge: color("--vscode-editorLineNumber-foreground", color("--vscode-descriptionForeground", foreground)),
    error: color("--vscode-errorForeground", "#f14c4c"),
    font: cssVar("--vscode-font-family") || "sans-serif",
    kinds,
    focus: color("--vscode-focusBorder", foreground),
    match: color("--vscode-editor-findMatchBorder", color("--vscode-focusBorder", foreground)),
    muted: color("--vscode-descriptionForeground", foreground),
    out: color("--vscode-charts-orange", "#d18616"),
    in: color("--vscode-charts-blue", "#3794ff"),
    contrast: contrast ? canvasColor(contrast, foreground).color : undefined,
  };
}

function stylesheet(large: boolean): cytoscape.StylesheetJson {
  const colors = palette();
  const border = colors.contrast ?? colors.background;
  const sheet: cytoscape.StylesheetJson = [
    {
      selector: "node",
      style: {
        width: 24,
        height: 24,
        "background-color": colors.foreground,
        "background-width": "62%",
        "background-height": "62%",
        "background-clip": "none",
        "border-width": colors.contrast ? 2 : 1,
        "border-color": border,
        label: "data(display)",
        color: colors.foreground,
        "font-family": colors.font,
        "font-size": 11,
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 4,
        // Labels come truncated (truncate()): Cytoscape's own ellipsis measures each label character by
        // character, seconds of the first frame at 5,000 nodes. The tooltip has the full name.
        "text-wrap": "none",
        "min-zoomed-font-size": large ? 9 : 6,
        "overlay-opacity": 0,
        "transition-property": "opacity",
        "transition-duration": 0,
      },
    },
    ...ALL_KINDS.map((kind) => {
      // Above 1,500 nodes the glyphs cost a draw each per frame and are too small to see: shapes only.
      const glyph = large
        ? undefined
        : glyphUri(NODE_ICONS[kind].codicon, kind === "missing" ? colors.error : colors.background);
      return {
        selector: `node[kind = "${kind}"]`,
        style: {
          shape: KIND_SHAPES[kind] as cytoscape.Css.NodeShape,
          "background-color": colors.kinds[kind],
          ...(glyph ? { "background-image": glyph } : {}),
        },
      };
    }),
    {
      selector: 'node[kind = "missing"]',
      style: {
        "background-opacity": 0,
        "border-style": "dashed",
        "border-width": 2,
        "border-color": colors.error,
        color: colors.error,
      },
    },
    { selector: "node.error", style: { "border-width": 3, "border-color": colors.error } },
    { selector: "node.focus", style: { "font-weight": "bold" } },
    {
      selector: "edge",
      style: {
        width: 1.2,
        "line-color": colors.edge,
        "target-arrow-color": colors.edge,
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.8,
        "curve-style": large ? "straight" : "bezier",
        "font-family": colors.font,
        "font-size": 10,
        color: colors.muted,
        "text-background-color": colors.background,
        "text-background-opacity": 0.85,
        "text-background-padding": "2px",
        "min-zoomed-font-size": 8,
        "text-rotation": "autorotate",
        "overlay-opacity": 0,
      },
    },
    { selector: "edge.labelled", style: { label: "data(label)" } },
    {
      selector: "edge.missing",
      style: { "line-style": "dashed", "line-color": colors.error, "target-arrow-color": colors.error },
    },
    // In and out: the selected (or hovered) node's edges and neighbours, everything else dimmed.
    { selector: `.${DIM_CLASS}`, style: { opacity: 0.16 } },
    {
      selector: "node.em-center",
      style: {
        "outline-width": 3,
        "outline-color": colors.focus,
        "outline-offset": 2,
        "font-weight": "bold",
        "z-index": 20,
      },
    },
    {
      selector: "node.em-out",
      style: { "outline-width": 2, "outline-color": colors.out, "outline-offset": 2, "z-index": 15 },
    },
    {
      selector: "node.em-in",
      style: { "outline-width": 2, "outline-color": colors.in, "outline-offset": 2, "z-index": 15 },
    },
    {
      selector: "node.em-both",
      style: {
        "outline-width": 3,
        "outline-color": colors.out,
        "border-color": colors.in,
        "border-width": 3,
        "z-index": 15,
      },
    },
    {
      selector: "edge.em-out",
      style: {
        width: 2.5,
        "line-color": colors.out,
        "target-arrow-color": colors.out,
        "arrow-scale": 1.2,
        label: "data(label)",
        color: colors.foreground,
        "z-index": 10,
      },
    },
    {
      selector: "edge.em-in",
      style: {
        width: 2.5,
        "line-color": colors.in,
        "target-arrow-color": colors.in,
        "arrow-scale": 1.2,
        label: "data(label)",
        color: colors.foreground,
        "z-index": 10,
      },
    },
    {
      selector: "edge.missing.em-out",
      style: { "line-color": colors.error, "target-arrow-color": colors.error },
    },
    {
      selector: "node.match",
      style: { "outline-width": 3, "outline-color": colors.match, "outline-offset": 4 },
    },
  ];
  return sheet;
}

// -------------------------------------------------------------------------------------------- canvas

function ensureCanvas(large: boolean): cytoscape.Core {
  if (cy && cyLarge === large) return cy;
  if (cy) {
    cy.destroy();
    cy = undefined;
    emphasis.reset();
  }
  const core = cytoscape({
    container: canvas,
    style: stylesheet(large),
    layout: { name: "preset" },
    minZoom: 0.05,
    maxZoom: 3,
    boxSelectionEnabled: false,
    autounselectify: true,
    // SPEC §10.1 "Scale": above 1,500 nodes, pan and zoom move a texture of the graph, without edges.
    textureOnViewport: large,
    hideEdgesOnViewport: large,
    motionBlur: false,
    ...(large ? { pixelRatio: 1 } : {}),
  });
  core.on("tap", "node", (event) => {
    hideOverlays();
    select(event.target.id(), { center: false });
  });
  core.on("dbltap", "node", (event) => {
    hideOverlays();
    channel.post("open", event.target.id());
  });
  core.on("cxttap", "node", (event) => {
    select(event.target.id(), { center: false });
    showContextMenu(event.target.id(), event.renderedPosition);
  });
  core.on("tap", (event) => {
    if (event.target === core) {
      hideOverlays();
      clearSelection();
    }
  });
  core.on("mouseover", "node", (event) => {
    hover(event.target.id());
    showTooltip(event.target.id(), event.renderedPosition);
  });
  core.on("mouseout", "node", () => {
    tooltip.hidden = true;
    hover(undefined);
  });
  core.on("dragfree", "node", (event) => {
    const node = event.target as cytoscape.NodeSingular;
    positions.set(node.id(), { ...node.position() });
  });
  core.on("viewport", () => {
    tooltip.hidden = true;
    placeNodeTools();
  });
  core.on("position", "node", (event) => {
    if (event.target.id() === selected) placeNodeTools();
  });
  cy = core;
  cyLarge = large;
  return core;
}

/**
 * The emphasis classes on the canvas, and the dimming: changed by difference only, so moving the
 * selection or the hover costs the neighbourhoods involved. Showing or clearing the dimming of a large
 * view is spread over frames.
 */
class Emphasis {
  private applied = new Map<string, EmphasisClass>();
  private dimmed = false;
  private generation = 0;

  reset(): void {
    this.applied = new Map();
    this.dimmed = false;
    this.generation += 1;
  }

  /** Elements just drawn: dimmed too while the emphasis dims the rest. */
  adopt(ids: readonly string[]): void {
    const core = cy;
    if (!core || !this.dimmed || ids.length === 0) return;
    core.batch(() => {
      for (const id of ids) if (!this.applied.has(id)) core.getElementById(id).addClass(DIM_CLASS);
    });
  }

  apply(next: Map<string, EmphasisClass>, dim: boolean): void {
    const core = cy;
    if (!core) return;
    const wantDim = dim && next.size > 0;
    const plan = planEmphasis(this.applied, next);
    const flip = wantDim !== this.dimmed;
    const element = (id: string) => core.getElementById(id);
    core.batch(() => {
      for (const [id, cls] of plan.remove) element(id).removeClass(cls);
      for (const [id, cls] of plan.add) element(id).addClass(cls);
      if (!flip && wantDim) {
        for (const id of plan.dim) element(id).addClass(DIM_CLASS);
        for (const id of plan.undim) element(id).removeClass(DIM_CLASS);
      }
    });
    this.applied = next;
    if (flip) {
      this.dimmed = wantDim;
      this.reconcileDimming();
    }
  }

  /** Dim or undim every element to match the current emphasis: at once, or a slice per frame. */
  private reconcileDimming(): void {
    const core = cy;
    if (!core) return;
    const generation = ++this.generation;
    const all = core.elements().toArray();
    const run = (part: readonly cytoscape.SingularElementArgument[]): void => {
      core.batch(() => {
        for (const ele of part) ele.toggleClass(DIM_CLASS, this.dimmed && !this.applied.has(ele.id()));
      });
    };
    if (all.length <= DIM_LIMIT) {
      run(all);
      return;
    }
    const parts = slices(all, DIM_SLICE);
    const step = (): void => {
      const part = parts.shift();
      if (!part || generation !== this.generation) return;
      run(part);
      if (parts.length > 0) requestAnimationFrame(step);
    };
    step();
  }
}

const emphasis = new Emphasis();

/** Show the in/out emphasis of the hovered node, else the selected one. */
function refreshEmphasis(): void {
  if (!cy || settings.list) return;
  const started = performance.now();
  const id = hovered ?? selected;
  const shown = id && cy.getElementById(id).nonempty() ? id : undefined;
  // A hover on a large view colours the neighbourhood without dimming the rest (that costs a frame).
  const small = view.nodes.length + view.edges.length <= DIM_LIMIT;
  const dim = shown !== undefined && (small || hovered === undefined || selected !== undefined);
  emphasis.apply(emphasisOf(viewIndex, shown), dim);
  performance.measure(hovered ? "graph:hover" : "graph:select", { start: started });
}

function viewOptions(): ViewOptions {
  return {
    mode: mode ?? "focus",
    focus,
    depth: settings.depth,
    kinds: new Set(settings.kinds),
    platforms: new Set(platform ? [platform] : []),
    statuses: new Set(status ? [status.toLowerCase()] : []),
    problemsOnly: settings.problemsOnly,
  };
}

function viewKey(): string {
  return JSON.stringify({
    mode,
    focus: mode === "focus" ? [...focus].sort() : [],
    depth: mode === "focus" ? settings.depth : 0,
    kinds: [...settings.kinds].sort(),
    platform,
    status,
    problemsOnly: settings.problemsOnly,
  });
}

function nodeErrors(): Set<string> {
  return new Set(view.nodes.filter((node) => hasErrors(node, problems)).map((node) => node.id));
}

/** The characters of a node's label on the canvas (about 150 px at 11 px). */
const LABEL_LIMIT = 26;

/** At most this many new nodes join a drawn view beside their neighbours; more lay it out again. */
const INCREMENTAL_LIMIT = 80;

interface RenderOptions {
  readonly fit?: boolean;
  readonly relayout?: boolean;
  /** Nodes that join should grow from this point (an expanded node). */
  readonly growFrom?: string;
}

function render(options: RenderOptions = {}): void {
  if (!model || !mode) return;
  const started = performance.now();
  const viewSettings = viewOptions();
  const key = viewKey();
  const sameView = key === lastKey;
  if (!sameView) overrides = NO_OVERRIDES;
  const base = computeView(model, problems, viewSettings);
  const passes = (node: GraphNode): boolean => passesFilters(node, viewSettings);
  view = withOverrides(model, base, overrides, passes);
  nodesById = new Map(view.nodes.map((node) => [node.id, node]));
  viewIndex = new Incidence(view.edges);
  const ids = `${view.nodes.map((n) => n.id).join("\n")}|${view.edges.map((e) => e.id).join("\n")}`;
  let grown: string[] = [];
  if (!sameView || options.relayout) {
    positions = layout(view.nodes, view.edges);
  } else if (ids !== lastIds) {
    const added = view.nodes.filter((node) => !positions.has(node.id)).map((node) => node.id);
    for (const id of [...positions.keys()]) if (!nodesById.has(id)) positions.delete(id);
    if (added.length > INCREMENTAL_LIMIT) {
      positions = stabilize(positions, layout(view.nodes, view.edges));
    } else if (added.length > 0) {
      for (const [id, point] of placeNear(positions, added, view.edges)) positions.set(id, point);
      grown = added;
    }
  }
  const laidOut = performance.now();
  performance.measure("graph:layout", { start: started, end: laidOut });
  lastKey = key;
  lastIds = ids;
  history.retain((id) => detailsIndex?.node(id) !== undefined);
  if (selected && !detailsIndex?.node(selected)) selected = undefined;

  updateToolbar();
  updateStatus();
  if (showEmptyFocus()) return;
  if (settings.list) renderList();
  else drawCanvas(!sameView || options.fit === true, grown, options.growFrom);
  renderDetails();
  const done = performance.now();
  updateStatus();
  if (firstPaint) {
    firstPaint = false;
    performance.measure("graph:first-paint", { start: started });
  }
  performance.measure("graph:render", { start: started });
  // Until the canvas has drawn it: Cytoscape draws on the next animation frame.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => performance.measure("graph:render-to-frame", { start: started })),
  );
  channel.post(
    "log",
    `${mode} view: ${view.nodes.length} nodes, ${view.edges.length} edges; layout ${Math.round(laidOut - started)} ms, draw ${Math.round(done - laidOut)} ms`,
  );
}

function drawCanvas(fit: boolean, grown: readonly string[], growFrom: string | undefined): void {
  stateBox.hidden = true;
  list.hidden = true;
  canvas.hidden = false;
  const large = view.nodes.length > HUGE_LAYOUT;
  const started = performance.now();
  const core = ensureCanvas(large);
  core.resize();
  const errors = nodeErrors();
  const focusSet = new Set(focus);
  const labelled = view.edges.length <= 300;
  const grow = new Set(grown);
  const animate = grown.length > 0 && !reducedMotion();
  const added: string[] = [];
  // New elements are added in one call, with their classes: per element, an add and then class
  // toggles each restyle it again (seconds at 5,000 nodes).
  const fresh: cytoscape.ElementDefinition[] = [];
  core.batch(() => {
    const wanted = new Set([...view.nodes.map((n) => n.id), ...view.edges.map((e) => e.id)]);
    core.elements().forEach((element) => {
      if (!wanted.has(element.id())) element.remove();
    });
    for (const node of view.nodes) {
      const position = positions.get(node.id) ?? { x: 0, y: 0 };
      const error = errors.has(node.id) && node.kind !== "missing";
      const display = truncate(`${error ? "✗ " : ""}${node.label}`, LABEL_LIMIT);
      const focused = mode === "focus" && focusSet.has(node.id);
      const existing = core.getElementById(node.id);
      if (existing.nonempty()) {
        if (existing.data("display") !== display || existing.data("kind") !== node.kind)
          existing.data({ display, kind: node.kind });
        const at = existing.position();
        if (at.x !== position.x || at.y !== position.y) existing.position(position);
        if (existing.hasClass("error") !== error) existing.toggleClass("error", error);
        if (existing.hasClass("focus") !== focused) existing.toggleClass("focus", focused);
      } else {
        const start = animate && grow.has(node.id) && growFrom ? positions.get(growFrom) : undefined;
        added.push(node.id);
        fresh.push({
          group: "nodes",
          data: { id: node.id, display, kind: node.kind },
          position: { ...(start ?? position) },
          classes: [error ? "error" : "", focused ? "focus" : ""].filter(Boolean).join(" "),
        });
      }
    }
    for (const edge of view.edges) {
      const existing = core.getElementById(edge.id);
      const label = edgeLabel(edge);
      if (existing.nonempty()) {
        if (existing.data("label") !== label) existing.data({ label });
        if (existing.hasClass("labelled") !== labelled) existing.toggleClass("labelled", labelled);
      } else {
        added.push(edge.id);
        fresh.push({
          group: "edges",
          data: { id: edge.id, source: edge.source, target: edge.target, label },
          classes: [edge.missing ? "missing" : "", labelled ? "labelled" : ""].filter(Boolean).join(" "),
        });
      }
    }
    if (fresh.length > 0) core.add(fresh);
  });
  const drawn = performance.now();
  emphasis.adopt(added);
  if (animate) {
    // A short settle from the expanded node to the new nodes' places.
    for (const id of grown) {
      const point = positions.get(id);
      if (point)
        core.getElementById(id).animate({ position: { ...point } }, { duration: 220, easing: "ease-out" });
    }
  }
  applySearch();
  refreshEmphasis();
  updateNodeTools();
  performance.measure("graph:draw-elements", { start: started, end: drawn });
  if (fit) fitView();
  else if (grown.length > 0) bringIntoView([...(growFrom ? [growFrom] : []), ...grown]);
}

/** Pan (and zoom out, if it must) so that `ids`, at their final places, are on screen. */
function bringIntoView(ids: readonly string[]): void {
  if (!cy) return;
  const points = ids.map((id) => positions.get(id)).filter((p): p is Point => p !== undefined);
  if (points.length === 0) return;
  const pad = { x: NODE_BOX.width / 2 + 16, y: NODE_BOX.height / 2 + 16 };
  const x1 = Math.min(...points.map((p) => p.x)) - pad.x;
  const x2 = Math.max(...points.map((p) => p.x)) + pad.x;
  const y1 = Math.min(...points.map((p) => p.y)) - pad.y;
  const y2 = Math.max(...points.map((p) => p.y)) + pad.y;
  const zoom = cy.zoom();
  const pan = cy.pan();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const visible =
    x1 * zoom + pan.x >= 0 &&
    y1 * zoom + pan.y >= 0 &&
    x2 * zoom + pan.x <= width &&
    y2 * zoom + pan.y <= height;
  if (visible) return;
  const fits = Math.min(zoom, width / (x2 - x1), height / (y2 - y1));
  const next = {
    zoom: fits,
    pan: { x: width / 2 - ((x1 + x2) / 2) * fits, y: height / 2 - ((y1 + y2) / 2) * fits },
  };
  autoFit = false;
  if (reducedMotion()) cy.viewport(next);
  else cy.animate(next, { duration: 220, easing: "ease-out" });
}

/** The view was fitted and the user has not panned or zoomed since: a resize fits it again. */
let autoFit = false;

function fitView(): void {
  if (!cy) return;
  autoFit = true;
  // From the laid-out positions, not Cytoscape's bounding box: that measures every label (a second at
  // 2,000 nodes). The box is padded for the labels under the nodes.
  const box = bounds(
    [...nodesById.keys()].map((id) => positions.get(id)).filter((p): p is Point => p !== undefined),
  );
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (box.width === 0 || width === 0 || height === 0) return;
  const padding = 30;
  // A small graph would be drawn huge: cap the zoom.
  const zoom = Math.max(
    cy.minZoom(),
    Math.min(1.25, (width - 2 * padding) / box.width, (height - 2 * padding) / (box.height + 16)),
  );
  cy.viewport({
    zoom,
    pan: {
      x: width / 2 - (box.x + box.width / 2) * zoom,
      y: height / 2 - (box.y + box.height / 2 + 8) * zoom,
    },
  });
}

let matches = new Set<string>();

/** Mark the nodes that match the search (by difference: a keystroke touches the matches only). */
function applySearch(): void {
  const next = searchNodes(view.nodes, searchText);
  if (cy) {
    const core = cy;
    core.batch(() => {
      for (const id of matches) if (!next.has(id)) core.getElementById(id).removeClass("match");
      for (const id of next) core.getElementById(id).addClass("match");
    });
  }
  matches = next;
  searchCount.textContent = searchText.trim() ? String(next.size) : "";
  updateStatus();
}

function showEmptyFocus(): boolean {
  if (mode !== "focus" || view.nodes.length > 0 || !model) return false;
  const total = model.nodes.length;
  const unknown = view.unknownFocus.length > 0 && focus.length > 0;
  showState(
    unknown ? "eye-closed" : "type-hierarchy",
    unknown
      ? "The focused object is not in this view: a filter hides it, or it is no longer in the catalogue."
      : total === 0
        ? "The catalogue has no objects yet."
        : "Open a Tide object in the editor, or search, to focus the graph on it.",
    [
      ...(unknown ? [{ label: "Clear the filters", run: clearFilters }] : []),
      ...(total > 0
        ? [
            {
              label: `Show the whole catalogue (${total} nodes)`,
              run: () => setMode("catalogue"),
              secondary: unknown,
            },
          ]
        : []),
      { label: "Find a detection…", run: () => channel.post("action", "search"), secondary: true },
    ],
  );
  renderDetails();
  return true;
}

// ----------------------------------------------------------------------------------------- selection

function inViewport(id: string): boolean {
  if (!cy) return true;
  const node = cy.getElementById(id);
  if (node.empty()) return true;
  const box = node.renderedBoundingBox();
  return box.x1 >= 0 && box.y1 >= 0 && box.x2 <= canvas.clientWidth && box.y2 <= canvas.clientHeight;
}

function centreOn(id: string, always: boolean): void {
  if (!cy || settings.list) return;
  const node = cy.getElementById(id);
  if (node.empty() || (!always && inViewport(id))) return;
  if (reducedMotion()) cy.center(node);
  else cy.animate({ center: { eles: node } }, { duration: 160 });
}

/**
 * Select `id`: the details pane, the emphasis and the history follow; nothing is laid out again. A node
 * of the model that is not drawn joins the view beside a drawn neighbour, when the filters allow it.
 */
function select(
  id: string,
  options: { center: boolean; record?: boolean; reveal?: boolean } = { center: true },
): void {
  if (!detailsIndex?.node(id)) return;
  if (!nodesById.has(id) && options.reveal !== false && model) {
    const node = detailsIndex.node(id);
    if (node && passesFilters(node, viewOptions())) {
      const anchor = [...modelIndex.neighbours(id)].find((other) => nodesById.has(other));
      overrides = {
        added: new Set([...overrides.added, id]),
        removed: new Set([...overrides.removed].filter((other) => other !== id)),
      };
      selected = id;
      render(anchor ? { growFrom: anchor } : {});
    }
  }
  selected = id;
  if (options.record !== false) history.visit(id);
  refreshEmphasis();
  renderDetails();
  updateHistoryButtons();
  updateNodeTools();
  if (options.center) centreOn(id, false);
  if (settings.list) markListSelection();
}

function clearSelection(): void {
  if (selected === undefined) return;
  selected = undefined;
  refreshEmphasis();
  renderDetails();
  updateNodeTools();
}

function hover(id: string | undefined): void {
  if (hovered === id) return;
  hovered = id;
  refreshEmphasis();
}

function updateHistoryButtons(): void {
  backButton.disabled = !history.canBack;
  forwardButton.disabled = !history.canForward;
}

function goBack(): void {
  const id = history.back();
  if (id) select(id, { center: true, record: false });
  updateHistoryButtons();
}

function goForward(): void {
  const id = history.forward();
  if (id) select(id, { center: true, record: false });
  updateHistoryButtons();
}

/** "+": the selected node's neighbours that are not drawn join the view beside it. */
function expand(id: string): void {
  if (!model) return;
  const viewSettings = viewOptions();
  const passes = (other: string): boolean => {
    const node = detailsIndex?.node(other);
    return node !== undefined && passesFilters(node, viewSettings);
  };
  const hidden = hiddenNeighbours(modelIndex, nodesById, id, passes);
  if (hidden.length === 0) return;
  const removed = new Set(overrides.removed);
  for (const other of hidden) removed.delete(other);
  overrides = { added: new Set([...overrides.added, ...hidden]), removed };
  render({ growFrom: id });
}

/** "−": the selected node's neighbours that link to nothing else drawn leave the view. */
function collapse(id: string): void {
  const gone = collapsibleNeighbours(viewIndex, id, new Set([...focus, id]));
  if (gone.length === 0) return;
  const added = new Set(overrides.added);
  for (const other of gone) added.delete(other);
  overrides = { added, removed: new Set([...overrides.removed, ...gone]) };
  render();
}

function expandable(id: string): number {
  const viewSettings = viewOptions();
  return hiddenNeighbours(modelIndex, nodesById, id, (other) => {
    const node = detailsIndex?.node(other);
    return node !== undefined && passesFilters(node, viewSettings);
  }).length;
}

/** The "+" and "−" beside the selected node: what they would do (on selection and redraw). */
function updateNodeTools(): void {
  const id = selected;
  if (!cy || !id || settings.list || canvas.hidden || cy.getElementById(id).empty()) {
    nodeTools.hidden = true;
    return;
  }
  const more = expandable(id);
  const fewer = collapsibleNeighbours(viewIndex, id, new Set([...focus, id])).length;
  expandButton.disabled = more === 0;
  collapseButton.disabled = fewer === 0;
  const moreLabel =
    more === 0 ? "No hidden neighbours" : `Show ${more} hidden neighbour${more === 1 ? "" : "s"} (+)`;
  expandButton.title = moreLabel;
  expandButton.setAttribute("aria-label", moreLabel);
  const text = expandButton.querySelector(".text") ?? expandButton.appendChild(h("span", { class: "text" }));
  text.textContent = more > 0 ? String(more) : "";
  placeNodeTools();
}

/** The "+" and "−" beside the selected node: where (on every pan and zoom, so no counting here). */
function placeNodeTools(): void {
  const id = selected;
  if (!cy || !id || settings.list || canvas.hidden || cy.getElementById(id).empty()) {
    nodeTools.hidden = true;
    return;
  }
  const box = cy.getElementById(id).renderedBoundingBox({ includeLabels: false });
  nodeTools.hidden = false;
  nodeTools.style.left = `${Math.round(box.x2 + 6)}px`;
  nodeTools.style.top = `${Math.round(box.y1 - 30)}px`;
}

expandButton.addEventListener("click", () => {
  if (selected) expand(selected);
});
collapseButton.addEventListener("click", () => {
  if (selected) collapse(selected);
});

// --------------------------------------------------------------------------------------- details pane

function nodeDetails(id: string | undefined): NodeDetails | undefined {
  return id ? detailsIndex?.details(id) : undefined;
}

let paneKey = "";
let previousPaneNode: string | undefined;

function renderDetails(): void {
  details.hidden = !settings.details;
  splitter.hidden = !settings.details;
  details.style.width = `${paneWidth()}px`;
  if (!settings.details) return;
  if (!model) {
    if (paneKey !== "skeleton") details.replaceChildren(...paneSkeleton());
    paneKey = "skeleton";
    return;
  }
  const found = nodeDetails(selected);
  const viewSettings = viewOptions();
  const hiddenBy =
    found && !nodesById.has(found.node.id) && !passesFilters(found.node, viewSettings)
      ? `${KIND_LABELS[found.node.kind]} is filtered out, or this is not a rule the platform and status filters keep.`
      : undefined;
  // Unchanged pane, unchanged DOM: a hover or a redraw must not move a keyboard user's place in it.
  const key = JSON.stringify([
    selected,
    found
      ? [found.outgoing, found.incoming].flat().map((g) => g.items.map((i) => [i.id, nodesById.has(i.id)]))
      : [],
    problems[selected ?? ""],
    hiddenBy,
    revision,
  ]);
  if (key === paneKey) return;
  paneKey = key;
  const hadFocus = details.contains(document.activeElement);
  const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.id;
  details.replaceChildren(
    ...paneContent(found, {
      drawn: (id) => nodesById.has(id),
      problems: selected ? problems[selected] : undefined,
      canOpen: Boolean(found?.node.filePath),
      canFocus: Boolean(found && !(mode === "focus" && focus.length === 1 && focus[0] === found.node.id)),
      ...(hiddenBy ? { hiddenBy } : {}),
    }),
  );
  if (hadFocus) {
    // The same node's details again: the same link; another node's: its name, read out first.
    const again =
      focusedId && found?.node.id === previousPaneNode
        ? details.querySelector<HTMLElement>(`a[data-id="${CSS_ESCAPE(focusedId)}"]`)
        : null;
    (again ?? details.querySelector<HTMLElement>("h2") ?? details).focus();
  }
  previousPaneNode = found?.node.id;
}

details.addEventListener("click", (event) => {
  const element = event.target as HTMLElement;
  const link = element.closest<HTMLElement>("a[data-id]");
  if (link) {
    event.preventDefault();
    const id = link.dataset.id ?? "";
    select(id, { center: true });
    return;
  }
  const action = element.closest<HTMLElement>("[data-action]")?.dataset.action;
  const node = nodeDetails(selected)?.node;
  if (!action || !node) return;
  if (action === "open") channel.post("open", node.id);
  else if (action === "copyUuid" && node.uuid) channel.post("copy", node.uuid);
  else if (action === "focus") focusOn([node.id]);
});
details.addEventListener("dblclick", (event) => {
  const link = (event.target as HTMLElement).closest<HTMLElement>("a[data-id]");
  if (!link) return;
  event.preventDefault();
  channel.post("open", link.dataset.id ?? "");
});
details.addEventListener("keydown", (event) => {
  const link = (event.target as HTMLElement).closest<HTMLElement>("a[data-id]");
  if (!link) return;
  if (event.key === "Enter") {
    event.preventDefault();
    channel.post("open", link.dataset.id ?? "");
  } else if (event.key === " ") {
    event.preventDefault();
    select(link.dataset.id ?? "", { center: true });
  } else if (opensMenu(event)) {
    event.preventDefault();
    const id = link.dataset.id ?? "";
    const rect = link.getBoundingClientRect();
    const base = main.getBoundingClientRect();
    showContextMenu(
      id,
      { x: Math.max(0, rect.left - base.left - 200), y: rect.bottom - base.top - 12 },
      link,
    );
  }
});

// Resizing the pane: drag the splitter, or Left/Right on it.
splitter.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  splitter.setPointerCapture(event.pointerId);
  splitter.classList.add("dragging");
  const startX = event.clientX;
  const startWidth = paneWidth();
  const move = (moved: PointerEvent): void => {
    setDetailsWidth(startWidth + (startX - moved.clientX));
  };
  const up = (): void => {
    splitter.classList.remove("dragging");
    splitter.removeEventListener("pointermove", move);
    splitter.removeEventListener("pointerup", up);
    save();
  };
  splitter.addEventListener("pointermove", move);
  splitter.addEventListener("pointerup", up);
});
splitter.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  setDetailsWidth(paneWidth() + (event.key === "ArrowLeft" ? 16 : -16));
  save();
});

/** The pane's width: the user's, else a third of the panel (a graph beside an editor is narrow). */
function paneWidth(): number {
  const max = Math.max(200, Math.min(800, root.clientWidth - 240));
  const wanted = settings.detailsWidth || Math.round(root.clientWidth * 0.34);
  return Math.min(max, Math.max(200, Math.min(settings.detailsWidth ? 800 : 340, wanted)));
}

function setDetailsWidth(width: number): void {
  settings.detailsWidth = Math.round(width);
  settings.detailsWidth = paneWidth();
  details.style.width = `${settings.detailsWidth}px`;
  splitter.setAttribute("aria-valuenow", String(settings.detailsWidth));
}

// The canvas follows its box (the pane opening, the panel resizing) without a new layout.
let resizeFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (!settings.detailsWidth) details.style.width = `${paneWidth()}px`;
    cy?.resize();
    // The panel opening beside the editor grows for a moment: keep a fitted view fitted.
    if (autoFit && !canvas.hidden) fitView();
    placeNodeTools();
  });
}).observe(main);
for (const event of ["wheel", "pointerdown"] as const)
  canvas.addEventListener(event, () => {
    autoFit = false;
  });

// --------------------------------------------------------------------------------------- overlays

function hideOverlays(): void {
  tooltip.hidden = true;
  contextMenu.hidden = true;
}

function place(element: HTMLElement, at: { x: number; y: number }): void {
  const bounds = main.getBoundingClientRect();
  element.hidden = false;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  element.style.left = `${Math.max(4, Math.min(at.x + 12, bounds.width - width - 4))}px`;
  element.style.top = `${Math.max(4, Math.min(at.y + 12, bounds.height - height - 4))}px`;
}

function showTooltip(id: string, at: { x: number; y: number }): void {
  const node = nodesById.get(id);
  if (!node || !contextMenu.hidden) return;
  const description = describe(node, problems);
  const counts = detailsIndex?.details(id);
  const out = counts?.outgoing.reduce((sum, g) => sum + g.items.length, 0) ?? 0;
  const incoming = counts?.incoming.reduce((sum, g) => sum + g.items.length, 0) ?? 0;
  tooltip.replaceChildren(
    ...[
      h("div", { class: "title", text: node.label }),
      h("div", { class: "row", text: `${KIND_LABELS[node.kind]} · ${out} out → · ← ${incoming} in` }),
      node.uuid ? h("div", { class: "row mono", text: node.uuid }) : undefined,
      description ? h("div", { class: "row", text: description }) : undefined,
      node.filePath ? h("div", { class: "row", text: "Click to select, double-click to open" }) : undefined,
    ].filter((child): child is HTMLDivElement => child !== undefined),
  );
  place(tooltip, at);
}

/** What gets the focus back when the menu closes with Escape: the list item, a pane link or the canvas. */
let menuOpener: HTMLElement | undefined;

function showContextMenu(id: string, at: { x: number; y: number }, opener?: HTMLElement): void {
  const node = detailsIndex?.node(id);
  if (!node) return;
  menuOpener = opener;
  tooltip.hidden = true;
  const item = (text: string, run: () => void): HTMLButtonElement => {
    const entry = h("button", { type: "button", role: "menuitem", text, tabindex: "-1" });
    entry.addEventListener("click", () => {
      contextMenu.hidden = true;
      run();
    });
    return entry;
  };
  const drawn = nodesById.has(id);
  const items = [
    node.filePath ? item("Open beside", () => channel.post("open", id)) : undefined,
    item("Focus on this", () => focusOn([id])),
    drawn && expandable(id) > 0 ? item("Expand neighbours (+)", () => expand(id)) : undefined,
    drawn && collapsibleNeighbours(viewIndex, id, new Set([...focus, id])).length > 0
      ? item("Collapse neighbours (−)", () => collapse(id))
      : undefined,
    ...nodeActions(node, availableActions).map((action) =>
      item(NODE_ACTION_LABELS[action], () => channel.post("nodeAction", { action, id })),
    ),
    node.uuid ? item("Copy UUID", () => channel.post("copy", node.uuid ?? "")) : undefined,
    item("Copy name", () => channel.post("copy", node.label)),
  ].filter((entry): entry is HTMLButtonElement => entry !== undefined);
  contextMenu.replaceChildren(...items);
  contextMenu.setAttribute("aria-label", node.label);
  place(contextMenu, at);
  items[0]?.focus();
}

contextMenu.addEventListener("keydown", (event) => {
  const items = [...contextMenu.querySelectorAll<HTMLButtonElement>("button")];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "Escape") {
    event.stopPropagation();
    contextMenu.hidden = true;
    // The opener, else (the list was redrawn meanwhile) the list's current item; the canvas is hidden
    // in View as list.
    const listItem = list.querySelector<HTMLElement>('[tabindex="0"]');
    (menuOpener?.isConnected ? menuOpener : settings.list && listItem ? listItem : canvas).focus();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
});

// ------------------------------------------------------------------------------------------- list

let listFocus = "";
const expanded = new Set<string>([...ALL_KINDS.map((kind) => listKey.group(kind))]);

/** The list's content as last drawn (see renderList). */
let listSignature = "";

function renderList(): void {
  stateBox.hidden = true;
  canvas.hidden = true;
  nodeTools.hidden = true;
  list.hidden = false;
  if (!detailsIndex) return;
  const groups: ListGroup[] = listGroups(view, problems, detailsIndex);
  const items: HTMLElement[] = [];
  // What the list shows, to leave the DOM (and a screen reader's place) alone when nothing changed.
  const shown: string[] = [];
  const treeitem = (
    key: string,
    level: number,
    label: (Node | string)[],
    text: string,
    description: string,
    children: (() => HTMLElement[]) | undefined,
    extra: Record<string, string> = {},
  ): HTMLLIElement => {
    const open = children !== undefined && expanded.has(key);
    const li = h("li", {
      role: "treeitem",
      "aria-level": String(level),
      tabindex: "-1",
      "data-key": key,
      ...(children ? { "aria-expanded": String(open) } : {}),
      ...extra,
    });
    li.append(
      h(
        "div",
        { class: "row" },
        h("span", {
          class: `twisty codicon ${children ? (open ? "codicon-chevron-down" : "codicon-chevron-right") : ""}`,
          "aria-hidden": "true",
        }),
        ...label,
        description ? h("span", { class: "desc", text: description }) : undefined,
      ),
    );
    shown.push([key, text, description, open, extra["aria-selected"] ?? ""].join("\u0000"));
    if (open && children) li.append(h("ul", { role: "group" }, ...children()));
    items.push(li);
    return li;
  };
  const glyph = (kind: NodeKind): HTMLSpanElement => {
    const visual = NODE_ICONS[kind];
    const element = icon(visual.codicon);
    element.style.color = `var(${themeVar(visual.themeColor)})`;
    return element;
  };
  const top = groups.map((group) =>
    treeitem(listKey.group(group.kind), 1, [glyph(group.kind), group.label], group.label, "", () =>
      group.nodes.map((entry) => {
        const { node } = entry;
        const problem = hasErrors(node, problems);
        const label = `${problem ? "✗ " : ""}${node.label}`;
        return treeitem(
          listKey.node(node.id),
          2,
          [glyph(node.kind), h("span", { text: label })],
          label,
          entry.description,
          entry.relations.length > 0
            ? () =>
                entry.relations.map((relation) =>
                  treeitem(
                    listKey.relation(node.id, relation),
                    3,
                    [
                      icon(relation.icon, relation.direction === "out" ? "out-color" : "in-color"),
                      relation.header,
                    ],
                    relation.header,
                    "",
                    () =>
                      relation.items.map((item, index) =>
                        treeitem(
                          listKey.link(node.id, relation, index),
                          4,
                          [
                            glyph(item.missing ? "missing" : item.kind),
                            h("span", { class: item.missing ? "missing" : "", text: item.label }),
                          ],
                          item.label,
                          [item.missing ? "missing" : "", nodesById.has(item.id) ? "" : "not drawn"]
                            .filter(Boolean)
                            .join(" · "),
                          undefined,
                          {
                            "data-target": item.id,
                            "aria-label": `${relation.header}: ${item.missing ? "missing reference " : ""}${item.label}`,
                          },
                        ),
                      ),
                  ),
                )
            : undefined,
          {
            "data-node": node.id,
            "aria-selected": String(node.id === selected || matches.has(node.id)),
            "aria-label": [node.label, KIND_LABELS[node.kind], problem ? "has errors" : "", entry.description]
              .filter(Boolean)
              .join(", "),
          },
        );
      }),
    ),
  );
  const signature = shown.join("\n");
  if (signature === listSignature && list.childElementCount > 0) return;
  listSignature = signature;
  // New data or problems redraw the list: the focused item keeps the focus (or the closest one left).
  const hadFocus = list.contains(document.activeElement);
  list.replaceChildren(...top);
  const kept = keptFocus(
    listFocus,
    items.map((item) => item.dataset.key ?? ""),
    (id) => nodesById.get(id)?.kind,
  );
  const current = items.find((item) => item.dataset.key === kept);
  if (!current) return;
  current.tabIndex = 0;
  listFocus = kept ?? "";
  if (hadFocus) current.focus();
}

function markListSelection(): void {
  for (const item of list.querySelectorAll<HTMLElement>("[data-node]"))
    item.setAttribute(
      "aria-selected",
      String(item.dataset.node === selected || matches.has(item.dataset.node ?? "")),
    );
}

function visibleItems(): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>('[role="treeitem"]')];
}

function moveTo(item: HTMLElement | undefined): void {
  if (!item) return;
  for (const other of list.querySelectorAll<HTMLElement>('[tabindex="0"]')) other.tabIndex = -1;
  item.tabIndex = 0;
  listFocus = item.dataset.key ?? "";
  item.focus();
}

function revealInList(id: string): void {
  const node = nodesById.get(id);
  if (!node) return;
  expanded.add(listKey.group(node.kind));
  listFocus = listKey.node(id);
  renderList();
  moveTo(list.querySelector<HTMLElement>(`[data-key="${CSS_ESCAPE(listFocus)}"]`) ?? undefined);
}

/** The node menu of a list item, below it: every action a right-click on the canvas offers. */
function showItemMenu(item: HTMLElement): boolean {
  const id = item.dataset.node ?? item.dataset.target;
  if (!id || !detailsIndex?.node(id)) return false;
  const rect = item.getBoundingClientRect();
  const base = main.getBoundingClientRect();
  // place() offsets by 12 px; this puts the menu at the item's bottom-left corner.
  showContextMenu(id, { x: rect.left - base.left - 12, y: rect.bottom - base.top - 12 }, item);
  return true;
}

/** A link item selects its node (adding it to the view when it is not drawn) and moves there. */
function followLink(target: string): void {
  select(target, { center: false });
  revealInList(target);
}

list.addEventListener("keydown", (event) => {
  const items = visibleItems();
  const current = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (!current) return;
  if (opensMenu(event)) {
    if (showItemMenu(current)) event.preventDefault();
    return;
  }
  const index = items.indexOf(current);
  const key = current.dataset.key ?? "";
  const expandableItem = current.hasAttribute("aria-expanded");
  const open = current.getAttribute("aria-expanded") === "true";
  const rerender = (focusKey: string): void => {
    listFocus = focusKey;
    renderList();
    moveTo(list.querySelector<HTMLElement>(`[data-key="${CSS_ESCAPE(focusKey)}"]`) ?? undefined);
  };
  switch (event.key) {
    case "ArrowDown":
      moveTo(items[index + 1]);
      break;
    case "ArrowUp":
      moveTo(items[index - 1]);
      break;
    case "Home":
      moveTo(items[0]);
      break;
    case "End":
      moveTo(items[items.length - 1]);
      break;
    case "ArrowRight":
      if (expandableItem && !open) {
        expanded.add(key);
        rerender(key);
      } else if (open) moveTo(items[index + 1]);
      break;
    case "ArrowLeft":
      if (open) {
        expanded.delete(key);
        rerender(key);
      } else {
        moveTo(current.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined);
      }
      break;
    case "Enter": {
      const linked = current.dataset.target;
      if (linked) channel.post("open", linked);
      else if (current.dataset.node) channel.post("open", current.dataset.node);
      else if (expandableItem) {
        if (open) expanded.delete(key);
        else expanded.add(key);
        rerender(key);
      }
      break;
    }
    case " ": {
      const linked = current.dataset.target;
      if (linked) followLink(linked);
      else if (current.dataset.node) select(current.dataset.node, { center: false });
      break;
    }
    default:
      return;
  }
  event.preventDefault();
});

list.addEventListener("focusin", (event) => {
  // Moving through the nodes selects them: the details pane follows.
  const item = (event.target as HTMLElement).closest<HTMLElement>("[data-node]");
  if (item?.dataset.node && item.dataset.node !== selected) select(item.dataset.node, { center: false });
});

list.addEventListener("click", (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (!item) return;
  const key = item.dataset.key ?? "";
  if (item.hasAttribute("aria-expanded") && (event.target as HTMLElement).classList.contains("twisty")) {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    listFocus = key;
    renderList();
  } else if (item.dataset.target) {
    followLink(item.dataset.target);
    return;
  }
  moveTo(list.querySelector<HTMLElement>(`[data-key="${CSS_ESCAPE(key)}"]`) ?? undefined);
});

list.addEventListener("contextmenu", (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (item && showItemMenu(item)) event.preventDefault();
});

list.addEventListener("dblclick", (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  const id = item?.dataset.node ?? item?.dataset.target;
  if (id) channel.post("open", id);
});

// ------------------------------------------------------------------------------------- state view

interface StateAction {
  readonly label: string;
  readonly run: () => void;
  readonly secondary?: boolean;
}

function showState(glyph: string, message: string, actions: readonly StateAction[] = []): void {
  canvas.hidden = true;
  list.hidden = true;
  nodeTools.hidden = true;
  hideOverlays();
  stateBox.hidden = false;
  stateBox.classList.remove("skeleton-state");
  const paragraph = h("p");
  paragraph.append(...richText(message));
  stateBox.replaceChildren(
    icon(glyph),
    paragraph,
    ...(actions.length > 0
      ? [
          h(
            "div",
            { class: "actions" },
            ...actions.map((action) => {
              const entry = h("button", {
                type: "button",
                text: action.label,
                ...(action.secondary ? { class: "secondary" } : {}),
              });
              entry.addEventListener("click", action.run);
              return entry;
            }),
          ),
        ]
      : []),
  );
}

function showLoading(): void {
  canvas.hidden = true;
  list.hidden = true;
  nodeTools.hidden = true;
  stateBox.hidden = false;
  stateBox.classList.add("skeleton-state");
  stateBox.replaceChildren(
    h(
      "div",
      { class: "skeleton-graph", "aria-hidden": "true" },
      ...Array.from({ length: 9 }, () => h("span")),
    ),
    h("p", { class: "visually-hidden", text: "Loading the catalogue…" }),
  );
  renderDetails();
}

/** `code` spans for backticked words, the rest as text. */
function richText(message: string): (HTMLElement | string)[] {
  return message.split("`").map((part, index) => (index % 2 ? h("code", { text: part }) : part));
}

function showData(next: GraphData): void {
  const actions: StateAction[] = [];
  if (next.status === "loading") {
    showLoading();
    statusLine.textContent = next.folder
      ? `${next.folder} · loading the catalogue…`
      : "Loading the catalogue…";
    return;
  }
  if (next.status === "unavailable") {
    if (next.reason === "needs-command" || next.reason === "no-runtime" || next.reason === "editor-only")
      actions.push({ label: "Switch Runtime…", run: () => channel.post("action", "switchRuntime") });
    if (next.reason === "untrusted")
      actions.push({ label: "Trust this folder…", run: () => channel.post("action", "manageTrust") });
    if (next.reason === "needs-command")
      actions.push({
        label: "Find a detection…",
        run: () => channel.post("action", "search"),
        secondary: true,
      });
  } else if (next.status === "error") {
    actions.push(
      { label: "Retry", run: () => channel.post("action", "refresh") },
      { label: "Show output", run: () => channel.post("action", "showOutput"), secondary: true },
    );
  }
  showState(next.status === "error" ? "error" : "info", next.message ?? "Nothing to show yet.", actions);
  renderDetails();
  statusLine.textContent = next.folder ? next.folder : "";
}

// ---------------------------------------------------------------------------------------- toolbar

function updateToolbar(): void {
  const ready = model !== undefined;
  for (const kind of Object.keys(modeButtons) as GraphMode[]) {
    modeButtons[kind].setAttribute("aria-pressed", String(mode === kind));
    modeButtons[kind].disabled = !ready;
  }
  depthSelect.value = String(settings.depth);
  depthSelect.disabled = !ready || mode !== "focus";
  problemsBox.checked = settings.problemsOnly;
  listButton.setAttribute("aria-pressed", String(settings.list));
  const listLabel = settings.list ? "View as graph" : "View as list";
  listButton.title = listLabel;
  listButton.setAttribute("aria-label", listLabel);
  detailsButton.setAttribute("aria-pressed", String(settings.details));
  const detailsLabel = settings.details ? "Hide the details pane" : "Show the details pane";
  detailsButton.title = detailsLabel;
  detailsButton.setAttribute("aria-label", detailsLabel);
  for (const control of [fitButton, relayoutButton]) control.disabled = !ready || settings.list;
  listButton.disabled = !ready;
  searchBox.disabled = !ready;
  kindsBox.toggleAttribute("aria-disabled", mode === "chains");
  if (model) {
    const known = facets(model);
    if (platformSelect.options.length !== known.platforms.length + 1)
      fillSelect(platformSelect, "All platforms", known.platforms, platform);
    if (statusSelect.options.length !== known.statuses.length + 1)
      fillSelect(statusSelect, "All statuses", known.statuses, status);
  }
  const active =
    (platform ? 1 : 0) +
    (status ? 1 : 0) +
    (settings.problemsOnly ? 1 : 0) +
    OBJECT_KINDS.filter((kind) => !settings.kinds.includes(kind)).length +
    OPTIONAL_KINDS.filter((kind) => settings.kinds.includes(kind)).length;
  filtersBadge.hidden = active === 0;
  filtersBadge.textContent = String(active);
  filtersSummary.setAttribute("aria-label", active ? `Filters, ${active} changed` : "Filters");
  updateTarget();
  updateHistoryButtons();
}

/** The object the graph is on, and whether it follows the editor or is pinned there. */
function updateTarget(): void {
  // What the graph follows (or is pinned to): the editor's object, whatever the mode.
  const id = focus[0];
  const node = id ? detailsIndex?.node(id) : undefined;
  const more = mode === "focus" && focus.length > 1 ? ` +${focus.length - 1}` : "";
  const name = node
    ? `${node.label}${more}`
    : mode === "catalogue"
      ? "Catalogue"
      : mode === "chains"
        ? "Threat chains"
        : "—";
  targetName.textContent = name;
  targetName.title = node ? `${node.label}${node.path ? `\n${node.path}` : ""}\nClick to select it.` : name;
  const visual = node ? NODE_ICONS[node.kind] : undefined;
  targetIcon.className = `codicon codicon-${visual?.codicon ?? "type-hierarchy"}`;
  targetState.textContent = following ? "Following" : "Pinned";
  pinButton.setAttribute("aria-pressed", String(!following));
  pinButton
    .querySelector(".codicon")
    ?.setAttribute("class", `codicon codicon-${following ? "pin" : "pinned"}`);
  const pinLabel = following
    ? "Pin: stay on this object instead of following the editor"
    : "Unpin: follow the active editor again";
  pinButton.title = pinLabel;
  pinButton.setAttribute("aria-label", pinLabel);
}

function updateStatus(): void {
  if (!data || !model || !mode) return;
  const parts: string[] = [];
  if (mode === "focus") parts.push(`${settings.depth} ${settings.depth === 1 ? "hop" : "hops"}`);
  parts.push(`${view.nodes.length} nodes, ${view.edges.length} edges`);
  if (overrides.added.size + overrides.removed.size > 0)
    parts.push(`${overrides.added.size} expanded, ${overrides.removed.size} collapsed`);
  if (searchText.trim()) parts.push(matches.size === 1 ? "1 match" : `${matches.size} matches`);
  if (data.refreshing) parts.push("refreshing…");
  statusLine.replaceChildren(parts.join(" · "));
  if (data.message) statusLine.append(h("span", { class: "warning", text: data.message }));
  progress.classList.toggle("active", data.refreshing || data.status === "loading");
}

function setMode(next: GraphMode): void {
  mode = next;
  renderLegend();
  render({ fit: true });
}

function focusOn(ids: string[]): void {
  focus = ids;
  mode = "focus";
  render({ fit: true });
  if (ids[0]) select(ids[0], { center: false });
  if (settings.list && ids[0]) revealInList(ids[0]);
}

function clearFilters(): void {
  platform = "";
  status = "";
  settings.problemsOnly = false;
  settings.kinds = [...new Set([...settings.kinds, ...OBJECT_KINDS])];
  platformSelect.value = "";
  statusSelect.value = "";
  save();
  renderKinds();
  renderLegend();
  render({ fit: true });
}

for (const kind of Object.keys(modeButtons) as GraphMode[])
  modeButtons[kind].addEventListener("click", () => setMode(kind));
depthSelect.addEventListener("change", () => {
  settings.depth = clampDepth(Number(depthSelect.value));
  save();
  render({ fit: true });
});
platformSelect.addEventListener("change", () => {
  platform = platformSelect.value;
  render();
});
statusSelect.addEventListener("change", () => {
  status = statusSelect.value;
  render();
});
problemsBox.addEventListener("change", () => {
  settings.problemsOnly = problemsBox.checked;
  save();
  render({ fit: true });
});
clearFiltersButton.addEventListener("click", () => {
  filtersMenu.open = false;
  clearFilters();
});
pinButton.addEventListener("click", () => {
  following = !following;
  updateTarget();
  channel.post("follow", following);
});
targetName.addEventListener("click", () => {
  const id = focus[0];
  if (id) select(id, { center: true });
});
targetName.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  targetName.click();
});
backButton.addEventListener("click", goBack);
forwardButton.addEventListener("click", goForward);

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let matchCursor = -1;
searchBox.addEventListener("input", () => {
  if (searchTimer) clearTimeout(searchTimer);
  // A keystroke in a 5,000-node view: mark the matches once typing pauses.
  searchTimer = setTimeout(() => {
    searchText = searchBox.value;
    matchCursor = -1;
    if (settings.list) {
      matches = searchNodes(view.nodes, searchText);
      renderList();
      updateStatus();
    } else applySearch();
  }, 80);
});
searchBox.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && searchBox.value) {
    event.preventDefault();
    event.stopPropagation();
    searchBox.value = "";
    searchText = "";
    applySearch();
    return;
  }
  if (event.key !== "Enter") return;
  event.preventDefault();
  searchText = searchBox.value;
  applySearch();
  // Enter: the next match in the view; with none, the first in the catalogue (the view focuses on it).
  const inView = [...matches].sort((a, b) =>
    (nodesById.get(a)?.label ?? a).localeCompare(nodesById.get(b)?.label ?? b),
  );
  if (inView.length > 0) {
    matchCursor = (matchCursor + (event.shiftKey ? -1 : 1) + inView.length) % inView.length;
    const id = inView[matchCursor] as string;
    if (settings.list) revealInList(id);
    select(id, { center: true });
    if (cy && !settings.list) centreOn(id, true);
    return;
  }
  const first = model ? [...searchNodes(model.nodes, searchText)][0] : undefined;
  if (first) focusOn([first]);
});
fitButton.addEventListener("click", fitView);
relayoutButton.addEventListener("click", () => render({ fit: true, relayout: true }));
listButton.addEventListener("click", () => {
  settings.list = !settings.list;
  save();
  render({ fit: true });
  if (settings.list) {
    if (selected) revealInList(selected);
    else moveTo(list.querySelector<HTMLElement>('[tabindex="0"]') ?? undefined);
  }
});
detailsButton.addEventListener("click", () => {
  settings.details = !settings.details;
  save();
  updateToolbar();
  paneKey = "";
  renderDetails();
});
exportPopup.addEventListener("click", (event) => {
  const format = (event.target as HTMLElement).closest<HTMLElement>("[data-format]")?.dataset.format;
  exportMenu.open = false;
  if (format === "svg" || format === "png" || format === "mermaid") exportGraph(format);
});
for (const menu of [filtersMenu, exportMenu]) {
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      event.stopPropagation();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  });
}
document.addEventListener("click", (event) => {
  // A click elsewhere closes the open menus, as VS Code's own do.
  for (const menu of [filtersMenu, exportMenu])
    if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
});

canvas.addEventListener("keydown", (event) => {
  if (!cy) return;
  const direction = arrowDirection(event.key);
  if (direction && !event.altKey) {
    moveSelection(direction);
  } else if (event.key === "+" || event.key === "=") {
    if (selected && nodesById.has(selected)) expand(selected);
    else {
      autoFit = false;
      cy.zoom({ level: cy.zoom() * 1.25, renderedPosition: center() });
    }
  } else if (event.key === "-" || event.key === "_") {
    if (selected && nodesById.has(selected)) collapse(selected);
    else {
      autoFit = false;
      cy.zoom({ level: cy.zoom() / 1.25, renderedPosition: center() });
    }
  } else if (event.key === "0") fitView();
  else if (event.key === "Enter") {
    if (selected) channel.post("open", selected);
  } else if (event.key === "Escape") {
    if (!contextMenu.hidden || !tooltip.hidden) hideOverlays();
    else clearSelection();
  } else if (opensMenu(event)) {
    if (!selected || cy.getElementById(selected).empty()) return;
    showContextMenu(selected, cy.getElementById(selected).renderedPosition(), canvas);
  } else return;
  event.preventDefault();
});

canvas.addEventListener("focus", () => {
  // Tabbing in selects something to start from: the focus, else the first node.
  if (!canvas.matches(":focus-visible") || (selected && nodesById.has(selected))) return;
  const start = focus.find((id) => nodesById.has(id)) ?? view.nodes[0]?.id;
  if (start) select(start, { center: true });
});

/** The arrow keys: to the neighbour that way, else the nearest node that way. */
function moveSelection(direction: ArrowDirection): void {
  if (!cy) return;
  if (!selected || cy.getElementById(selected).empty()) {
    const start = focus.find((id) => nodesById.has(id)) ?? view.nodes[0]?.id;
    if (start) select(start, { center: true });
    return;
  }
  const from = cy.getElementById(selected).position();
  const point = (id: string): readonly [string, Point] | undefined => {
    const node = cy?.getElementById(id);
    return node?.nonempty() ? [id, { ...node.position() }] : undefined;
  };
  const neighbours = [...viewIndex.neighbours(selected)].map(point).filter((p) => p !== undefined);
  const everyone = view.nodes
    .filter((node) => node.id !== selected)
    .map((node) => point(node.id))
    .filter((p) => p !== undefined);
  const next = nodeInDirection({ ...from }, direction, neighbours, everyone);
  if (next) select(next, { center: true });
}

window.addEventListener("keydown", (event) => {
  if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    if (event.key === "ArrowLeft") goBack();
    else goForward();
    return;
  }
  if (event.key === "Escape") hideOverlays();
  if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
    event.preventDefault();
    searchBox.focus();
  }
});

function center(): { x: number; y: number } {
  return { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
}

function exportGraph(format: ExportFormat): void {
  if (view.nodes.length === 0) return;
  if (format === "mermaid") {
    channel.post("export", { format, data: toMermaid(view.nodes, view.edges) });
    return;
  }
  const colors = palette();
  if (format === "png") {
    if (settings.list) drawCanvas(true, [], undefined);
    const core = ensureCanvas(view.nodes.length > HUGE_LAYOUT);
    const png = core.png({
      output: "base64",
      full: true,
      scale: 2,
      bg: colors.background,
      maxWidth: 16000,
      maxHeight: 16000,
    });
    channel.post("export", { format, data: png });
    if (settings.list) renderList();
    return;
  }
  const current = new Map(positions);
  cy?.nodes().forEach((node) => {
    current.set(node.id(), { ...node.position() });
  });
  channel.post("export", {
    format,
    data: toSvg(
      { nodes: view.nodes, edges: view.edges, positions: current, errors: nodeErrors() },
      colors,
      `opentide graph: ${data?.folder ?? ""}`,
    ),
  });
}

// ----------------------------------------------------------------------------------------- host

function setModel(next: GraphModel): void {
  model = next;
  modelIndex = new Incidence(next.edges);
  detailsIndex = new DetailsIndex(next);
}

channel.on("data", (next) => {
  data = next;
  if (next.status !== "ready") {
    model = undefined;
    revision = undefined;
    detailsIndex = undefined;
    updateToolbar();
    showData(next);
    progress.classList.toggle("active", next.refreshing || next.status === "loading");
    return;
  }
  const first = !model;
  if (!next.model && !next.patch && model && revision === next.revision) {
    // The same model (a refresh started or ended): the status line only.
    updateStatus();
    return;
  }
  if (next.model) {
    setModel(next.model);
  } else if (next.patch) {
    if (!model || revision !== next.patch.from) {
      // Lost track (a reload, a dropped message): ask for the whole model.
      channel.post("resync", undefined);
      return;
    }
    setModel(applyPatch(model, next.patch));
  } else if (!model) {
    channel.post("resync", undefined);
    return;
  }
  revision = next.revision;
  if (first && !mode) mode = initialMode(next.model ?? (model as GraphModel), focus.length > 0);
  if (first) renderLegend();
  render({ fit: first });
});

/** Other features' node actions this window has (validate, run query, preview deploy, new …). */
let availableActions: readonly NodeAction[] = [];
channel.on("actions", (next) => {
  availableActions = next;
});

channel.on("follow", (state) => {
  following = state.following;
  updateTarget();
});

channel.on("problems", (next) => {
  problems = next;
  if (model) render();
});

channel.on("focus", (request) => {
  const ids = [...request.ids];
  if (!model) {
    focus = ids;
    if (request.explicit || !mode) mode = request.mode ?? "focus";
    selected = ids[0];
    return;
  }
  const id = ids[0];
  // Following the editor to what is selected already (a double-click opened it): nothing to redo.
  if (!request.explicit && id && id === selected && nodesById.has(id)) {
    centreOn(id, false);
    return;
  }
  if (!request.explicit && mode !== "focus") {
    // Following the editor in the catalogue: select and centre it, keep the view.
    focus = ids;
    if (id) select(id, { center: true });
    updateTarget();
    return;
  }
  focus = ids;
  mode = request.mode ?? "focus";
  renderLegend();
  render({ fit: true });
  if (id) select(id, { center: false });
  if (settings.list && id) revealInList(id);
});

new MutationObserver(() => {
  if (cy) cy.style(stylesheet(cyLarge));
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

renderKinds();
renderLegend();
updateToolbar();
details.style.width = `${paneWidth()}px`;
showLoading();
progress.classList.add("active");
channel.post("ready", undefined);
