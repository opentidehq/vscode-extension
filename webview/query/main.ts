// The query results panel (SPEC §10.4): what runs where in the toolbar, progress per tenant, one tab per
// tenant, a virtual table. The page's regions are built once; a state update patches them (the table
// keeps its rows, scroll and focus unless the rows changed).
import {
  button,
  callout,
  chip,
  collapsible,
  emptyState,
  errorState,
  icon,
  keyHint,
  progressBar,
  skeletonRows,
  toolbar,
} from "../../src/core/webview/kit/components";
import { formatRows } from "../../src/features/query/format";
import {
  type QueryPanelState,
  type QueryProtocol,
  type TenantTab,
  webviewValidators,
} from "../../src/features/query/protocol";
import {
  applyProgress,
  canStartRun,
  exportable,
  formatMs,
  queryViewState,
  tabSummary,
} from "../../src/features/query/results";
import { addStyles, announce, h, patchKeyed, replace, setText } from "../panels-kit/dom";
import { menuButton } from "../panels-kit/menu";
import { VirtualTable } from "../panels-kit/table";
import { createChannel, vscodeApi } from "../shared/channel";

const channel = createChannel<QueryProtocol>(webviewValidators);
const root = document.getElementById("root") ?? document.body;

let state: QueryPanelState | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const table = new VirtualTable({
  label: "Query results",
  onCopy: (format, text) => channel.post("copy", { format, text }),
  onViewChange: () => saveView(),
});
// The panel reloads when hidden (rows are never kept in webview state): the selected tab, filter, sort
// and the open sections are UI preferences, so they are kept and put back.
const saved = queryViewState(vscodeApi().getState());
const savedRaw = (vscodeApi().getState() ?? {}) as { details?: unknown; command?: unknown };
let selected: string | undefined = saved.selected;
let detailsOpen = savedRaw.details === true;
let commandOpen = savedRaw.command === true;
if (saved.table) table.restoreView(saved.table);

function saveView(): void {
  vscodeApi().setState({ selected, table: table.viewState(), details: detailsOpen, command: commandOpen });
}

// The regions, built once.
const header = h("div", { class: "region-header" });
const progress = h("div", { class: "region-progress" });
const notes = h("div", { class: "region-notes" });
const tabs = h("div", {
  class: "ot-tabs",
  attrs: { role: "tablist", "aria-label": "Tenants" },
});
const panel = h("div", { id: "tabpanel", class: "region-panel", attrs: { role: "tabpanel" } });
const tableNotes = h("div", { class: "region-table-notes" });
const tableHost = h("div", { class: "region-table" });
const tableFooter = h("div", { class: "vt-footer" });
const placeholder = h("div", { class: "region-placeholder" });
const details = h("div", { class: "region-details" });
const footer = h("div", { class: "region-footer" });
tableHost.append(table.element);
panel.append(tableNotes, placeholder, tableHost, tableFooter);
replace(root, header, progress, notes, tabs, panel, details, footer);
renderLoading();

channel.on("state", (next) => {
  const previous = state;
  state = next;
  if (!selected || !next.tabs.some((t) => t.key === selected)) {
    selected = (next.tabs.find((t) => t.status === "ok") ?? next.tabs[0])?.key;
  }
  render();
  if (previous?.phase === "running" && next.phase !== "running") announce(next.message);
});

channel.on("progress", (event) => {
  if (!state) return;
  state = { ...state, tabs: applyProgress(state.tabs, event) };
  renderTabs();
  renderPanel();
  announce(`${event.tenant}: ${event.status === "ok" ? `${event.rows ?? 0} rows` : "failed"}`);
});

channel.post("ready", undefined);

/** Before the first state: the toolbar's shape and skeleton rows, so nothing jumps when it arrives. */
function renderLoading(): void {
  replace(header, toolbar({ title: "Query results", context: [chip({ text: "Loading…", tone: "muted" })] }));
  replace(progress, progressBar({ active: true, label: "Loading" }));
  tableHost.hidden = true;
  replace(placeholder, skeletonRows({ rows: 12, columns: 5 }));
}

function render(): void {
  const s = state;
  if (!s) return;
  if (timer) clearInterval(timer);
  timer = s.phase === "running" ? setInterval(renderElapsed, 250) : undefined;
  renderHeader(s);
  replace(progress, progressBar({ active: s.phase === "running", label: `Querying ${s.contacts}` }));
  replace(
    notes,
    s.writesPreviewAlerts
      ? callout({
          tone: "warning",
          title: "Writes preview alerts.",
          body: "Elastic Kuery runs as a rule preview: the tenant writes the preview's alerts to its preview index. No rule is saved.",
        })
      : null,
  );
  renderTabs();
  renderPanel();
  renderDetails();
  renderFooter(s);
}

function renderHeader(s: QueryPanelState): void {
  const running = s.phase === "running";
  const rowsShown = exportable(currentTab(), s.phase);
  const context = [
    chip({ text: s.platform, icon: "server-environment", title: "Platform" }),
    chip({ text: s.windowLabel, icon: "history", title: "Time window" }),
    chip({ text: `≤ ${s.limit.toLocaleString()} rows per tenant`, icon: "list-flat", title: "--limit" }),
    chip({
      text: s.tenants.length > 0 ? s.tenants.join(", ") : s.contacts,
      icon: "globe",
      tone: "info",
      title: `Contacts ${s.contacts}: the query runs on the tenant (read-only)`,
    }),
  ];
  const actions = [
    h("span", { id: "elapsed", class: "ot-hint", attrs: { "aria-live": "off" } }, [elapsedText(s)]),
    running
      ? button({
          label: "Cancel",
          icon: "debug-stop",
          focusKey: "cancel",
          onClick: () => channel.post("cancel", undefined),
        })
      : button({
          label: "Re-run",
          icon: "globe",
          focusKey: "rerun",
          title: `Run again: contacts ${s.contacts}`,
          disabled: !canStartRun(s.phase),
          onClick: () => channel.post("rerun", undefined),
        }),
    button({
      label: "Tenants and window…",
      variant: "secondary",
      icon: "settings",
      focusKey: "edit",
      disabled: !canStartRun(s.phase),
      onClick: () => channel.post("edit", undefined),
    }),
    menuButton({
      label: "Export",
      icon: "export",
      focusKey: "export",
      title: "Copy or export the rows shown (filtered and sorted)",
      disabled: !rowsShown,
      items: () => [
        { label: "Copy as CSV", icon: "copy", run: () => copyTable("csv") },
        { label: "Copy as JSON", icon: "json", run: () => copyTable("json") },
        { label: "Copy as Markdown", icon: "markdown", run: () => copyTable("markdown") },
        "separator",
        { label: "Export CSV…", icon: "save", run: () => exportTable("csv") },
        { label: "Export JSONL…", icon: "save", run: () => exportTable("jsonl") },
      ],
    }),
    button({
      label: s.locked ? "Unlock: the next query reuses this panel" : "Lock: keep these results here",
      variant: "icon",
      icon: s.locked ? "lock" : "unlock",
      pressed: s.locked,
      focusKey: "lock",
      onClick: () => channel.post("lock", !s.locked),
    }),
  ];
  replace(header, toolbar({ title: s.name || s.title, context, actions, label: "Query" }));
}

function elapsedText(s: QueryPanelState): string {
  if (s.phase === "running") {
    const waiting = s.tabs.filter((t) => t.status === "pending").map((t) => t.tenant);
    const time = formatMs(Date.now() - s.startedAt);
    return waiting.length > 0 ? `Running ${time} · waiting for ${waiting.join(", ")}` : `Running ${time}`;
  }
  if (s.phase === "choosing") return "Waiting for the tenant picker";
  if (s.durationMs !== null)
    return `${s.phase === "cancelled" ? "Cancelled after" : "Took"} ${formatMs(s.durationMs)}`;
  return "";
}

function renderElapsed(): void {
  const element = document.getElementById("elapsed");
  if (element && state) setText(element, elapsedText(state));
}

function currentTab(): TenantTab | undefined {
  return state?.tabs.find((t) => t.key === selected);
}

function copyTable(format: "csv" | "json" | "markdown"): void {
  const { columns, rows } = table.view();
  if (!state || !exportable(currentTab(), state.phase) || columns.length === 0) return;
  channel.post("copy", { format, text: formatRows(format, columns, rows) });
}

function exportTable(format: "csv" | "jsonl"): void {
  const tab = currentTab();
  const { columns, rows } = table.view();
  if (!state || !tab || !exportable(tab, state.phase) || columns.length === 0) return;
  const name = [tab.tenant, tab.label].filter(Boolean).join("-");
  channel.post("export", { format, text: formatRows(format, columns, rows), name });
}

const STATUS_ICONS = { ok: "pass", failed: "error", pending: "loading" } as const;

/** The tenant tabs, patched by key: a progress event changes one tab's icon and count. */
function renderTabs(): void {
  const s = state;
  if (!s) return;
  tabs.hidden = s.tabs.length === 0;
  const list = s.tabs;
  patchKeyed(
    tabs,
    list,
    (tab) => tab.key,
    (tab) => {
      const element = h("button", {
        class: "ot-tab",
        attrs: { type: "button", role: "tab", "aria-controls": "tabpanel" },
        on: {
          click: () => select(tab.key),
          keydown: (event) => {
            const keys = state?.tabs.map((t) => t.key) ?? [];
            const at = keys.indexOf(element.dataset.key ?? "");
            const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            const next =
              event.key === "Home"
                ? keys[0]
                : event.key === "End"
                  ? keys.at(-1)
                  : keys[(at + delta + keys.length) % keys.length];
            if (!delta && event.key !== "Home" && event.key !== "End") return;
            event.preventDefault();
            if (next) select(next, true);
          },
        },
      });
      element.append(
        h("span", { class: "tab-icon" }),
        h("strong", { class: "tab-name" }),
        h("span", { class: "ot-badge tab-count" }),
      );
      updateTab(element, tab);
      return element;
    },
    updateTab,
  );
}

function updateTab(element: HTMLElement, tab: TenantTab): void {
  const active = tab.key === selected;
  element.setAttribute("aria-selected", String(active));
  element.tabIndex = active ? 0 : -1;
  element.id = `tab-${cssId(tab.key)}`;
  element.title = tab.status === "failed" ? (tab.error ?? "failed") : tabSummary(tab);
  const iconElement = element.querySelector(".tab-icon");
  if (iconElement) {
    const spin = tab.status === "pending" ? " codicon-modifier-spin" : "";
    const className = `tab-icon codicon codicon-${STATUS_ICONS[tab.status]} ${tab.status}${spin}`;
    if (iconElement.className !== className) iconElement.className = className;
  }
  const name = element.querySelector(".tab-name");
  if (name) setText(name, tab.label ? `${tab.tenant} · ${tab.label}` : tab.tenant);
  const count = element.querySelector(".tab-count");
  if (count) {
    const n = tab.rowCount ?? tab.rows.length;
    setText(
      count,
      tab.status === "failed"
        ? "failed"
        : tab.status === "pending"
          ? "…"
          : `${n.toLocaleString()}${tab.truncated ? "+" : ""}`,
    );
    count.setAttribute("aria-label", tabSummary(tab));
  }
}

const cssId = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "_");

/** Show the table, or something in its place (the same height: no layout shift). */
function showTable(visible: boolean): void {
  tableHost.hidden = !visible;
  placeholder.hidden = visible;
  if (!visible) table.setData([], []);
}

function renderPanel(): void {
  const s = state;
  if (!s) return;
  const tab = currentTab();
  if (tab) panel.setAttribute("aria-labelledby", `tab-${cssId(tab.key)}`);
  else panel.removeAttribute("aria-labelledby");
  // Export acts on the selected tab's rows only.
  const rowsShown = exportable(tab, s.phase);
  const exportButton = header.querySelector<HTMLButtonElement>('[data-focus="export"]');
  if (exportButton) exportButton.disabled = !rowsShown;
  replace(tableFooter);
  replace(tableNotes);
  if (
    s.phase === "running" &&
    (!tab || tab.status === "pending" || s.tabs.every((t) => t.status !== "pending"))
  ) {
    // opentide sends the rows once every tenant has answered: skeleton rows until then.
    showTable(false);
    const answered = tab && tab.status !== "pending";
    replace(
      placeholder,
      answered
        ? callout({
            tone: "info",
            body:
              tab.status === "ok"
                ? `${tab.tenant} answered with ${(tab.rowCount ?? 0).toLocaleString()} row${tab.rowCount === 1 ? "" : "s"}. The rows appear when every tenant has answered.`
                : `${tab.tenant} failed. The other tenants are still running.`,
          })
        : null,
      skeletonRows({ rows: 14, columns: 5, label: `Waiting for ${tab?.tenant ?? s.contacts}` }),
    );
    return;
  }
  if (s.tabs.length === 0 || !tab) {
    showTable(false);
    if (s.phase === "running") {
      replace(placeholder, skeletonRows({ rows: 14, columns: 5, label: `Waiting for ${s.contacts}` }));
    } else if (s.phase === "choosing") {
      replace(
        placeholder,
        emptyState({
          icon: "organization",
          title: s.message,
          body: "The platform has several tenants: tick the ones to query in the picker.",
        }),
      );
    } else if (s.failure) {
      const failure = s.failure;
      replace(
        placeholder,
        errorState({
          title: failure.message || "The query did not run",
          code: failure.code,
          ...(failure.action
            ? { action: { label: failure.action, run: () => channel.post("action", failure.code) } }
            : {}),
          secondary: [{ label: "Tenants and window…", run: () => channel.post("edit", undefined) }],
          onShowOutput: () => channel.post("action", "output"),
        }),
      );
    } else {
      replace(placeholder, emptyState({ icon: "search", title: s.message || "No results" }));
    }
    return;
  }
  if (tab.status === "failed") {
    showTable(false);
    replace(placeholder, tenantError(tab), ...tab.warnings.map((w) => callout({ tone: "warning", body: w })));
    return;
  }
  replace(
    tableNotes,
    tab.truncated
      ? callout({
          tone: "info",
          body: `Showing ${tab.rows.length.toLocaleString()} rows: more matched than --limit ${s.limit}.`,
          actions:
            s.limit < s.maxLimit
              ? [
                  {
                    label: `Show up to ${nextLimit(s).toLocaleString()}`,
                    run: () => channel.post("rerun", { limit: nextLimit(s) }),
                  },
                ]
              : [],
        })
      : null,
    tab.partial ? callout({ tone: "warning", body: "Partial results: the platform stopped early." }) : null,
    ...tab.warnings.map((w) => callout({ tone: "warning", body: w })),
  );
  if (tab.rows.length === 0) {
    showTable(false);
    replace(
      placeholder,
      emptyState({ icon: "search", title: "No rows", body: `Nothing matched in ${s.windowLabel}.` }),
    );
    return;
  }
  showTable(true);
  table.setData(tab.columns, tab.rows);
  replace(
    tableFooter,
    button({
      label: "Copy cell",
      variant: "secondary",
      icon: "copy",
      title: "Ctrl+C in the table",
      onClick: () => {
        const text = table.focusedCell();
        if (text !== undefined) channel.post("copy", { format: "cell", text });
      },
    }),
    button({
      label: "Copy row",
      variant: "secondary",
      icon: "json",
      title: "Ctrl+Shift+C in the table",
      onClick: () => {
        const row = table.focusedRow();
        if (row) channel.post("copy", { format: "row", text: JSON.stringify(row) });
      },
    }),
    keyHint(
      "Arrow keys move · Shift+F10 cell menu · click a header to sort, drag its edge to resize · / filters",
    ),
  );
}

const nextLimit = (s: QueryPanelState) => Math.min(s.maxLimit, s.limit < 1000 ? 1000 : s.maxLimit);

/** A failed tenant: what it said, and the one thing to do about it. */
function tenantError(tab: TenantTab) {
  const credentials = tab.errorKind === "credentials" || tab.errorKind === "auth";
  const title =
    tab.errorKind === "credentials"
      ? `${tab.tenant} needs credentials`
      : tab.errorKind === "auth"
        ? `${tab.tenant} refused the credentials`
        : tab.errorKind === "network"
          ? `${tab.tenant} could not be reached`
          : `${tab.tenant} failed`;
  return errorState({
    title,
    body: tab.error ?? "No rows: the tenant reported no reason.",
    ...(tab.detail ? { code: tab.detail } : {}),
    action: credentials
      ? {
          label: "Set Credential…",
          icon: "key",
          run: () => channel.post("action", `credentials:${tab.tenant}`),
        }
      : { label: "Re-run", icon: "globe", run: () => channel.post("rerun", undefined) },
    onShowOutput: () => channel.post("action", "output"),
  });
}

function renderDetails(): void {
  const tab = currentTab();
  const s = state;
  if (!s || !tab || tab.status === "pending") {
    replace(details);
    return;
  }
  const rows: [string, string | null][] = [
    ["Tenant", tab.tenant],
    ["Language", tab.language],
    ["Elapsed", tab.elapsedMs === null ? null : formatMs(tab.elapsedMs)],
    ["Vendor query id", tab.vendorQueryId],
  ];
  const query = tab.sent ?? s.query;
  replace(
    details,
    collapsible({
      id: "details",
      title: "Details",
      open: detailsOpen,
      onToggle: (open) => {
        detailsOpen = open;
        saveView();
      },
      meta: [tab.vendorQueryId ? `query id ${tab.vendorQueryId}` : null],
      children: [
        h(
          "dl",
          { class: "ot-dl" },
          rows.flatMap(([name, value]) => (value ? [h("dt", { text: name }), h("dd", { text: value })] : [])),
        ),
        query
          ? h("div", {}, [
              h("div", { class: "ot-command-label", text: tab.sent ? "Query as sent" : "Query" }),
              h("pre", { class: "ot-code", text: query }),
            ])
          : null,
      ],
    }),
  );
}

function renderFooter(s: QueryPanelState): void {
  replace(
    footer,
    collapsible({
      id: "command",
      title: "Command",
      open: commandOpen,
      onToggle: (open) => {
        commandOpen = open;
        saveView();
      },
      meta: [icon("shield"), "Results stay in memory; only Export writes them to disk"],
      children: [
        h("div", { class: "ot-command" }, [
          h("code", { class: "ot-code", text: s.argvDisplay }),
          button({
            label: "Copy command",
            variant: "icon",
            icon: "copy",
            onClick: () => channel.post("copy", { format: "cell", text: s.argvDisplay }),
          }),
        ]),
        s.phase === "running" && s.cancelMayLeaveSearch
          ? h("p", {
              class: "ot-hint",
              text: "On Windows a search the platform started may keep running after Cancel.",
            })
          : null,
      ],
    }),
  );
}

function select(key: string, focus = false): void {
  selected = key;
  saveView();
  renderTabs();
  renderPanel();
  renderDetails();
  if (focus) tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}

addStyles(`
.region-panel { display: flex; flex-direction: column; margin-top: var(--ot-space-2); }
.region-placeholder { min-height: calc(var(--ot-table-height) + 40px); }
.region-placeholder > .ot-skeleton { margin-top: 40px; border: 1px solid var(--ot-border); border-radius: var(--ot-radius-1); }
.region-progress { margin: 0 calc(-1 * var(--ot-space-4)); }
.region-details, .region-footer { margin-top: var(--ot-space-2); }
.tab-count { min-width: 24px; }
`);
