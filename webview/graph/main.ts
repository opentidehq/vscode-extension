// The graph webview (SPEC §10.1): Cytoscape draws, dagre lays out (src/features/graph/layout.ts), and
// "View as list" shows the same nodes and edges as a keyboard tree. Every action goes to the host.
import cytoscape from "cytoscape";
import { NODE_ACTION_LABELS, type NodeAction, nodeActions } from "../../src/features/graph/actions";
import { canvasColor } from "../../src/features/graph/colors";
import { type ExportPalette, KIND_SHAPES, toMermaid, toSvg } from "../../src/features/graph/export";
import { layout, type Point, stabilize } from "../../src/features/graph/layout";
import { describe, keptFocus, type ListGroup, listGroups, opensMenu } from "../../src/features/graph/list";
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
  searchNodes,
} from "../../src/features/graph/view";
import { createChannel, vscodeApi } from "../shared/channel";
import { CSS } from "./styles";

// ---------------------------------------------------------------------------------------------- setup

const scriptNonce = (document.currentScript as HTMLScriptElement | null)?.nonce ?? "";
const style = document.createElement("style");
style.nonce = scriptNonce;
style.textContent = CSS;
document.head.append(style);

const channel = createChannel<GraphProtocol>(webviewValidators);

interface Persisted {
  depth: number;
  kinds: NodeKind[];
  follow: boolean;
  list: boolean;
  problemsOnly: boolean;
}

const DEFAULTS: Persisted = {
  // One hop plus the chain the focus serves: a rule shows its objective and threat.
  depth: 1,
  kinds: [...OBJECT_KINDS],
  follow: true,
  list: false,
  problemsOnly: false,
};

function restore(): Persisted {
  const saved = vscodeApi().getState() as Partial<Persisted> | undefined;
  return {
    depth: clampDepth(typeof saved?.depth === "number" ? saved.depth : DEFAULTS.depth),
    kinds: Array.isArray(saved?.kinds)
      ? saved.kinds.filter((kind): kind is NodeKind => (ALL_KINDS as readonly string[]).includes(kind))
      : DEFAULTS.kinds,
    follow: typeof saved?.follow === "boolean" ? saved.follow : DEFAULTS.follow,
    list: typeof saved?.list === "boolean" ? saved.list : DEFAULTS.list,
    problemsOnly: typeof saved?.problemsOnly === "boolean" ? saved.problemsOnly : DEFAULTS.problemsOnly,
  };
}

const settings = restore();
const save = (): void => vscodeApi().setState(settings);

let data: GraphData | undefined;
let model: GraphModel | undefined;
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
let nodesById = new Map<string, GraphNode>();

// -------------------------------------------------------------------------------------------- DOM

type Child = Node | string | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | boolean>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "text") element.textContent = String(value);
    else element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

/** The children that exist. */
function present(...children: (HTMLElement | undefined)[]): HTMLElement[] {
  return children.filter((child): child is HTMLElement => child !== undefined);
}

const root = document.getElementById("root") ?? document.body;
root.removeAttribute("role");

const modeSelect = h(
  "select",
  { "aria-label": "Mode" },
  h("option", { value: "focus", text: "Focus" }),
  h("option", { value: "catalogue", text: "Catalogue" }),
  h("option", { value: "chains", text: "Threat chains" }),
);
const depthSelect = h(
  "select",
  { "aria-label": "Depth around the focus" },
  h("option", { value: "1", text: "1 hop" }),
  h("option", { value: "2", text: "2 hops" }),
  h("option", { value: "3", text: "3 hops" }),
);
const kindsPopup = h("div", { class: "popup", role: "group", "aria-label": "Kinds of node to show" });
const kindsMenu = h("details", { class: "menu" }, h("summary", { text: "Kinds" }), kindsPopup);
const platformSelect = h("select", { "aria-label": "Platform" });
const statusSelect = h("select", { "aria-label": "Status" });
const problemsBox = h("input", { type: "checkbox" });
const followBox = h("input", { type: "checkbox" });
const searchBox = h("input", {
  type: "search",
  placeholder: "Search the graph",
  "aria-label": "Search the graph: name, UUID, path or technique",
});
const button = (text: string, label: string, extra: Record<string, string> = {}): HTMLButtonElement =>
  h("button", { class: "secondary", type: "button", text, "aria-label": label, title: label, ...extra });
const zoomOut = button("−", "Zoom out");
const zoomIn = button("+", "Zoom in");
const fitButton = button("Fit", "Fit the graph to the panel");
const relayoutButton = button("Re-layout", "Lay the graph out again");
const listButton = button("View as list", "View as list", { "aria-pressed": "false" });
const exportPopup = h(
  "div",
  { class: "popup", role: "menu" },
  button("SVG…", "Export as SVG", { role: "menuitem", "data-format": "svg" }),
  button("PNG…", "Export as PNG", { role: "menuitem", "data-format": "png" }),
  button("Mermaid…", "Export as Mermaid", { role: "menuitem", "data-format": "mermaid" }),
);
const exportMenu = h("details", { class: "menu right" }, h("summary", { text: "Export" }), exportPopup);

const toolbar = h(
  "div",
  { class: "toolbar", role: "toolbar", "aria-label": "Graph" },
  h("span", { class: "group" }, modeSelect, depthSelect),
  kindsMenu,
  platformSelect,
  statusSelect,
  h("label", {}, problemsBox, "Problems only"),
  h("label", { title: "Focus the object open in the editor" }, followBox, "Follow editor"),
  searchBox,
  h("span", { class: "spacer" }),
  h(
    "span",
    { class: "group", role: "group", "aria-label": "Zoom" },
    zoomOut,
    zoomIn,
    fitButton,
    relayoutButton,
  ),
  exportMenu,
  listButton,
);
const statusLine = h("div", { class: "status", role: "status", "aria-live": "polite" });
const canvas = h("div", {
  id: "canvas",
  tabindex: "0",
  role: "img",
  "aria-label": "Graph. Keys: plus and minus zoom, 0 fits. Use View as list to move between nodes.",
});
const list = h("ul", { id: "list", role: "tree", "aria-label": "Graph as a list", hidden: true });
const stateBox = h("div", { class: "state", hidden: true });
const tooltip = h("div", { class: "tooltip", role: "tooltip", hidden: true });
const contextMenu = h("div", { class: "context-menu", role: "menu", hidden: true });
const main = h("div", { class: "main" }, canvas, list, stateBox, tooltip, contextMenu);
const legend = h("div", { class: "legend", "aria-label": "Legend" });
root.append(toolbar, statusLine, main, legend);

const GLYPHS: Readonly<Record<NodeKind, string>> = {
  threat: "◆",
  objective: "●",
  signal: "▲",
  rule: "▬",
  technique: "■",
  actor: "⬢",
  logsource: "◉",
  platform: "⯃",
  missing: "⬚",
};

function renderLegend(): void {
  legend.replaceChildren(
    ...ALL_KINDS.filter((kind) => kind === "missing" || settings.kinds.includes(kind)).map((kind) =>
      h(
        "span",
        {},
        h("span", { class: `glyph kind-${kind}`, "aria-hidden": "true", text: GLYPHS[kind] }),
        KIND_LABELS[kind],
      ),
    ),
    h("span", {}, h("span", { class: "glyph error", "aria-hidden": "true", text: "✗" }), "has errors"),
    h(
      "span",
      {},
      h("span", { class: "glyph error", "aria-hidden": "true", text: "┄" }),
      "dangling reference",
    ),
  );
}

function renderKinds(): void {
  kindsPopup.replaceChildren(
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
      return h(
        "label",
        {},
        box,
        h("span", { class: `kind-${kind}`, "aria-hidden": "true", text: GLYPHS[kind] }),
        KIND_LABELS[kind],
      );
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

const KIND_VARS: Readonly<Record<NodeKind, string>> = {
  threat: "--vscode-charts-red",
  objective: "--vscode-charts-blue",
  signal: "--vscode-charts-purple",
  rule: "--vscode-charts-green",
  technique: "--vscode-charts-orange",
  actor: "--vscode-charts-yellow",
  logsource: "--vscode-terminal-ansiCyan",
  platform: "--vscode-descriptionForeground",
  missing: "--vscode-errorForeground",
};

function palette(): ExportPalette & { focus: string; match: string; muted: string } {
  const color = (name: string, fallback: string): string => canvasColor(cssVar(name), fallback).color;
  const foreground = color("--vscode-editor-foreground", color("--vscode-foreground", "#888888"));
  const kinds = Object.fromEntries(
    ALL_KINDS.map((kind) => [kind, color(KIND_VARS[kind], foreground)]),
  ) as Record<NodeKind, string>;
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
  };
}

function stylesheet(large: boolean): cytoscape.StylesheetJson {
  const colors = palette();
  const contrast = cssVar("--vscode-contrastBorder");
  const border = contrast ? canvasColor(contrast, colors.foreground).color : colors.background;
  const sheet: cytoscape.StylesheetJson = [
    {
      selector: "node",
      style: {
        width: 22,
        height: 22,
        "background-color": colors.foreground,
        "border-width": contrast ? 2 : 1,
        "border-color": border,
        label: "data(display)",
        color: colors.foreground,
        "font-family": colors.font,
        "font-size": 11,
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 4,
        "text-wrap": "ellipsis",
        "text-max-width": "160px",
        "min-zoomed-font-size": 7,
      },
    },
    ...ALL_KINDS.map((kind) => ({
      selector: `node[kind = "${kind}"]`,
      style: { shape: KIND_SHAPES[kind] as cytoscape.Css.NodeShape, "background-color": colors.kinds[kind] },
    })),
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
    {
      selector: "node.focus",
      style: { "font-weight": "bold", "border-width": 3, "border-color": colors.focus },
    },
    { selector: "node:selected", style: { "border-width": 3, "border-color": colors.focus } },
    { selector: "node.match", style: { "border-width": 4, "border-color": colors.match } },
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
        "font-size": 9,
        color: colors.muted,
        "min-zoomed-font-size": 9,
        "text-rotation": "autorotate",
      },
    },
    { selector: "edge.labelled", style: { label: "data(label)" } },
    {
      selector: "edge.missing",
      style: { "line-style": "dashed", "line-color": colors.error, "target-arrow-color": colors.error },
    },
    { selector: ".faded", style: { opacity: 0.25 } },
  ];
  return sheet;
}

// -------------------------------------------------------------------------------------------- canvas

function ensureCanvas(): cytoscape.Core {
  if (cy) return cy;
  const core = cytoscape({
    container: canvas,
    style: stylesheet(false),
    layout: { name: "preset" },
    minZoom: 0.05,
    maxZoom: 3,
    boxSelectionEnabled: false,
    selectionType: "single",
  });
  core.on("dbltap", "node", (event) => {
    hideOverlays();
    channel.post("open", event.target.id());
  });
  core.on("cxttap", "node", (event) => showContextMenu(event.target.id(), event.renderedPosition));
  core.on("tap", (event) => {
    if (event.target === core) hideOverlays();
  });
  core.on("mouseover", "node", (event) => showTooltip(event.target.id(), event.renderedPosition));
  core.on("mouseout", "node", () => {
    tooltip.hidden = true;
  });
  core.on("dragfree", "node", (event) => {
    const node = event.target as cytoscape.NodeSingular;
    positions.set(node.id(), { ...node.position() });
  });
  core.on("viewport", () => {
    tooltip.hidden = true;
  });
  cy = core;
  return core;
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

function render(options: { fit?: boolean } = {}): void {
  if (!model || !mode) return;
  const started = performance.now();
  view = computeView(model, problems, {
    mode,
    focus,
    depth: settings.depth,
    kinds: new Set(settings.kinds),
    platforms: new Set(platform ? [platform] : []),
    statuses: new Set(status ? [status.toLowerCase()] : []),
    problemsOnly: settings.problemsOnly,
  });
  nodesById = new Map(view.nodes.map((node) => [node.id, node]));
  const key = viewKey();
  const ids = `${view.nodes.map((n) => n.id).join("\n")}|${view.edges.map((e) => e.id).join("\n")}`;
  const sameView = key === lastKey;
  if (!(sameView && ids === lastIds)) {
    const fresh = layout(view.nodes, view.edges);
    positions = sameView ? stabilize(positions, fresh) : fresh;
  }
  const laidOut = performance.now();
  const changed = !sameView || options.fit === true;
  lastKey = key;
  lastIds = ids;

  updateToolbar();
  if (showEmptyFocus()) return;
  if (settings.list) renderList();
  else drawCanvas(changed);
  const done = performance.now();
  updateStatus();
  channel.post(
    "log",
    `${mode} view: ${view.nodes.length} nodes, ${view.edges.length} edges; layout ${Math.round(laidOut - started)} ms, draw ${Math.round(done - laidOut)} ms`,
  );
}

function drawCanvas(fit: boolean): void {
  stateBox.hidden = true;
  toolbar.hidden = false;
  legend.hidden = false;
  list.hidden = true;
  canvas.hidden = false;
  const core = ensureCanvas();
  core.resize();
  const large = view.edges.length > 600;
  const errors = nodeErrors();
  const focusSet = new Set(focus);
  const labelled = view.edges.length <= 300;
  core.batch(() => {
    const wanted = new Set([...view.nodes.map((n) => n.id), ...view.edges.map((e) => e.id)]);
    core.elements().forEach((element) => {
      if (!wanted.has(element.id())) element.remove();
    });
    for (const node of view.nodes) {
      const position = positions.get(node.id) ?? { x: 0, y: 0 };
      const display = `${errors.has(node.id) && node.kind !== "missing" ? "✗ " : ""}${node.label}`;
      const existing = core.getElementById(node.id);
      if (existing.nonempty()) {
        existing.data({ display, kind: node.kind });
        existing.position(position);
      } else {
        core.add({
          group: "nodes",
          data: { id: node.id, display, kind: node.kind },
          position: { ...position },
        });
      }
      const element = core.getElementById(node.id);
      element.toggleClass("error", errors.has(node.id) && node.kind !== "missing");
      element.toggleClass("focus", mode === "focus" && focusSet.has(node.id));
    }
    for (const edge of view.edges) {
      const existing = core.getElementById(edge.id);
      const label = edgeLabel(edge);
      if (existing.nonempty()) existing.data({ label });
      else
        core.add({
          group: "edges",
          data: { id: edge.id, source: edge.source, target: edge.target, label },
          classes: edge.missing ? "missing" : "",
        });
      core.getElementById(edge.id).toggleClass("labelled", labelled);
    }
  });
  core.style(stylesheet(large));
  applySearch();
  if (fit) fitView();
}

function fitView(): void {
  if (!cy) return;
  cy.fit(undefined, 30);
  // A small graph would be drawn huge: cap the zoom and keep it centred.
  if (cy.zoom() > 1.25) {
    cy.zoom(1.25);
    cy.center();
  }
}

function applySearch(): void {
  const matches = searchNodes(view.nodes, searchText);
  if (cy) {
    const core = cy;
    core.batch(() => {
      core.nodes().forEach((node) => {
        node.toggleClass("match", matches.has(node.id()));
        node.toggleClass("faded", searchText.trim() !== "" && !matches.has(node.id()));
      });
      core.edges().forEach((edge) => {
        edge.toggleClass("faded", searchText.trim() !== "");
      });
    });
  }
  updateStatus();
}

function showEmptyFocus(): boolean {
  if (mode !== "focus" || view.nodes.length > 0 || !model) return false;
  const total = model.nodes.length;
  const unknown = view.unknownFocus.length > 0 && focus.length > 0;
  showState(
    unknown
      ? "The focused object is not in this view: a filter hides it, or it is no longer in the catalogue."
      : total === 0
        ? "The catalogue has no objects yet."
        : "Open a Tide object in the editor, or search, to focus the graph on it.",
    [
      ...(total > 0
        ? [
            {
              label: `Show the whole catalogue (${total} nodes)`,
              run: () => setMode("catalogue"),
            },
          ]
        : []),
      ...(unknown ? [{ label: "Clear the filters", run: clearFilters }] : []),
      { label: "Find a detection…", run: () => channel.post("action", "search"), secondary: true },
    ],
  );
  return true;
}

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
  tooltip.replaceChildren(
    ...present(
      h("div", { class: "title", text: node.label }),
      h("div", { class: "row", text: KIND_LABELS[node.kind] }),
      node.uuid ? h("div", { class: "row mono", text: node.uuid }) : undefined,
      description ? h("div", { class: "row", text: description }) : undefined,
      node.filePath ? h("div", { class: "row", text: "Double-click to open" }) : undefined,
    ),
  );
  place(tooltip, at);
}

/** What gets the focus back when the menu closes with Escape: the list item or the canvas. */
let menuOpener: HTMLElement | undefined;

function showContextMenu(id: string, at: { x: number; y: number }, opener?: HTMLElement): void {
  const node = nodesById.get(id);
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
  const items = [
    node.filePath ? item("Open", () => channel.post("open", id)) : undefined,
    item("Focus on this", () => focusOn([id])),
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
const expanded = new Set<string>(ALL_KINDS.map((kind) => `group:${kind}`));

function renderList(): void {
  stateBox.hidden = true;
  toolbar.hidden = false;
  legend.hidden = false;
  canvas.hidden = true;
  list.hidden = false;
  const groups: ListGroup[] = listGroups(view, problems);
  const matches = searchNodes(view.nodes, searchText);
  const items: HTMLElement[] = [];
  // What the list shows, to leave the DOM (and a screen reader's place) alone when nothing changed.
  const shown: string[] = [];
  const treeitem = (
    key: string,
    level: number,
    label: string,
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
        h("span", { class: "twisty", "aria-hidden": "true", text: children ? (open ? "▾" : "▸") : "" }),
        h("span", { text: label }),
        description ? h("span", { class: "desc", text: description }) : undefined,
      ),
    );
    shown.push([key, label, description, open, extra["aria-selected"] ?? ""].join("\u0000"));
    if (open && children) li.append(h("ul", { role: "group" }, ...children()));
    items.push(li);
    return li;
  };
  const top = groups.map((group) =>
    treeitem(`group:${group.kind}`, 1, group.label, "", () =>
      group.nodes.map((entry) => {
        const { node } = entry;
        const problem = hasErrors(node, problems);
        return treeitem(
          `node:${node.id}`,
          2,
          `${problem ? "✗ " : ""}${node.label}`,
          entry.description,
          entry.links.length > 0
            ? () =>
                entry.links.map((link, index) =>
                  treeitem(
                    `link:${node.id}:${index}`,
                    3,
                    `${link.missing ? "┄ " : "→ "}${link.text}`,
                    "",
                    undefined,
                    { "data-target": link.target },
                  ),
                )
            : undefined,
          {
            "data-node": node.id,
            "aria-selected": String(matches.has(node.id) || focus.includes(node.id)),
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

/** The list's content as last drawn (see renderList). */
let listSignature = "";

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
  expanded.add(`group:${node.kind}`);
  listFocus = `node:${id}`;
  renderList();
  moveTo(list.querySelector<HTMLElement>(`[data-key="${CSS_ESCAPE(listFocus)}"]`) ?? undefined);
}

const CSS_ESCAPE = (value: string): string => (window.CSS?.escape ? window.CSS.escape(value) : value);

/** The node menu of a list item, below it: every action a right-click on the canvas offers. */
function showItemMenu(item: HTMLElement): boolean {
  const id = item.dataset.node ?? item.dataset.target;
  if (!id || !nodesById.has(id)) return false;
  const rect = item.getBoundingClientRect();
  const base = main.getBoundingClientRect();
  // place() offsets by 12 px; this puts the menu at the item's bottom-left corner.
  showContextMenu(id, { x: rect.left - base.left - 12, y: rect.bottom - base.top - 12 }, item);
  return true;
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
  const expandable = current.hasAttribute("aria-expanded");
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
      if (expandable && !open) {
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
      const target = current.dataset.target;
      if (target) revealInList(target);
      else if (current.dataset.node) channel.post("open", current.dataset.node);
      else if (expandable) {
        if (open) expanded.delete(key);
        else expanded.add(key);
        rerender(key);
      }
      break;
    }
    case " ": {
      const id = current.dataset.node ?? current.dataset.target;
      if (id) focusOn([id]);
      break;
    }
    default:
      return;
  }
  event.preventDefault();
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
  }
  moveTo(list.querySelector<HTMLElement>(`[data-key="${CSS_ESCAPE(key)}"]`) ?? undefined);
});

list.addEventListener("contextmenu", (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (item && showItemMenu(item)) event.preventDefault();
});

list.addEventListener("dblclick", (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (item?.dataset.node) channel.post("open", item.dataset.node);
  else if (item?.dataset.target) revealInList(item.dataset.target);
});

// ------------------------------------------------------------------------------------- state view

interface StateAction {
  readonly label: string;
  readonly run: () => void;
  readonly secondary?: boolean;
}

function showState(message: string, actions: readonly StateAction[] = []): void {
  canvas.hidden = true;
  list.hidden = true;
  hideOverlays();
  stateBox.hidden = false;
  const graphControls = model !== undefined;
  toolbar.hidden = !graphControls;
  legend.hidden = !graphControls;
  const paragraph = h("p");
  paragraph.append(...richText(message));
  stateBox.replaceChildren(
    ...present(
      paragraph,
      actions.length > 0
        ? h(
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
          )
        : undefined,
    ),
  );
}

/** `code` spans for backticked words, the rest as text. */
function richText(message: string): (HTMLElement | string)[] {
  return message.split("`").map((part, index) => (index % 2 ? h("code", { text: part }) : part));
}

function showData(next: GraphData): void {
  if (next.model) return;
  const actions: StateAction[] = [];
  if (next.status === "unavailable") {
    if (next.reason === "needs-command" || next.reason === "no-runtime" || next.reason === "editor-only")
      actions.push({ label: "Switch runtime…", run: () => channel.post("action", "switchRuntime") });
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
  const message =
    next.status === "loading" ? "Loading the catalogue…" : (next.message ?? "Nothing to show yet.");
  showState(message, actions);
  statusLine.textContent = next.folder ? next.folder : "";
}

// ---------------------------------------------------------------------------------------- toolbar

function updateToolbar(): void {
  modeSelect.value = mode ?? "focus";
  depthSelect.value = String(settings.depth);
  depthSelect.disabled = mode !== "focus";
  problemsBox.checked = settings.problemsOnly;
  followBox.checked = settings.follow;
  listButton.setAttribute("aria-pressed", String(settings.list));
  listButton.textContent = settings.list ? "View as graph" : "View as list";
  for (const control of [zoomIn, zoomOut, fitButton, relayoutButton]) control.disabled = settings.list;
  const kindsOff = mode === "chains";
  kindsMenu.toggleAttribute("aria-disabled", kindsOff);
  if (model) {
    const known = facets(model);
    if (platformSelect.options.length !== known.platforms.length + 1)
      fillSelect(platformSelect, "All platforms", known.platforms, platform);
    if (statusSelect.options.length !== known.statuses.length + 1)
      fillSelect(statusSelect, "All statuses", known.statuses, status);
  }
}

function updateStatus(): void {
  if (!data || !model || !mode) return;
  const parts: string[] = [];
  if (mode === "focus") {
    const names = focus.map((id) => nodesById.get(id)?.label ?? id);
    parts.push(
      `Focus: ${names.length > 2 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(", ")}`,
      `${settings.depth} ${settings.depth === 1 ? "hop" : "hops"}`,
    );
  } else parts.push(mode === "catalogue" ? "Catalogue" : "Threat chains");
  parts.push(`${view.nodes.length} nodes, ${view.edges.length} edges`);
  if (searchText.trim()) {
    const count = searchNodes(view.nodes, searchText).size;
    parts.push(count === 1 ? "1 match" : `${count} matches`);
  }
  if (data.refreshing) parts.push("refreshing…");
  statusLine.replaceChildren(parts.join(" · "));
  if (data.message) statusLine.append(" · ", h("span", { class: "warning", text: data.message }));
}

function setMode(next: GraphMode): void {
  mode = next;
  render({ fit: true });
}

function focusOn(ids: string[]): void {
  focus = ids;
  mode = "focus";
  render({ fit: true });
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

modeSelect.addEventListener("change", () => setMode(modeSelect.value as GraphMode));
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
followBox.addEventListener("change", () => {
  settings.follow = followBox.checked;
  save();
});
searchBox.addEventListener("input", () => {
  searchText = searchBox.value;
  if (settings.list) renderList();
  else applySearch();
});
searchBox.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const first =
    [...searchNodes(view.nodes, searchText)][0] ??
    (model ? [...searchNodes(model.nodes, searchText)][0] : undefined);
  if (!first) return;
  event.preventDefault();
  if (!nodesById.has(first)) focusOn([first]);
  else if (settings.list) revealInList(first);
  else if (cy) {
    const node = cy.getElementById(first);
    cy.$(":selected").unselect();
    node.select();
    cy.animate({ center: { eles: node }, duration: 150 });
  }
});
zoomIn.addEventListener("click", () => cy?.zoom({ level: cy.zoom() * 1.25, renderedPosition: center() }));
zoomOut.addEventListener("click", () => cy?.zoom({ level: cy.zoom() / 1.25, renderedPosition: center() }));
fitButton.addEventListener("click", () => cy?.fit(undefined, 30));
relayoutButton.addEventListener("click", () => {
  lastKey = "";
  render({ fit: true });
});
listButton.addEventListener("click", () => {
  settings.list = !settings.list;
  save();
  render({ fit: true });
  if (settings.list) moveTo(list.querySelector<HTMLElement>('[tabindex="0"]') ?? undefined);
});
exportPopup.addEventListener("click", (event) => {
  const format = (event.target as HTMLElement).closest<HTMLElement>("[data-format]")?.dataset.format;
  exportMenu.open = false;
  if (format === "svg" || format === "png" || format === "mermaid") exportGraph(format);
});
for (const menu of [kindsMenu, exportMenu]) {
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  });
}
canvas.addEventListener("keydown", (event) => {
  if (!cy) return;
  if (event.key === "+" || event.key === "=")
    cy.zoom({ level: cy.zoom() * 1.25, renderedPosition: center() });
  else if (event.key === "-") cy.zoom({ level: cy.zoom() / 1.25, renderedPosition: center() });
  else if (event.key === "0") cy.fit(undefined, 30);
  else if (event.key === "Escape") hideOverlays();
  else if (opensMenu(event)) {
    // The selected node's menu (a click selects one); View as list reaches every node by keyboard.
    const target = cy.nodes(":selected").first();
    if (target.empty()) return;
    showContextMenu(target.id(), target.renderedPosition(), canvas);
  } else return;
  event.preventDefault();
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
    if (settings.list) drawCanvas(true);
    const core = ensureCanvas();
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

channel.on("data", (next) => {
  data = next;
  if (!next.model) {
    model = undefined;
    showData(next);
    return;
  }
  const first = !model;
  model = next.model;
  if (first && !mode) mode = initialMode(model, focus.length > 0);
  render({ fit: first });
});

/** Other features' node actions this window has (validate, run query, preview deploy, new …). */
let availableActions: readonly NodeAction[] = [];
channel.on("actions", (next) => {
  availableActions = next;
});

channel.on("problems", (next) => {
  problems = next;
  if (model) render();
});

channel.on("focus", (request) => {
  if (!request.explicit && !settings.follow) return;
  const ids = [...request.ids];
  if (!model) {
    focus = ids;
    if (request.explicit) mode = request.mode ?? "focus";
    return;
  }
  if (!request.explicit && mode !== "focus") {
    // Following the editor in the catalogue: select and centre it, keep the view.
    focus = ids;
    if (cy && !settings.list) {
      const wanted = new Set(ids);
      const nodes = cy.nodes().filter((node) => wanted.has(node.id()));
      cy.$(":selected").unselect();
      if (nodes.nonempty()) {
        nodes.select();
        cy.animate({ center: { eles: nodes }, duration: 150 });
      }
    }
    return;
  }
  focus = ids;
  mode = request.mode ?? "focus";
  render({ fit: true });
  if (settings.list && ids[0]) revealInList(ids[0]);
});

new MutationObserver(() => {
  if (cy) cy.style(stylesheet(view.edges.length > 600));
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideOverlays();
});

renderKinds();
renderLegend();
showState("Loading the catalogue…");
channel.post("ready", undefined);
