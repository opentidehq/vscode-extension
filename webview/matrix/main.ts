// The ATT&CK matrix panel (SPEC §10.2): tactics as columns, techniques as cells shaded by rule count.
import type {
  Cell,
  CellDetail,
  Layer,
  MatrixFilters,
  MatrixView,
  ObjectRef,
} from "../../src/features/matrix/model";
import { type MatrixProtocol, type MatrixState, webviewValidators } from "../../src/features/matrix/protocol";
import { addStyles, announce, h, KIT_CSS, replace, stateBox } from "../panels-kit/dom";
import { createChannel, vscodeApi } from "../shared/channel";

addStyles(KIT_CSS + MATRIX_CSS());
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
/** The focused cell (roving tabindex). */
let focused: string | undefined;

channel.on("state", (next) => {
  state = next;
  render();
});
channel.on("detail", (next) => {
  detail = next;
  renderDetail();
});
channel.on("focus", (technique) => {
  const parent = technique.split(".")[0] ?? technique;
  if (technique.includes(".") && !ui.expanded.includes(parent)) ui.expanded.push(parent);
  focused = technique;
  render();
  focusCell(technique);
});

replace(root, stateBox({ kind: "loading", title: "Loading coverage…" }));
channel.post("ready", undefined);

function render(): void {
  const s = state;
  if (!s) return;
  if (s.status !== "ready" || !s.view) {
    const kind = s.status === "loading" ? "loading" : s.status === "error" ? "error" : "info";
    const actions = s.action
      ? [{ label: s.action.label, run: () => channel.post("action", s.action?.id ?? "") }]
      : [];
    if (s.status === "error")
      actions.push({ label: "Show output", run: () => channel.post("action", "output") });
    replace(
      root,
      header(s),
      stateBox({
        kind,
        title:
          s.status === "loading"
            ? "Reading the catalogue…"
            : s.status === "unavailable"
              ? "ATT&CK coverage is not available"
              : s.status === "no-folder"
                ? "No opentide folder"
                : "Could not read the catalogue",
        ...(s.message ? { body: s.message } : {}),
        actions,
      }),
    );
    return;
  }
  const view = s.view;
  replace(
    root,
    header(s),
    filtersBar(s, view),
    legend(view, s.filters),
    s.message ? h("div", { class: "banner", text: s.message }) : null,
    h("div", { class: "layout" }, [
      matrix(view, s.filters),
      h("aside", { id: "detail", class: "detail", attrs: { "aria-live": "polite" } }),
    ]),
    view.unknown.length > 0
      ? h("p", {
          class: "muted",
          text: `Not in the Enterprise matrix: ${view.unknown.join(", ")}.`,
        })
      : null,
  );
  renderDetail();
}

function header(s: MatrixState): HTMLElement {
  const view = s.view;
  return h("header", { class: "toolbar" }, [
    h("h1", { text: "ATT&CK coverage" }),
    s.folders.length > 1
      ? h(
          "select",
          {
            attrs: { "aria-label": "Folder" },
            on: { change: (event) => channel.post("folder", (event.target as HTMLSelectElement).value) },
          },
          s.folders.map((f) =>
            h("option", { text: f.name, attrs: { value: f.path, selected: f.path === s.folder?.path } }),
          ),
        )
      : s.folder
        ? h("span", { class: "muted", text: s.folder.name })
        : null,
    view
      ? h("span", {
          class: "muted",
          text: `${view.covered} of ${view.techniques} techniques have a rule · ${view.rules} rule${view.rules === 1 ? "" : "s"}`,
        })
      : null,
    s.refreshing
      ? h("span", { class: "muted" }, [h("span", { class: "spin", text: "◌" }), " refreshing"])
      : null,
    h("span", { class: "spacer" }),
    h("button", {
      class: "secondary",
      text: "Refresh",
      on: { click: () => channel.post("action", "refresh") },
    }),
    s.features.navigator
      ? h("button", {
          class: "secondary",
          text: "Export Navigator layer",
          title: "opentide generate exports navigator",
          on: { click: () => channel.post("exportNavigator", undefined) },
        })
      : null,
  ]);
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
      { attrs: { disabled }, on: { change: (event) => onChange((event.target as HTMLSelectElement).value) } },
      options.map(([v, text]) => h("option", { text, attrs: { value: v, selected: v === value } })),
    ),
  ]);
}

function checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void, title?: string) {
  return h("label", { ...(title ? { title } : {}) }, [
    h("input", {
      attrs: { type: "checkbox", checked },
      on: { change: (event) => onChange((event.target as HTMLInputElement).checked) },
    }),
    label,
  ]);
}

function filtersBar(s: MatrixState, view: MatrixView): HTMLElement {
  const f = s.filters;
  return h("div", { class: "toolbar", attrs: { role: "toolbar", "aria-label": "Filters" } }, [
    select(
      "Layer ",
      f.layer,
      [
        ["rules", "Rules"],
        ["planned", "Rules + planned objectives"],
        ["unaddressed", "Rules + planned + unaddressed threats"],
      ],
      (layer) => setFilters({ layer: layer as Layer }),
    ),
    select(
      "Platform ",
      f.platform ?? "",
      [["", "All"], ...view.platforms.map((p): [string, string] => [p, p])],
      (platform) => setFilters({ platform: platform || undefined }),
    ),
    select(
      "Tenant ",
      f.tenant ?? "",
      [
        ["", view.tenants.length ? "All" : "No deployments recorded"],
        ...view.tenants.map((t): [string, string] => [t, t]),
      ],
      (tenant) => setFilters({ tenant: tenant || undefined }),
      view.tenants.length === 0,
    ),
    checkbox(
      "Exclude INERT",
      f.excludeInert,
      (excludeInert) => setFilters({ excludeInert }),
      "Leave out rules whose blocks are all INERT (DESIGN and similar statuses)",
    ),
    checkbox(
      "Inherited techniques",
      f.inherited,
      (inherited) => setFilters({ inherited }),
      "Count techniques a rule inherits from its objective and threat. Off: only its own, as opentide info coverage counts",
    ),
    checkbox("Hide empty", ui.hideEmpty, (hideEmpty) => {
      ui.hideEmpty = hideEmpty;
      persist();
      render();
    }),
    h("input", {
      attrs: {
        type: "search",
        placeholder: "Find technique",
        "aria-label": "Find technique by id or name",
        value: ui.find,
      },
      on: {
        input: (event) => {
          ui.find = (event.target as HTMLInputElement).value;
          persist();
          renderColumns();
        },
      },
    }),
  ]);
}

function legend(view: MatrixView, filters: MatrixFilters): HTMLElement {
  return h("div", { class: "legend muted", attrs: { "aria-label": "Legend" } }, [
    h("span", { class: "cell-swatch gap", attrs: { "aria-hidden": "true" } }),
    " gap (0 rules) ",
    ...([1, 2, 3, 4] as const).flatMap((l) => [
      h("span", { class: `cell-swatch level-${l}`, attrs: { "aria-hidden": "true" } }),
      ` ${["", "1", "2–3", "4–9", "10+"][l]} `,
    ]),
    filters.layer !== "rules" ? h("span", { text: " · ◷ planned objective" }) : null,
    filters.layer === "unaddressed" ? h("span", { text: " · ! unaddressed threat" }) : null,
    h("span", {
      text: ` · ${view.columns.length} tactics · arrow keys move, Enter lists rules, + / − sub-techniques`,
    }),
  ]);
}

function matches(cell: Cell): boolean {
  const needle = ui.find.trim().toLowerCase();
  if (!needle) return true;
  const self = cell.id.toLowerCase().includes(needle) || cell.name.toLowerCase().includes(needle);
  return self || cell.subtechniques.some(matches);
}

/** The visible cells of a column, in order (expanded sub-techniques under their parent). */
function visible(cells: readonly Cell[]): Cell[] {
  const out: Cell[] = [];
  for (const cell of cells) {
    if (!matches(cell)) continue;
    if (ui.hideEmpty && cell.rules === 0 && cell.planned === 0 && cell.unaddressed === 0) continue;
    out.push(cell);
    if (ui.expanded.includes(cell.id))
      out.push(
        ...cell.subtechniques.filter((sub) => !ui.hideEmpty || sub.rules + sub.planned + sub.unaddressed > 0),
      );
  }
  return out;
}

let grid: string[][] = [];

function matrix(view: MatrixView, filters: MatrixFilters): HTMLElement {
  return h(
    "div",
    {
      id: "matrix",
      class: "matrix",
      attrs: { role: "grid", "aria-label": "ATT&CK matrix", "aria-readonly": "true" },
    },
    columns(view, filters),
  );
}

function renderColumns(): void {
  const element = document.getElementById("matrix");
  if (element && state?.view) replace(element, ...columns(state.view, state.filters));
}

function columns(view: MatrixView, filters: MatrixFilters): HTMLElement[] {
  grid = view.columns.map((column) => visible(column.cells).map((c) => c.id));
  const all = grid.flat();
  if (!focused || !all.includes(focused)) focused = all[0];
  return view.columns.map((column, c) => {
    const cells = visible(column.cells);
    return h(
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
          h("span", { text: column.name }),
          h("span", { class: "muted", text: `${column.covered}/${column.cells.length}` }),
        ]),
        ...cells.map((cell, r) => cellElement(cell, c, r, filters)),
      ],
    );
  });
}

function cellLabel(cell: Cell, filters: MatrixFilters): string {
  const parts = [
    `${cell.id} ${cell.name}`,
    cell.rules === 0 ? "gap, no rule" : `${cell.rules} rule${cell.rules === 1 ? "" : "s"}`,
  ];
  if (filters.layer !== "rules" && cell.planned) parts.push(`${cell.planned} planned`);
  if (filters.layer === "unaddressed" && cell.unaddressed) parts.push(`${cell.unaddressed} unaddressed`);
  if (cell.subtechniques.length)
    parts.push(
      `${cell.subtechniques.length} sub-techniques, ${ui.expanded.includes(cell.id) ? "expanded" : "collapsed"}`,
    );
  return parts.join(", ");
}

function cellElement(cell: Cell, c: number, r: number, filters: MatrixFilters): HTMLElement {
  const sub = cell.id.includes(".");
  const expanded = ui.expanded.includes(cell.id);
  const element = h(
    "div",
    {
      class: `cell level-${cell.level}${cell.level === 0 ? " gap" : ""}${sub ? " sub" : ""}${detail?.id === cell.id ? " selected" : ""}`,
      attrs: {
        role: "gridcell",
        tabindex: cell.id === focused ? 0 : -1,
        "data-id": cell.id,
        "aria-label": cellLabel(cell, filters),
        "aria-selected": detail?.id === cell.id ? "true" : "false",
        ...(cell.subtechniques.length ? { "aria-expanded": expanded ? "true" : "false" } : {}),
      },
      on: {
        click: () => {
          focused = cell.id;
          channel.post("select", cell.id);
        },
        keydown: (event) => onKey(event, cell, c, r),
        focus: () => {
          focused = cell.id;
        },
      },
    },
    [
      h("span", { class: "cell-id", text: cell.id }),
      h("span", { class: "cell-name", text: cell.name }),
      h("span", { class: "cell-counts" }, [
        h("span", { class: "count", text: String(cell.rules), title: "Rules" }),
        filters.layer !== "rules" && cell.planned
          ? h("span", { class: "planned", text: `◷${cell.planned}`, title: "Planned objectives" })
          : null,
        filters.layer === "unaddressed" && cell.unaddressed
          ? h("span", { class: "unaddressed", text: `!${cell.unaddressed}`, title: "Unaddressed threats" })
          : null,
        cell.subtechniques.length
          ? h("button", {
              class: "expand",
              text: expanded ? "−" : `+${cell.subtechniques.length}`,
              title: expanded ? "Collapse sub-techniques" : "Expand sub-techniques",
              attrs: { tabindex: -1, "aria-hidden": "true" },
              on: {
                click: (event) => {
                  event.stopPropagation();
                  toggle(cell.id);
                },
              },
            })
          : null,
      ]),
    ],
  );
  return element;
}

function toggle(id: string, open?: boolean): void {
  const isOpen = ui.expanded.includes(id);
  const want = open ?? !isOpen;
  if (want === isOpen) return;
  ui.expanded = want ? [...ui.expanded, id] : ui.expanded.filter((e) => e !== id);
  persist();
  focused = id;
  renderColumns();
  focusCell(id);
  announce(want ? "Sub-techniques expanded" : "Sub-techniques collapsed");
}

function focusCell(id: string | undefined): void {
  if (!id) return;
  const element = document.querySelector<HTMLElement>(`.cell[data-id="${CSS.escape(id)}"]`);
  if (!element) return;
  for (const other of document.querySelectorAll<HTMLElement>('.cell[tabindex="0"]')) other.tabIndex = -1;
  element.tabIndex = 0;
  element.focus();
  focused = id;
}

function onKey(event: KeyboardEvent, cell: Cell, c: number, r: number): void {
  const move = (dc: number, dr: number) => {
    let column = c + dc;
    while (column >= 0 && column < grid.length && (grid[column]?.length ?? 0) === 0) column += dc || 1;
    const cells = grid[column];
    if (!cells || cells.length === 0) return;
    const row = dc === 0 ? Math.min(cells.length - 1, Math.max(0, r + dr)) : Math.min(cells.length - 1, r);
    focusCell(cells[row]);
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
    case "Home":
      focusCell(grid[c]?.[0]);
      break;
    case "End":
      focusCell(grid[c]?.[(grid[c]?.length ?? 1) - 1]);
      break;
    case "Enter":
    case " ":
      channel.post("select", cell.id);
      break;
    case "+":
    case "=":
      if (cell.subtechniques.length) toggle(cell.id, true);
      break;
    case "-":
      if (cell.subtechniques.length) toggle(cell.id, false);
      else if (cell.id.includes(".")) toggle(cell.id.split(".")[0] ?? cell.id, false);
      break;
    default:
      return;
  }
  event.preventDefault();
}

function refList(title: string, refs: readonly ObjectRef[], empty: string): HTMLElement {
  return h("section", {}, [
    h("h3", { text: `${title} (${refs.length})` }),
    refs.length === 0
      ? h("p", { class: "muted", text: empty })
      : h(
          "ul",
          { class: "refs" },
          refs.map((ref) =>
            h("li", {}, [
              h("button", {
                class: "link",
                text: ref.name,
                title: `${ref.path}\n${ref.uuid}`,
                on: { click: () => channel.post("open", ref.uuid) },
              }),
              " ",
              h("span", {
                class: "badge",
                text: ref.via,
                title:
                  ref.via === "own"
                    ? "Names the technique itself"
                    : "Inherits it from its objective or threat",
              }),
              ref.statuses.length ? h("div", { class: "muted small", text: ref.statuses.join(" · ") }) : null,
            ]),
          ),
        ),
  ]);
}

function renderDetail(): void {
  const element = document.getElementById("detail");
  if (!element || !state) return;
  for (const cell of document.querySelectorAll(".cell.selected")) cell.classList.remove("selected");
  if (!detail) {
    replace(element, h("p", { class: "muted", text: "Select a technique to list the rules covering it." }));
    return;
  }
  const d = detail;
  document.querySelector(`.cell[data-id="${CSS.escape(d.id)}"]`)?.classList.add("selected");
  const f = state.filters;
  replace(
    element,
    h("h2", { text: `${d.id} ${d.name}` }),
    refList("Rules", d.rules, "No rule covers it: a gap."),
    f.layer !== "rules"
      ? refList("Planned objectives", d.planned, "No objective without rules names it.")
      : null,
    f.layer === "unaddressed"
      ? refList("Unaddressed threats", d.unaddressed, "No threat without an objective names it.")
      : null,
    h("div", { class: "toolbar" }, [
      state.features.search
        ? h("button", {
            class: "secondary",
            text: "Open in search",
            on: { click: () => channel.post("search", d.id) },
          })
        : null,
      state.features.newObjective
        ? h("button", {
            class: "secondary",
            text: "New objective for this technique…",
            on: { click: () => channel.post("newObjective", d.id) },
          })
        : null,
    ]),
  );
}

function MATRIX_CSS(): string {
  return `
.layout { display: flex; gap: 12px; align-items: flex-start; }
.matrix { display: flex; gap: 4px; overflow-x: auto; flex: 1; padding-bottom: 8px; }
.column { display: flex; flex-direction: column; gap: 3px; min-width: 150px; max-width: 180px; flex: 0 0 160px; }
.column-title { font-size: 0.9em; margin: 0 0 4px; display: flex; justify-content: space-between; gap: 4px;
  position: sticky; top: 0; background: var(--vscode-editor-background); padding: 2px 0; }
.cell { display: grid; grid-template-columns: 1fr auto; gap: 0 4px; padding: 3px 5px; border-radius: 2px; cursor: pointer;
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); font-size: 0.88em; line-height: 1.25; }
.cell:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
.cell.selected { outline: 2px solid var(--vscode-focusBorder); }
.cell.sub { margin-left: 10px; }
.cell-id { grid-column: 1; font-family: var(--vscode-editor-font-family); font-size: 0.92em; color: var(--vscode-descriptionForeground); }
.cell-name { grid-column: 1; overflow: hidden; text-overflow: ellipsis; }
.cell-counts { grid-column: 2; grid-row: 1 / span 2; display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.count { font-weight: 600; }
.expand { padding: 0 4px; font-size: 0.85em; }
.cell.gap, .cell-swatch.gap { border-style: dashed;
  background: repeating-linear-gradient(135deg, transparent 0 4px,
    color-mix(in srgb, var(--vscode-editorWidget-border, var(--vscode-panel-border)) 55%, transparent) 4px 5px); }
.level-1 { background: color-mix(in srgb, var(--vscode-charts-green) 18%, transparent); }
.level-2 { background: color-mix(in srgb, var(--vscode-charts-green) 34%, transparent); }
.level-3 { background: color-mix(in srgb, var(--vscode-charts-green) 52%, transparent); }
.level-4 { background: color-mix(in srgb, var(--vscode-charts-green) 72%, transparent); border-width: 2px; }
.planned { color: var(--vscode-charts-yellow); }
.unaddressed { color: var(--vscode-errorForeground); font-weight: 600; }
.cell-swatch { display: inline-block; width: 14px; height: 10px; vertical-align: middle; border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
.legend { margin: 4px 0 8px; }
.detail { flex: 0 0 300px; position: sticky; top: 0; max-height: 90vh; overflow: auto;
  border-left: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); padding-left: 12px; }
.refs { list-style: none; padding: 0; margin: 0; }
.refs li { margin: 4px 0; }
.small { font-size: 0.85em; }
@media (max-width: 800px) { .layout { flex-direction: column; } .detail { position: static; border-left: none; padding-left: 0; } }
`;
}
