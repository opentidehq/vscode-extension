// The ATT&CK matrix panel (SPEC §10.2): tactics as columns, techniques as cells shaded by rule count.
// The grid scrolls in both directions inside its own area, with the tactic headers sticky; a cell's hover
// card names its top rules; a click lists them in the aside. A state update with the same layout patches
// the cells in place (counts, shading) instead of rebuilding the grid.
import {
  button,
  chip,
  emptyState,
  errorState,
  keyHint,
  progressBar,
  segmented,
  spinner,
  toolbar,
} from "../../src/core/webview/kit/components";
import type {
  Cell,
  CellDetail,
  Layer,
  MatrixFilters,
  MatrixView,
  ObjectRef,
} from "../../src/features/matrix/model";
import { type MatrixProtocol, type MatrixState, webviewValidators } from "../../src/features/matrix/protocol";
import { addStyles, announce, h, mount, replace, setClass, setText } from "../panels-kit/dom";
import { hideHoverCard, hoverCard } from "../panels-kit/menu";
import { createChannel, vscodeApi } from "../shared/channel";

const channel = createChannel<MatrixProtocol>(webviewValidators);
const root = document.getElementById("root") ?? document.body;

interface UiState {
  expanded: string[];
  find: string;
  hideEmpty: boolean;
}
const saved = vscodeApi().getState() as Partial<UiState> | undefined;
const ui: UiState = {
  expanded: Array.isArray(saved?.expanded)
    ? saved.expanded.filter((e): e is string => typeof e === "string")
    : [],
  find: typeof saved?.find === "string" ? saved.find : "",
  hideEmpty: saved?.hideEmpty === true,
};
const persist = () => vscodeApi().setState(ui);

let state: MatrixState | undefined;
let detail: CellDetail | undefined;
/**
 * The focused cell (roving tabindex), as `column:technique`: a technique under two tactics has a cell in
 * each, and the arrow keys move between cells, not techniques.
 */
let focused: string | undefined;
const cellKey = (column: number, id: string) => `${column}:${id}`;
/** The grid's layout key: what decides which cells exist (columns, expanded, hidden, found). */
let layoutKey = "";
let grid: string[][] = [];
/** Every cell shown, by id. */
let cellsById = new Map<string, Cell>();

// The regions, built once.
const header = h("div");
const filters = h("div");
const progress = h("div", { class: "region-progress" });
const legendRegion = h("div");
const message = h("div");
const matrixElement = h("div", {
  id: "matrix",
  class: "matrix",
  attrs: { role: "grid", "aria-label": "ATT&CK matrix", "aria-readonly": "true" },
  on: {
    mouseover: (event) => onHover(event),
    mouseleave: () => hideHoverCard(),
    click: (event) => onCellClick(event),
    keydown: (event) => onKey(event),
    focusin: (event) => {
      const key = (event.target as HTMLElement).closest<HTMLElement>(".cell")?.dataset.k;
      if (key) focused = key;
    },
  },
});
const aside = h("aside", {
  id: "detail",
  class: "detail",
  attrs: { "aria-live": "polite", "aria-label": "Technique" },
});
const layout = h("div", { class: "layout" }, [h("div", { class: "matrix-scroll" }, [matrixElement]), aside]);
const unknown = h("div");
const placeholder = h("div");
replace(root, header, filters, progress, legendRegion, message, placeholder, layout, unknown);

channel.on("state", (next) => {
  state = next;
  render();
});
channel.on("detail", (next) => {
  detail = next ?? undefined;
  renderDetail();
});
channel.on("focus", (technique) => {
  const parent = technique.split(".")[0] ?? technique;
  if (technique.includes(".") && !ui.expanded.includes(parent)) ui.expanded.push(parent);
  render();
  // The technique's first cell (a technique can sit under several tactics).
  const first = matrixElement.querySelector<HTMLElement>(`.cell[data-id="${CSS.escape(technique)}"]`)?.dataset
    .k;
  focused = first ?? focused;
  focusCell(focused);
});

replace(header, toolbar({ title: "ATT&CK coverage", context: [chip({ text: "Loading…", tone: "muted" })] }));
replace(progress, progressBar({ active: true, label: "Reading the catalogue" }));
layout.hidden = true;
channel.post("ready", undefined);

function render(): void {
  const s = state;
  if (!s) return;
  renderHeader(s);
  replace(
    progress,
    progressBar({ active: s.status === "loading" || s.refreshing, label: "Reading the catalogue" }),
  );
  if (s.status !== "ready" || !s.view) {
    layout.hidden = true;
    replace(filters);
    replace(legendRegion);
    replace(unknown);
    replace(message);
    replace(placeholder, notReady(s));
    return;
  }
  replace(placeholder);
  layout.hidden = false;
  const view = s.view;
  renderFilters(s, view);
  replace(legendRegion, legend(s.filters));
  replace(message, s.message ? h("div", { class: "ot-callout warning", text: s.message }) : null);
  renderGrid(view, s.filters);
  renderDetail();
  replace(
    unknown,
    view.unknown.length > 0
      ? h("p", { class: "ot-hint", text: `Not in the Enterprise matrix: ${view.unknown.join(", ")}.` })
      : null,
  );
}

function notReady(s: MatrixState) {
  const action = s.action
    ? { label: s.action.label, run: () => channel.post("action", s.action?.id ?? "") }
    : undefined;
  if (s.status === "loading")
    return h(
      "div",
      { class: "matrix-skeleton", attrs: { "aria-busy": "true", "aria-label": "Reading the catalogue" } },
      Array.from({ length: 8 }, () =>
        h(
          "div",
          { class: "skeleton-column" },
          Array.from({ length: 10 }, () => h("div", { class: "skeleton-cell" })),
        ),
      ),
    );
  if (s.status === "error")
    return errorState({
      title: "Could not read the catalogue",
      ...(s.message ? { body: s.message } : {}),
      ...(action ? { action } : {}),
      onShowOutput: () => channel.post("action", "output"),
    });
  return emptyState({
    icon: s.status === "no-folder" ? "folder" : "info",
    title: s.status === "no-folder" ? "No opentide folder" : "ATT&CK coverage is not available",
    ...(s.message ? { body: s.message } : {}),
    ...(action ? { action } : {}),
  });
}

function renderHeader(s: MatrixState): void {
  const view = s.view;
  const context = [
    s.folders.length > 1
      ? h(
          "select",
          {
            attrs: { "aria-label": "Folder", "data-focus": "folder" },
            on: { change: (event) => channel.post("folder", (event.target as HTMLSelectElement).value) },
          },
          s.folders.map((f) =>
            h("option", { text: f.name, attrs: { value: f.path, selected: f.path === s.folder?.path } }),
          ),
        )
      : s.folder
        ? chip({ text: s.folder.name, icon: "folder" })
        : null,
    view
      ? chip({
          text: `${view.covered} of ${view.techniques} techniques covered`,
          icon: "target",
          tone: view.covered > 0 ? "ok" : "muted",
          title: "Techniques (not sub-techniques) with at least one rule",
        })
      : null,
    view ? chip({ text: `${view.rules} rule${view.rules === 1 ? "" : "s"}`, icon: "shield" }) : null,
    s.refreshing ? h("span", { class: "ot-hint" }, [mount(spinner("Refreshing")), " refreshing"]) : null,
  ];
  replace(
    header,
    toolbar({
      title: "ATT&CK coverage",
      context,
      label: "Matrix",
      actions: [
        button({
          label: "Refresh",
          variant: "icon",
          icon: "refresh",
          focusKey: "refresh",
          onClick: () => channel.post("action", "refresh"),
        }),
        s.features.navigator
          ? button({
              label: "Export Navigator layer",
              variant: "secondary",
              icon: "export",
              focusKey: "navigator",
              title: "opentide generate exports navigator",
              onClick: () => channel.post("exportNavigator", undefined),
            })
          : null,
      ],
    }),
  );
}

function setFilters(change: Partial<MatrixFilters>): void {
  if (!state) return;
  const next: MatrixFilters = { ...state.filters, ...change };
  // Optional keys left undefined are dropped, so the message validates.
  const clean = Object.fromEntries(
    Object.entries(next).filter(([, v]) => v !== undefined && v !== ""),
  ) as unknown as MatrixFilters;
  channel.post("filters", clean);
}

function select(
  label: string,
  value: string,
  options: readonly [string, string][],
  onChange: (value: string) => void,
  disabled = false,
) {
  return h("label", {}, [
    label,
    h(
      "select",
      {
        attrs: { disabled, "data-focus": `select:${label}` },
        on: { change: (event) => onChange((event.target as HTMLSelectElement).value) },
      },
      options.map(([v, text]) => h("option", { text, attrs: { value: v, selected: v === value } })),
    ),
  ]);
}

function toggle(label: string, checked: boolean, onChange: (checked: boolean) => void, title?: string) {
  return h("label", { class: "toggle", ...(title ? { title } : {}) }, [
    h("input", {
      attrs: { type: "checkbox", checked, "data-focus": `toggle:${label}` },
      on: { change: (event) => onChange((event.target as HTMLInputElement).checked) },
    }),
    label,
  ]);
}

/** The options, plus the filter's own value when the data lacks it, so the select shows what filters. */
function withCurrent(values: readonly string[], current: string | undefined): [string, string][] {
  const options = values.map((v): [string, string] => [v, v]);
  if (current && !values.includes(current)) options.push([current, `${current} (not in this folder)`]);
  return options;
}

function renderFilters(s: MatrixState, view: MatrixView): void {
  const f = s.filters;
  // The find box keeps its element (and the caret) across renders.
  const find =
    filters.querySelector<HTMLInputElement>("input[type=search]") ??
    h("input", {
      attrs: {
        type: "search",
        placeholder: "Find technique",
        "aria-label": "Find technique by id or name",
        "data-focus": "find",
      },
      on: {
        input: (event) => {
          ui.find = (event.target as HTMLInputElement).value;
          persist();
          if (state?.view) renderGrid(state.view, state.filters);
        },
      },
    });
  if (find.value !== ui.find) find.value = ui.find;
  replace(
    filters,
    h("div", { class: "ot-bar", attrs: { role: "group", "aria-label": "Filters" } }, [
      segmented({
        name: "layer",
        label: "Layer",
        value: f.layer,
        options: [
          { value: "rules", label: "Rules", title: "Rules only" },
          { value: "planned", label: "+ Planned", title: "Rules and objectives without rules" },
          {
            value: "unaddressed",
            label: "+ Unaddressed",
            title: "Rules, planned objectives and threats with no objective",
          },
        ],
        onChange: (layer) => setFilters({ layer: layer as Layer }),
      }),
      select(
        "Platform ",
        f.platform ?? "",
        [["", "All"], ...withCurrent(view.platforms, f.platform)],
        (platform) => setFilters({ platform: platform || undefined }),
      ),
      select(
        "Tenant ",
        f.tenant ?? "",
        [
          ["", view.tenants.length ? "All" : "No deployments recorded"],
          ...withCurrent(view.tenants, f.tenant),
        ],
        (tenant) => setFilters({ tenant: tenant || undefined }),
        // A set filter must stay clearable, even with nothing to choose from.
        view.tenants.length === 0 && !f.tenant,
      ),
      h("span", { class: "ot-divider", attrs: { "aria-hidden": "true" } }),
      toggle(
        "Exclude INERT",
        f.excludeInert,
        (excludeInert) => setFilters({ excludeInert }),
        "Leave out rules whose blocks are all INERT (DESIGN and similar statuses)",
      ),
      toggle(
        "Inherited",
        f.inherited,
        (inherited) => setFilters({ inherited }),
        "Count techniques a rule inherits from its objective and threat. Off: only its own, as opentide info coverage counts",
      ),
      toggle("Hide empty", ui.hideEmpty, (hideEmpty) => {
        ui.hideEmpty = hideEmpty;
        persist();
        if (state?.view) renderGrid(state.view, state.filters);
      }),
      h("span", { class: "ot-spacer" }),
      find,
    ]),
  );
}

const LEVELS = [
  [1, "1"],
  [2, "2–3"],
  [3, "4–9"],
  [4, "10+"],
] as const;

function legend(f: MatrixFilters): HTMLElement {
  return h(
    "div",
    { class: "legend", attrs: { role: "group", "aria-label": "Legend: rules per technique" } },
    [
      h("span", { class: "legend-item" }, [
        h("span", { class: "swatch gap", attrs: { "aria-hidden": "true" } }),
        "gap (0)",
      ]),
      ...LEVELS.map(([level, text]) =>
        h("span", { class: "legend-item" }, [
          h("span", { class: `swatch level-${level}`, attrs: { "aria-hidden": "true" } }),
          `${text} rule${level === 1 ? "" : "s"}`,
        ]),
      ),
      f.layer !== "rules"
        ? h("span", { class: "legend-item" }, [
            h("span", { class: "codicon codicon-clock planned" }),
            "planned objective",
          ])
        : null,
      f.layer === "unaddressed"
        ? h("span", { class: "legend-item" }, [
            h("span", { class: "codicon codicon-warning unaddressed" }),
            "unaddressed threat",
          ])
        : null,
      mount(keyHint("Arrows move · Enter lists rules · + / − sub-techniques · Shift+scroll pans")),
    ],
  );
}

function matches(cell: Cell): boolean {
  const needle = ui.find.trim().toLowerCase();
  if (!needle) return true;
  const self = cell.id.toLowerCase().includes(needle) || cell.name.toLowerCase().includes(needle);
  return self || cell.subtechniques.some(matches);
}

const empty = (cell: Cell) => cell.rules === 0 && cell.planned === 0 && cell.unaddressed === 0;

/** The visible cells of a column, in order (expanded sub-techniques under their parent). */
function visible(cells: readonly Cell[]): Cell[] {
  const out: Cell[] = [];
  for (const cell of cells) {
    if (!matches(cell)) continue;
    if (ui.hideEmpty && empty(cell) && cell.subtechniques.every(empty)) continue;
    out.push(cell);
    if (ui.expanded.includes(cell.id))
      out.push(...cell.subtechniques.filter((sub) => !ui.hideEmpty || !empty(sub)));
  }
  return out;
}

/**
 * Build the grid when its layout changed (filters that hide cells, expansion, a new catalogue's shape);
 * otherwise update each cell's counts and shading in place.
 */
function renderGrid(view: MatrixView, f: MatrixFilters): void {
  const columns = view.columns.map((column) => ({ column, cells: visible(column.cells) }));
  const key = JSON.stringify([
    f.layer,
    columns.map(({ column, cells }) => [column.id, cells.map((c) => c.id)]),
  ]);
  grid = columns.map(({ cells }) => cells.map((c) => c.id));
  cellsById = new Map(columns.flatMap(({ cells }) => cells.map((c) => [c.id, c] as const)));
  const all = grid.flatMap((ids, c) => ids.map((id) => cellKey(c, id)));
  if (!focused || !all.includes(focused)) focused = all[0];
  if (key !== layoutKey) {
    layoutKey = key;
    const hadFocus = matrixElement.contains(document.activeElement);
    replace(
      matrixElement,
      ...columns.map(({ column, cells }, c) =>
        h(
          "section",
          {
            class: "column",
            attrs: {
              role: "row",
              "aria-label": `${column.name}: ${column.covered} of ${column.cells.length} techniques covered`,
            },
          },
          [
            h("h2", { class: "column-title", attrs: { role: "columnheader" } }, [
              h("span", { class: "column-name", text: column.name }),
              h("span", { class: "column-count", text: `${column.covered}/${column.cells.length}` }),
              h("span", { class: "column-bar", attrs: { "aria-hidden": "true" } }, [
                h("span", { class: "column-fill" }),
              ]),
            ]),
            ...cells.map((cell, r) => cellElement(cell, c, r)),
          ],
        ),
      ),
    );
    for (const [index, { column }] of columns.entries()) {
      const fill = matrixElement.children[index]?.querySelector<HTMLElement>(".column-fill");
      if (fill)
        fill.style.width = `${column.cells.length ? Math.round((column.covered / column.cells.length) * 100) : 0}%`;
    }
    if (hadFocus) focusCell(focused);
  }
  for (const element of matrixElement.querySelectorAll<HTMLElement>(".cell")) {
    const cell = cellsById.get(element.dataset.id ?? "");
    if (cell) updateCell(element, cell, f);
  }
}

function cellLabel(cell: Cell, f: MatrixFilters): string {
  const parts = [
    `${cell.id} ${cell.name}`,
    cell.rules === 0 ? "gap, no rule" : `${cell.rules} rule${cell.rules === 1 ? "" : "s"}`,
  ];
  if (f.layer !== "rules" && cell.planned) parts.push(`${cell.planned} planned`);
  if (f.layer === "unaddressed" && cell.unaddressed) parts.push(`${cell.unaddressed} unaddressed`);
  if (cell.subtechniques.length)
    parts.push(
      `${cell.subtechniques.length} sub-techniques, ${ui.expanded.includes(cell.id) ? "expanded" : "collapsed"}`,
    );
  return parts.join(", ");
}

function cellElement(cell: Cell, c: number, r: number): HTMLElement {
  const element = h(
    "div",
    {
      class: `cell${cell.id.includes(".") ? " sub" : ""}`,
      attrs: {
        role: "gridcell",
        tabindex: -1,
        "data-id": cell.id,
        "data-k": cellKey(c, cell.id),
        "data-c": c,
        "data-r": r,
      },
    },
    [
      h("span", { class: "cell-id", text: cell.id }),
      h("span", { class: "cell-name", text: cell.name }),
      h("span", { class: "cell-counts" }, [
        h("span", { class: "count" }),
        h("span", { class: "planned" }),
        h("span", { class: "unaddressed" }),
        cell.subtechniques.length
          ? h("button", {
              class: "expand",
              attrs: { tabindex: -1, "aria-hidden": "true", type: "button" },
            })
          : null,
      ]),
    ],
  );
  return element;
}

/** A cell's counts, shading and state, set in place. */
function updateCell(element: HTMLElement, cell: Cell, f: MatrixFilters): void {
  const expanded = ui.expanded.includes(cell.id);
  for (let level = 0; level <= 4; level++) setClass(element, `level-${level}`, cell.level === level);
  setClass(element, "gap", cell.level === 0);
  setClass(element, "selected", detail?.id === cell.id);
  element.tabIndex = element.dataset.k === focused ? 0 : -1;
  element.setAttribute("aria-label", cellLabel(cell, f));
  element.setAttribute("aria-selected", detail?.id === cell.id ? "true" : "false");
  if (cell.subtechniques.length) element.setAttribute("aria-expanded", String(expanded));
  const count = element.querySelector(".count");
  if (count) setText(count, String(cell.rules));
  const planned = element.querySelector<HTMLElement>(".planned");
  if (planned) {
    const show = f.layer !== "rules" && cell.planned > 0;
    planned.hidden = !show;
    planned.title = "Planned objectives";
    setText(planned, show ? `◷${cell.planned}` : "");
  }
  const unaddressed = element.querySelector<HTMLElement>(".unaddressed");
  if (unaddressed) {
    const show = f.layer === "unaddressed" && cell.unaddressed > 0;
    unaddressed.hidden = !show;
    unaddressed.title = "Unaddressed threats";
    setText(unaddressed, show ? `!${cell.unaddressed}` : "");
  }
  const expand = element.querySelector<HTMLElement>(".expand");
  if (expand) {
    setText(expand, expanded ? "−" : `+${cell.subtechniques.length}`);
    expand.title = expanded ? "Collapse sub-techniques" : "Expand sub-techniques";
  }
}

function cellFrom(event: Event): HTMLElement | null {
  return (event.target as HTMLElement | null)?.closest<HTMLElement>(".cell") ?? null;
}

function onHover(event: MouseEvent): void {
  const element = cellFrom(event);
  if (!element) {
    hideHoverCard();
    return;
  }
  if (element.dataset.hovered === "1") return;
  for (const other of matrixElement.querySelectorAll<HTMLElement>('[data-hovered="1"]'))
    delete other.dataset.hovered;
  element.dataset.hovered = "1";
  element.addEventListener(
    "mouseleave",
    () => {
      delete element.dataset.hovered;
      hideHoverCard();
    },
    { once: true },
  );
  const cell = cellsById.get(element.dataset.id ?? "");
  if (!cell) return;
  hoverCard(element, () => hoverContent(cell));
}

function hoverContent(cell: Cell): Node {
  const more = cell.rules - cell.top.length;
  return h("div", { class: "card" }, [
    h("div", { class: "card-title" }, [h("span", { class: "mono", text: cell.id }), ` ${cell.name}`]),
    h("div", {
      class: cell.rules === 0 ? "card-gap" : "card-count",
      text:
        cell.rules === 0 ? "A gap: no rule covers it" : `${cell.rules} rule${cell.rules === 1 ? "" : "s"}`,
    }),
    cell.top.length
      ? h("ul", { class: "card-rules" }, [
          ...cell.top.map((name) => h("li", { text: name })),
          more > 0 ? h("li", { class: "muted", text: `and ${more} more` }) : null,
        ])
      : null,
    state?.filters.layer !== "rules" && cell.planned
      ? h("div", {
          class: "muted",
          text: `${cell.planned} planned objective${cell.planned === 1 ? "" : "s"}`,
        })
      : null,
    h("div", { class: "ot-hint", text: "Click to list them" }),
  ]);
}

function onCellClick(event: MouseEvent): void {
  const element = cellFrom(event);
  const id = element?.dataset.id;
  if (!element || !id) return;
  const key = element.dataset.k;
  if ((event.target as HTMLElement).closest(".expand")) {
    event.stopPropagation();
    toggleExpand(id, undefined, key);
    return;
  }
  focused = key;
  hideHoverCard();
  focusCell(key);
  channel.post("select", id);
}

function toggleExpand(id: string, open?: boolean, key?: string): void {
  const isOpen = ui.expanded.includes(id);
  const want = open ?? !isOpen;
  if (want === isOpen) return;
  ui.expanded = want ? [...ui.expanded, id] : ui.expanded.filter((e) => e !== id);
  persist();
  if (key) focused = key;
  if (state?.view) renderGrid(state.view, state.filters);
  focusCell(focused);
  announce(want ? "Sub-techniques expanded" : "Sub-techniques collapsed");
}

function focusCell(key: string | undefined): void {
  if (!key) return;
  const element = matrixElement.querySelector<HTMLElement>(`.cell[data-k="${CSS.escape(key)}"]`);
  if (!element) return;
  for (const other of matrixElement.querySelectorAll<HTMLElement>('.cell[tabindex="0"]')) other.tabIndex = -1;
  element.tabIndex = 0;
  element.focus({ preventScroll: true });
  // Keep the cell in view inside the grid's own scroll area (both directions, below the sticky header).
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
  focused = key;
}

function focusAt(column: number, row: number): void {
  const id = grid[column]?.[row];
  if (id) focusCell(cellKey(column, id));
}

function onKey(event: KeyboardEvent): void {
  const element = cellFrom(event);
  const id = element?.dataset.id;
  if (!element || !id) return;
  const cell = cellsById.get(id);
  const c = Number(element.dataset.c);
  const r = Number(element.dataset.r);
  const move = (dc: number, dr: number) => {
    let column = c + dc;
    while (column >= 0 && column < grid.length && (grid[column]?.length ?? 0) === 0) column += dc || 1;
    const cells = grid[column];
    if (!cells || cells.length === 0) return;
    const row = dc === 0 ? Math.min(cells.length - 1, Math.max(0, r + dr)) : Math.min(cells.length - 1, r);
    const target = cells[row];
    if (target) focusCell(cellKey(column, target));
  };
  switch (event.key) {
    case "ArrowRight":
      move(1, 0);
      break;
    case "ArrowLeft":
      move(-1, 0);
      break;
    case "ArrowDown":
      move(0, 1);
      break;
    case "ArrowUp":
      move(0, -1);
      break;
    case "PageDown":
      move(0, 10);
      break;
    case "PageUp":
      move(0, -10);
      break;
    case "Home":
      if (event.ctrlKey) focusAt(0, 0);
      else focusAt(c, 0);
      break;
    case "End":
      if (event.ctrlKey) focusAt(grid.length - 1, (grid.at(-1)?.length ?? 1) - 1);
      else focusAt(c, (grid[c]?.length ?? 1) - 1);
      break;
    case "Enter":
    case " ":
      hideHoverCard();
      channel.post("select", id);
      break;
    case "+":
    case "=":
      if (cell?.subtechniques.length) toggleExpand(id, true, element.dataset.k);
      break;
    case "-":
      if (cell?.subtechniques.length) toggleExpand(id, false, element.dataset.k);
      else if (id.includes(".")) {
        const parent = id.split(".")[0] ?? id;
        toggleExpand(parent, false, cellKey(c, parent));
      }
      break;
    case "Escape":
      hideHoverCard();
      break;
    default:
      return;
  }
  event.preventDefault();
}

function refList(title: string, refs: readonly ObjectRef[], empty_: string, icon: string): HTMLElement {
  return h("section", { class: "refs-section" }, [
    h("h3", {}, [
      h("span", { class: `codicon codicon-${icon}`, attrs: { "aria-hidden": "true" } }),
      ` ${title} `,
      h("span", { class: "ot-badge", text: String(refs.length) }),
    ]),
    refs.length === 0
      ? h("p", { class: "ot-hint", text: empty_ })
      : h(
          "ul",
          { class: "refs" },
          refs.map((ref) =>
            h("li", {}, [
              mount(
                button({
                  label: ref.name,
                  variant: "link",
                  title: `${ref.path}\n${ref.uuid}\nOpens beside the matrix`,
                  onClick: () => channel.post("open", ref.uuid),
                }),
              ),
              " ",
              h("span", {
                class: `ot-tag ${ref.via === "own" ? "" : "muted"}`,
                text: ref.via === "own" ? "Technique" : "inherited",
                title:
                  ref.via === "own"
                    ? "Names the technique itself"
                    : "Inherits it from its objective or threat",
              }),
              ref.statuses.length ? h("div", { class: "ot-hint", text: ref.statuses.join(" · ") }) : null,
            ]),
          ),
        ),
  ]);
}

function renderDetail(): void {
  if (!state) return;
  for (const cell of matrixElement.querySelectorAll(".cell.selected")) cell.classList.remove("selected");
  if (!detail) {
    replace(
      aside,
      emptyState({
        icon: "target",
        title: "Pick a technique",
        body: "Click a cell, or press Enter on it, to list the rules that cover it.",
      }),
    );
    return;
  }
  const d = detail;
  // A technique under several tactics is selected in each.
  for (const selectedCell of matrixElement.querySelectorAll(`.cell[data-id="${CSS.escape(d.id)}"]`)) {
    selectedCell.classList.add("selected");
    selectedCell.setAttribute("aria-selected", "true");
  }
  const f = state.filters;
  replace(
    aside,
    h("div", { class: "detail-head" }, [
      h("div", { class: "mono muted", text: d.id }),
      h("h2", { text: d.name }),
    ]),
    refList("Rules", d.rules, "No rule covers it: a gap.", "shield"),
    f.layer !== "rules"
      ? refList("Planned objectives", d.planned, "No objective without rules names it.", "clock")
      : null,
    f.layer === "unaddressed"
      ? refList("Unaddressed threats", d.unaddressed, "No threat without an objective names it.", "warning")
      : null,
    h("div", { class: "ot-bar" }, [
      state.features.search
        ? mount(
            button({
              label: "Open in search",
              variant: "secondary",
              icon: "search",
              onClick: () => channel.post("search", d.id),
            }),
          )
        : null,
      state.features.newObjective
        ? mount(
            button({
              label: "New objective…",
              variant: "secondary",
              icon: "add",
              title: "opentide new objective: add this technique to it once it is written",
              onClick: () => channel.post("newObjective", d.id),
            }),
          )
        : null,
    ]),
  );
}

addStyles(`
.region-progress { margin: 0 calc(-1 * var(--ot-space-4)); }
.toggle { display: inline-flex; gap: var(--ot-space-1); align-items: center; }
.legend { display: flex; flex-wrap: wrap; gap: var(--ot-space-1) var(--ot-space-3); align-items: center; margin: var(--ot-space-1) 0 var(--ot-space-2);
  color: var(--ot-muted); font-size: var(--ot-font-sm); }
.legend-item { display: inline-flex; gap: var(--ot-space-1); align-items: center; }
#root { display: flex; flex-direction: column; height: calc(100vh - var(--ot-space-4)); }
.layout { display: flex; gap: var(--ot-space-3); align-items: stretch; flex: 1; min-height: 320px; }
.matrix-scroll { flex: 1; min-width: 0; overflow: auto; border: 1px solid var(--ot-border); border-radius: var(--ot-radius-2);
  scroll-padding: 40px 8px 8px 8px; }
.matrix { display: flex; gap: var(--ot-space-1); padding: 0 var(--ot-space-1) var(--ot-space-2); width: max-content; }
.column { display: flex; flex-direction: column; gap: 3px; width: 168px; }
.ot-kit .column-title { position: sticky; top: 0; z-index: 3; display: grid; grid-template-columns: 1fr auto; gap: 2px var(--ot-space-1);
  margin: 0 0 var(--ot-space-1); padding: var(--ot-space-1) 2px; font-size: var(--ot-font-sm);
  background: var(--vscode-editor-background); border-bottom: 1px solid var(--ot-border); }
.column-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.column-count { color: var(--ot-muted); font-weight: normal; font-variant-numeric: tabular-nums; }
.column-bar { grid-column: 1 / -1; height: 3px; border-radius: 2px; background: var(--ot-border); overflow: hidden; }
.column-fill { display: block; height: 100%; background: var(--vscode-charts-green); }
.cell { display: grid; grid-template-columns: 1fr auto; gap: 0 var(--ot-space-1); padding: 3px 5px; border-radius: var(--ot-radius-1);
  cursor: pointer; border: 1px solid var(--ot-border); font-size: var(--ot-font-sm); line-height: 1.25; min-height: 34px; box-sizing: border-box; }
.cell:hover { border-color: var(--ot-focus); }
.cell:focus-visible { outline: 2px solid var(--ot-focus); outline-offset: 1px; }
.cell.selected { outline: 2px solid var(--ot-focus); outline-offset: -1px; }
.cell.sub { margin-left: 10px; }
.cell-id { grid-column: 1; font-family: var(--vscode-editor-font-family); font-size: var(--ot-font-xs); color: var(--ot-muted); }
.cell-name { grid-column: 1; overflow: hidden; text-overflow: ellipsis; }
.cell-counts { grid-column: 2; grid-row: 1 / span 2; display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.count { font-weight: 600; font-variant-numeric: tabular-nums; }
.cell .expand { padding: 0 4px; min-height: 0; font-size: var(--ot-font-xs); line-height: 14px; border-radius: var(--ot-radius-1);
  color: var(--ot-muted); background: transparent; border: 1px solid var(--ot-border); }
.cell .expand:hover { color: var(--vscode-foreground); background: var(--ot-hover); }
.cell.gap, .swatch.gap { border-style: dashed;
  background: repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in srgb, var(--ot-border) 60%, transparent) 4px 5px); }
.level-1 { background: color-mix(in srgb, var(--vscode-charts-green) 18%, var(--vscode-editor-background)); }
.level-2 { background: color-mix(in srgb, var(--vscode-charts-green) 34%, var(--vscode-editor-background)); }
.level-3 { background: color-mix(in srgb, var(--vscode-charts-green) 52%, var(--vscode-editor-background)); }
.level-4 { background: color-mix(in srgb, var(--vscode-charts-green) 70%, var(--vscode-editor-background)); border-width: 2px; }
.vscode-high-contrast .cell.level-1 { border-width: 1px; border-color: var(--vscode-charts-green); }
.vscode-high-contrast .cell.level-2, .vscode-high-contrast .cell.level-3 { border-width: 2px; border-color: var(--vscode-charts-green); }
.vscode-high-contrast .cell.level-4 { border-width: 3px; border-color: var(--vscode-charts-green); }
.vscode-high-contrast .cell[class*="level-"]:not(.gap) { background: transparent; }
.vscode-high-contrast .cell.gap { background: none; }
.vscode-high-contrast .swatch.level-1 { border: 1px solid var(--vscode-charts-green); background: transparent; }
.vscode-high-contrast .swatch.level-2, .vscode-high-contrast .swatch.level-3 { border: 2px solid var(--vscode-charts-green); background: transparent; }
.vscode-high-contrast .swatch.level-4 { border: 3px solid var(--vscode-charts-green); background: transparent; }
.planned { color: var(--vscode-charts-yellow); }
.unaddressed { color: var(--ot-error); font-weight: 600; }
.swatch { display: inline-block; width: 16px; height: 12px; border-radius: 2px; border: 1px solid var(--ot-border); box-sizing: border-box; }
.detail { flex: 0 0 300px; overflow: auto; border: 1px solid var(--ot-border); border-radius: var(--ot-radius-2); padding: var(--ot-space-2) var(--ot-space-3); }
.detail .ot-state { margin: var(--ot-space-6) auto; }
.detail-head h2 { margin: 2px 0 var(--ot-space-2); }
.refs-section h3 { display: flex; align-items: center; gap: var(--ot-space-1); }
.refs { list-style: none; padding: 0; margin: 0; }
.refs li { margin: var(--ot-space-1) 0; }
.card-title { font-weight: 600; margin-bottom: 2px; }
.card-count { font-weight: 600; color: var(--ot-ok); }
.card-gap { color: var(--ot-muted); }
.card-rules { margin: var(--ot-space-1) 0; padding-left: 18px; }
.matrix-skeleton { display: flex; gap: var(--ot-space-1); flex: 1; overflow: hidden; }
.skeleton-column { display: flex; flex-direction: column; gap: 3px; width: 168px; }
.skeleton-cell { height: 34px; border-radius: 2px; background: var(--ot-border); opacity: 0.35; animation: ot-pulse 1.4s ease-in-out infinite; }
@media (max-width: 720px) { #root { height: auto; } .layout { flex-direction: column; flex: none; } .matrix-scroll { height: 55vh; flex: none; }
  .detail { flex: none; max-height: 45vh; } }
`);
