// The query results panel (SPEC §10.4): progress per tenant, one tab per tenant, a virtual table.
import { formatRows } from "../../src/features/query/format";
import {
  type QueryPanelState,
  type QueryProtocol,
  type TenantTab,
  webviewValidators,
} from "../../src/features/query/protocol";
import { applyProgress, formatMs, tabSummary } from "../../src/features/query/results";
import { addStyles, announce, globeIcon, h, KIT_CSS, replace, stateBox } from "../panels-kit/dom";
import { VirtualTable } from "../panels-kit/table";
import { createChannel } from "../shared/channel";

addStyles(KIT_CSS + CSS());
const channel = createChannel<QueryProtocol>(webviewValidators);
const root = document.getElementById("root") ?? document.body;

let state: QueryPanelState | undefined;
let selected: string | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const table = new VirtualTable({
  label: "Query results",
  onCopy: (format, text) => channel.post("copy", { format, text }),
});

channel.on("state", (next) => {
  const previous = state;
  state = next;
  if (!selected || !next.tabs.some((t) => t.key === selected)) {
    selected = (next.tabs.find((t) => t.status === "ok") ?? next.tabs[0])?.key;
  }
  render();
  if (previous?.phase === "running" && next.phase !== "running") announce(next.message);
});

channel.on("progress", (progress) => {
  if (!state) return;
  state = { ...state, tabs: applyProgress(state.tabs, progress) };
  renderTabs();
  announce(`${progress.tenant}: ${progress.status === "ok" ? `${progress.rows ?? 0} rows` : "failed"}`);
});

channel.post("ready", undefined);
replace(root, stateBox({ kind: "loading", title: "Loading results…" }));

function render(): void {
  if (!state) return;
  const s = state;
  if (timer) clearInterval(timer);
  timer = s.phase === "running" ? setInterval(renderElapsed, 500) : undefined;
  const contacts = h("span", { class: "muted" }, [globeIcon(), ` Contacts ${s.contacts}`]);
  replace(
    root,
    h("header", {}, [
      h("h1", { text: s.title }),
      h("div", { class: "muted subline" }, [
        `${s.platform} · ${s.windowLabel} · up to ${s.limit} rows per tenant · `,
        contacts,
      ]),
    ]),
    s.writesPreviewAlerts
      ? h("div", {
          class: "banner",
          attrs: { role: "note" },
          text: "Elastic Kuery runs as a rule preview: the tenant writes the preview's alerts to its preview index. No rule is saved.",
        })
      : null,
    toolbar(s),
    h("div", { id: "tabs" }),
    h("div", { id: "tabpanel" }),
    h("footer", { class: "footer" }, [
      h("div", { class: "muted", text: "Command" }),
      h("code", { class: "cmdline", text: s.argvDisplay }),
      h("div", { class: "toolbar" }, [
        h("button", {
          class: "secondary",
          text: "Copy command",
          on: { click: () => channel.post("copy", { format: "cell", text: s.argvDisplay }) },
        }),
        h("span", {
          class: "muted",
          text: "Results stay in memory and are dropped when this panel closes; only Export writes them to disk.",
        }),
      ]),
    ]),
  );
  renderTabs();
}

function toolbar(s: QueryPanelState): HTMLElement {
  const running = s.phase === "running";
  return h("div", { class: "toolbar", attrs: { role: "toolbar", "aria-label": "Query" } }, [
    running
      ? h("button", { text: "◼ Cancel", on: { click: () => channel.post("cancel", undefined) } })
      : h(
          "button",
          {
            title: `Run again: contacts ${s.contacts}`,
            on: { click: () => channel.post("rerun", undefined) },
          },
          [globeIcon(), " Re-run"],
        ),
    h("button", {
      class: "secondary",
      text: "Tenants and window…",
      attrs: { disabled: running },
      on: { click: () => channel.post("edit", undefined) },
    }),
    h("span", { id: "elapsed", class: "muted", attrs: { "aria-live": "off" } }, [elapsedText(s)]),
    running && s.cancelMayLeaveSearch
      ? h("span", {
          class: "muted",
          text: "On Windows a search the platform started may keep running after Cancel.",
        })
      : null,
    h("span", { class: "spacer" }),
    ...(["csv", "json", "markdown"] as const).map((format) =>
      h("button", {
        class: "secondary",
        text: `Copy ${format === "markdown" ? "Markdown" : format.toUpperCase()}`,
        title: "Copy the rows shown (filtered and sorted)",
        attrs: { disabled: running },
        on: { click: () => copyTable(format) },
      }),
    ),
    ...(["csv", "jsonl"] as const).map((format) =>
      h("button", {
        class: "secondary",
        text: `Export ${format.toUpperCase()}…`,
        attrs: { disabled: running },
        on: { click: () => exportTable(format) },
      }),
    ),
  ]);
}

function elapsedText(s: QueryPanelState): string {
  if (s.phase === "running") return `running ${formatMs(Date.now() - s.startedAt)}`;
  if (s.durationMs !== null)
    return `${s.phase === "cancelled" ? "cancelled after" : "took"} ${formatMs(s.durationMs)}`;
  return "";
}

function renderElapsed(): void {
  const element = document.getElementById("elapsed");
  if (element && state) element.textContent = elapsedText(state);
}

function currentTab(): TenantTab | undefined {
  return state?.tabs.find((t) => t.key === selected);
}

function copyTable(format: "csv" | "json" | "markdown"): void {
  const { columns, rows } = table.view();
  if (!currentTab() || columns.length === 0) return;
  channel.post("copy", { format, text: formatRows(format, columns, rows) });
}

function exportTable(format: "csv" | "jsonl"): void {
  const tab = currentTab();
  const { columns, rows } = table.view();
  if (!tab || columns.length === 0) return;
  const name = [tab.tenant, tab.label].filter(Boolean).join("-");
  channel.post("export", { format, text: formatRows(format, columns, rows), name });
}

function renderTabs(): void {
  const s = state;
  const tabsElement = document.getElementById("tabs");
  const panel = document.getElementById("tabpanel");
  if (!s || !tabsElement || !panel) return;
  if (s.tabs.length === 0) {
    replace(tabsElement);
    if (s.phase === "running") {
      replace(panel, stateBox({ kind: "loading", title: "Running…", body: `Waiting for ${s.contacts}.` }));
    } else if (s.failure) {
      const actions = [
        ...(s.failure.action
          ? [{ label: s.failure.action, run: () => channel.post("action", s.failure?.code ?? "") }]
          : []),
        { label: "Tenants and window…", run: () => channel.post("edit", undefined), secondary: true },
        { label: "Show output", run: () => channel.post("action", "output"), secondary: true },
      ];
      replace(panel, stateBox({ kind: "error", title: s.failure.message, body: s.failure.code, actions }));
    } else {
      replace(panel, stateBox({ kind: "empty", title: s.message || "No results" }));
    }
    return;
  }
  const buttons = s.tabs.map((tab, index) => {
    const active = tab.key === selected;
    const glyphs = { ok: "✓", failed: "✕", pending: "◌" };
    return h(
      "button",
      {
        class: `tab chip ${tab.status}${active ? " active" : ""}`,
        attrs: {
          role: "tab",
          "aria-selected": active ? "true" : "false",
          "aria-controls": "tabpanel",
          tabindex: active ? 0 : -1,
          id: `tab-${index}`,
        },
        on: {
          click: () => select(tab.key),
          keydown: (event) => {
            const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!delta) return;
            event.preventDefault();
            const next = s.tabs[(index + delta + s.tabs.length) % s.tabs.length];
            if (next) select(next.key, true);
          },
        },
      },
      [
        h("span", {
          class: tab.status === "pending" ? "spin" : "",
          text: glyphs[tab.status],
          attrs: { "aria-hidden": "true" },
        }),
        h("strong", { text: tab.label ? `${tab.tenant} · ${tab.label}` : tab.tenant }),
        h("span", { text: tabSummary(tab) }),
      ],
    );
  });
  replace(
    tabsElement,
    h("div", { class: "tablist", attrs: { role: "tablist", "aria-label": "Tenants" } }, buttons),
  );
  const tab = currentTab();
  if (!tab) return;
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", `tab-${s.tabs.indexOf(tab)}`);
  if (tab.status === "pending") {
    replace(panel, stateBox({ kind: "loading", title: `Waiting for ${tab.tenant}…` }));
    return;
  }
  if (tab.status === "failed") {
    replace(
      panel,
      h("section", { class: "banner error", attrs: { role: "alert" } }, [
        h("h2", { text: `${tab.tenant} failed` }),
        h("p", { text: tab.error ?? "No rows: the tenant reported no reason." }),
        tab.detail ? h("pre", { class: "cmdline", text: tab.detail }) : null,
        ...tab.warnings.map((w) => h("p", { class: "warning", text: `warning: ${w}` })),
      ]),
      details(tab),
    );
    return;
  }
  const notes: (HTMLElement | null)[] = [
    tab.truncated
      ? h("div", { class: "banner info" }, [
          `Showing ${tab.rows.length} rows: more matched than --limit ${s.limit}. `,
          s.limit < s.maxLimit
            ? h("button", {
                class: "link",
                text: `Show up to ${Math.min(s.maxLimit, s.limit < 1000 ? 1000 : s.maxLimit)}`,
                on: {
                  click: () =>
                    channel.post("rerun", {
                      limit: Math.min(s.maxLimit, s.limit < 1000 ? 1000 : s.maxLimit),
                    }),
                },
              })
            : null,
        ])
      : null,
    tab.partial ? h("div", { class: "banner", text: "Partial results: the platform stopped early." }) : null,
    ...tab.warnings.map((w) => h("div", { class: "banner", text: w })),
  ];
  const copyFocused = h("div", { class: "toolbar" }, [
    h("button", {
      class: "secondary",
      text: "Copy cell",
      title: "Ctrl+C in the table",
      on: { click: () => channel.post("copy", { format: "cell", text: table.focusedCell() ?? "" }) },
    }),
    h("button", {
      class: "secondary",
      text: "Copy row",
      title: "Ctrl+Shift+C in the table",
      on: {
        click: () => channel.post("copy", { format: "row", text: JSON.stringify(table.focusedRow() ?? {}) }),
      },
    }),
    h("span", { class: "muted", text: "Arrow keys move between cells · click a header to sort" }),
  ]);
  if (tab.rows.length === 0) {
    replace(
      panel,
      ...notes,
      stateBox({ kind: "empty", title: "No rows", body: `Nothing matched in ${s.windowLabel}.` }),
      details(tab),
    );
    return;
  }
  replace(panel, ...notes, table.element, copyFocused, details(tab));
  table.setData(tab.columns, tab.rows);
}

function details(tab: TenantTab): HTMLElement {
  const rows: [string, string | null][] = [
    ["Language", tab.language],
    ["Elapsed", tab.elapsedMs === null ? null : formatMs(tab.elapsedMs)],
    ["Vendor query id", tab.vendorQueryId],
  ];
  return h("details", { class: "drawer" }, [
    h("summary", { text: "Details" }),
    h(
      "dl",
      {},
      rows.flatMap(([name, value]) => (value ? [h("dt", { text: name }), h("dd", { text: value })] : [])),
    ),
    tab.sent || state?.query
      ? h("div", {}, [
          h("div", { class: "muted", text: tab.sent ? "Query as sent" : "Query" }),
          h("pre", { class: "cmdline", text: tab.sent ?? state?.query ?? "" }),
        ])
      : null,
  ]);
}

function select(key: string, focus = false): void {
  selected = key;
  renderTabs();
  if (focus) document.querySelector<HTMLElement>('.tablist [aria-selected="true"]')?.focus();
}

function CSS(): string {
  return `
.subline { display: flex; flex-wrap: wrap; gap: 4px; }
.tablist { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.tab { cursor: pointer; font: inherit; }
.tab.active { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
#tabpanel { display: flex; flex-direction: column; }
.drawer { margin-top: 8px; }
.drawer dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; }
.drawer dt { color: var(--vscode-descriptionForeground); }
.drawer dd { margin: 0; font-family: var(--vscode-editor-font-family); }
`;
}
