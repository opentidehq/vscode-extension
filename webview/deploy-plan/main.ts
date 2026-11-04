// The deploy plan panel (SPEC §10.5): what `deploy --dry-run` would change, per platform and tenant.
// There is no Deploy button (D6): the footer copies the command for a terminal or CI.
import type { PlanView, PlatformPlan } from "../../src/features/deploy-plan/plan";
import {
  type DeployPanelState,
  type DeployPlanProtocol,
  noPlanBox,
  type ScopeKind,
  type Strategy,
  webviewValidators,
} from "../../src/features/deploy-plan/protocol";
import { formatMs } from "../../src/features/query/results";
import { addStyles, announce, h, KIT_CSS, replace, stateBox } from "../panels-kit/dom";
import { createChannel } from "../shared/channel";

addStyles(KIT_CSS + PLAN_CSS());
const channel = createChannel<DeployPlanProtocol>(webviewValidators);
const root = document.getElementById("root") ?? document.body;
let state: DeployPanelState | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

channel.on("state", (next) => {
  const was = state?.phase;
  state = next;
  render();
  if (was === "running" && next.phase !== "running")
    announce(next.plan?.message ?? next.failure?.message ?? "Done");
});
channel.on("progress", (step) => {
  const element = document.getElementById("progress");
  if (element) element.textContent = `Planning ${step}…`;
});
replace(root, stateBox({ kind: "loading", title: "Planning…" }));
channel.post("ready", undefined);

const ACTION_LABELS: Readonly<Record<string, string>> = {
  create: "+ create",
  update: "~ update",
  upsert: "± create or update",
  disable: "− disable",
  delete: "× delete",
};

function request(
  change: Partial<{ strategies: Strategy[]; scope: ScopeKind; platform: string | null }>,
): void {
  if (!state) return;
  channel.post("run", {
    strategies: change.strategies ?? [...state.strategies],
    scope: change.scope ?? state.scope,
    platform: change.platform === undefined ? state.platform : change.platform,
  });
}

function render(): void {
  const s = state;
  if (!s) return;
  if (timer) clearInterval(timer);
  timer =
    s.phase === "running"
      ? setInterval(() => {
          const element = document.getElementById("elapsed");
          if (element && state) element.textContent = formatMs(Date.now() - state.startedAt);
        }, 500)
      : undefined;
  replace(
    root,
    h("header", {}, [
      h("h1", { text: "Deploy plan" }),
      h("p", {
        class: "muted",
        text: "A dry run: opentide compiles each rule and shows what a deploy would send. Nothing is sent from the editor; CI deploys.",
      }),
    ]),
    controls(s),
    s.note ? h("div", { class: "banner info", text: s.note }) : null,
    body(s),
    footer(s),
  );
}

function controls(s: DeployPanelState): HTMLElement {
  const running = s.phase === "running";
  const strategyValue = s.strategies.length === 2 ? "both" : (s.strategies[0] ?? "PREVIEW");
  const scopes: [ScopeKind, string, boolean][] = [
    ["changed", "Changed rules", true],
    ["all", "All rules", true],
    ["selected", s.selection ? `Only ${s.selection}` : "Selected rules", s.canSelect && s.selection !== null],
  ];
  return h("div", { class: "toolbar", attrs: { role: "toolbar", "aria-label": "Plan options" } }, [
    h("label", {}, [
      "Strategy ",
      h(
        "select",
        {
          attrs: { disabled: running },
          on: {
            change: (event) => {
              const value = (event.target as HTMLSelectElement).value;
              request({ strategies: value === "both" ? ["PREVIEW", "RELEASE"] : [value as Strategy] });
            },
          },
        },
        [
          ["PREVIEW", "PREVIEW"],
          ["RELEASE", "RELEASE"],
          ["both", "PREVIEW and RELEASE"],
        ].map(([value, text]) => h("option", { text, attrs: { value, selected: value === strategyValue } })),
      ),
    ]),
    h(
      "div",
      { class: "segmented", attrs: { role: "radiogroup", "aria-label": "Scope" } },
      scopes.map(([kind, text, enabled]) =>
        h("button", {
          class: kind === s.scope ? "" : "secondary",
          text,
          title:
            kind === "selected" && !s.canSelect
              ? "Needs an opentide whose deploy has --uuid and --file (opentide#753)"
              : kind === "changed"
                ? "The rule files the last commit (or the pull request) changed, as CI deploys them"
                : "",
          attrs: {
            role: "radio",
            "aria-checked": kind === s.scope ? "true" : "false",
            disabled: running || !enabled,
          },
          on: { click: () => request({ scope: kind }) },
        }),
      ),
    ),
    h("label", {}, [
      "Platform ",
      h(
        "select",
        {
          attrs: { disabled: running },
          on: { change: (event) => request({ platform: (event.target as HTMLSelectElement).value || null }) },
        },
        [["", "All"], ...s.platforms.map((p) => [p, p])].map(([value, text]) =>
          h("option", { text, attrs: { value, selected: (s.platform ?? "") === value } }),
        ),
      ),
    ]),
    h("span", { class: "spacer" }),
    running
      ? h("span", { class: "muted" }, [
          h("span", { class: "spin", text: "◌", attrs: { "aria-hidden": "true" } }),
          " ",
          h("span", { id: "progress", text: s.progress ? `Planning ${s.progress}…` : "Planning…" }),
          " ",
          h("span", { id: "elapsed" }),
        ])
      : s.durationMs !== null
        ? h("span", {
            class: "muted",
            text: `${s.phase === "cancelled" ? "Cancelled after" : "Planned in"} ${formatMs(s.durationMs)}`,
          })
        : null,
    running
      ? h("button", { text: "◼ Cancel", on: { click: () => channel.post("cancel", undefined) } })
      : h("button", { text: "⟳ Preview again", on: { click: () => request({}) } }),
  ]);
}

function body(s: DeployPanelState): HTMLElement {
  if (s.failure) {
    return stateBox({
      kind: "error",
      title: s.failure.message || "The dry run failed",
      body: s.failure.code,
      actions: [
        { label: "Show output", run: () => channel.post("action", "output") },
        ...(s.failure.code === "untrusted" || s.failure.code === "no-runtime"
          ? [
              {
                label: "Switch runtime…",
                run: () => channel.post("action", "switchRuntime"),
                secondary: true,
              },
            ]
          : []),
      ],
    });
  }
  const plan = s.plan;
  if (!plan) {
    const box = noPlanBox(s);
    return stateBox(
      box.kind === "info" ? { ...box, actions: [{ label: "Preview again", run: () => request({}) }] } : box,
    );
  }
  const dim = s.phase === "running" ? " stale" : "";
  return h("div", { class: `plan${dim}`, attrs: { "aria-busy": s.phase === "running" ? "true" : "false" } }, [
    summary(plan),
    plan.unmatched.length
      ? h("div", { class: "banner error", attrs: { role: "alert" } }, [
          `No rule matches ${plan.unmatched.join(", ")}. `,
          "Only rule files directly in the rules folder can be selected.",
        ])
      : null,
    ...plan.warnings.map((w) => h("div", { class: "banner", text: w })),
    plan.detail ? h("p", { class: "muted", text: plan.detail }) : null,
    plan.diagnostics.length
      ? h("section", {}, [
          h("h2", { text: `Would fail to compile (${plan.diagnostics.length})` }),
          h("p", { class: "muted", text: "Also in Problems, under opentide deploy." }),
          h(
            "ul",
            { class: "list" },
            plan.diagnostics.map((d) =>
              h("li", {}, [
                h("span", {
                  class: d.severity === "error" ? "error" : "warning",
                  text: `${d.severity}[${d.code}] `,
                }),
                h("button", {
                  class: "link",
                  text: d.name ?? d.path ?? d.uuid ?? "rule",
                  on: { click: () => channel.post("open", d.uuid ?? d.path ?? "") },
                }),
                ` on ${d.platform}: ${d.message}`,
                d.help ? h("div", { class: "muted", text: `help: ${d.help}` }) : null,
              ]),
            ),
          ),
        ])
      : null,
    ...plan.platforms.map((p) => platformSection(p, s)),
    plan.platforms.length === 0 && plan.unmatched.length === 0
      ? stateBox({
          kind: "empty",
          title: plan.message || "Nothing to deploy",
          ...(plan.advice ? { body: plan.advice } : {}),
          actions:
            s.scope === "changed"
              ? [{ label: "Preview all rules", run: () => request({ scope: "all" }) }]
              : [],
        })
      : null,
    plan.skipped.length
      ? h("details", { class: "skipped" }, [
          h("summary", { text: `Skipped (${plan.skipped.length}): no run strategy deploys their status` }),
          h("table", {}, [
            h(
              "tr",
              {},
              ["Rule", "Platform", "Status", "Maps to"].map((t) => h("th", { text: t })),
            ),
            ...plan.skipped.slice(0, 500).map((row) =>
              h("tr", {}, [
                h("td", {}, [
                  h("button", {
                    class: "link",
                    text: row.rule,
                    on: { click: () => channel.post("open", row.uuid) },
                  }),
                ]),
                h("td", { text: row.platform }),
                h("td", { text: row.status }),
                h("td", { text: row.strategy }),
              ]),
            ),
          ]),
          plan.skipped.length > 500
            ? h("p", { class: "muted", text: `and ${plan.skipped.length - 500} more` })
            : null,
        ])
      : null,
  ]);
}

function summary(plan: PlanView): HTMLElement {
  const c = plan.counts;
  return h("section", { class: "summary", attrs: { "aria-label": "Plan summary" } }, [
    h("strong", { text: plan.message }),
    h(
      "div",
      { class: "toolbar" },
      (["create", "update", "upsert", "disable", "delete"] as const).map((action) =>
        h("span", { class: `chip action-${action}`, text: `${ACTION_LABELS[action]} ${c[action]}` }),
      ),
    ),
    plan.strategies.length
      ? h("span", { class: "muted", text: `strategy ${plan.strategies.join(", ")}` })
      : null,
  ]);
}

function platformSection(p: PlatformPlan, s: DeployPanelState): HTMLElement {
  const changes = p.tenants.reduce((n, t) => n + t.changes.length, 0);
  const tenants = p.tenants.filter((t) => t.tenant).length;
  const payloadByUuid = new Map(p.payloads.map((row) => [row.uuid, row]));
  return h("details", { class: "platform", attrs: { open: true } }, [
    h("summary", {}, [
      h("strong", { text: p.platform }),
      h("span", {
        class: "muted",
        text: ` · ${tenants} tenant${tenants === 1 ? "" : "s"} · ${changes} change${changes === 1 ? "" : "s"}`,
      }),
    ]),
    p.missingTenants
      ? h("div", { class: "banner" }, [
          `No tenant configured in ${p.missingTenants}: a real deploy would stop here. `,
          h("button", {
            class: "link",
            text: "Open configuration",
            on: { click: () => channel.post("action", `configure:${p.platform}`) },
          }),
        ])
      : null,
    ...p.tenants.map((tenant) =>
      h("section", { class: "tenant" }, [
        h("h3", { text: tenant.tenant ?? "(no tenant yet)" }),
        h("table", { class: "changes" }, [
          h(
            "tr",
            {},
            ["Action", "Rule", "Status", ""].map((t) => h("th", { text: t })),
          ),
          ...tenant.changes.map((change) => {
            const payload = payloadByUuid.get(change.uuid);
            const focused = s.focus.includes(change.uuid);
            return h("tr", { class: `${focused ? "focus" : ""}${change.fails ? " fails" : ""}` }, [
              h("td", {
                class: `action-${change.action}`,
                text: ACTION_LABELS[change.action] ?? change.action,
              }),
              h("td", {}, [
                h("button", {
                  class: "link",
                  text: change.name,
                  title: change.uuid,
                  on: { click: () => channel.post("open", change.uuid) },
                }),
                focused ? h("span", { class: "badge", text: "this rule" }) : null,
                change.fails ? h("span", { class: "error", text: " · would fail to compile" }) : null,
              ]),
              h("td", { text: change.status }),
              h("td", {}, [
                payload?.hasRequest
                  ? h("button", {
                      class: "secondary icon",
                      text: "Payload",
                      title: "Open the API request as a read-only JSON document",
                      on: { click: () => channel.post("payload", payload.key) },
                    })
                  : null,
                payload?.hasDeployed
                  ? h("button", {
                      class: "secondary icon",
                      text: "Diff",
                      title: "Compare with what is deployed",
                      on: { click: () => channel.post("diff", payload.key) },
                    })
                  : null,
              ]),
            ]);
          }),
        ]),
      ]),
    ),
    p.payloads.some((row) => row.failed)
      ? h(
          "ul",
          { class: "list" },
          p.payloads
            .filter((row) => row.failed)
            .map((row) =>
              h("li", { class: "error" }, [
                `${row.name}: ${row.error ?? "could not compile"}`,
                row.help ? h("div", { class: "muted", text: `help: ${row.help}` }) : null,
              ]),
            ),
        )
      : null,
  ]);
}

function footer(s: DeployPanelState): HTMLElement {
  return h("footer", { class: "footer" }, [
    h("div", { class: "muted", text: "This preview ran" }),
    h("code", { class: "cmdline", text: s.argvDisplay }),
    h("div", {
      class: "muted",
      text: "To deploy, run this in a terminal or in CI (the editor never deploys)",
    }),
    h("code", { class: "cmdline", text: s.deployCommand }),
    h("div", { class: "toolbar" }, [
      h("button", {
        class: "secondary",
        text: "Copy deploy command",
        on: { click: () => channel.post("copy", "deploy") },
      }),
      h("button", {
        class: "secondary",
        text: "Copy as CI step",
        on: { click: () => channel.post("copy", "ci") },
      }),
      h("button", {
        class: "secondary",
        text: "Copy dry-run command",
        on: { click: () => channel.post("copy", "dryRun") },
      }),
    ]),
  ]);
}

function PLAN_CSS(): string {
  return `
.segmented { display: inline-flex; gap: 0; }
.segmented button { border-radius: 0; }
.segmented button:first-child { border-radius: 2px 0 0 2px; }
.segmented button:last-child { border-radius: 0 2px 2px 0; }
.summary { margin: 8px 0; }
.plan.stale { opacity: 0.6; }
.platform { margin: 10px 0; }
.platform > summary { font-size: 1.05em; padding: 4px 0; }
.tenant { margin-left: 16px; }
table.changes { width: 100%; }
table.changes tr.focus td:first-child { box-shadow: inset 3px 0 var(--vscode-focusBorder); }
table.changes tr.focus .badge { margin-left: 6px; }
table.changes tr.focus { background: var(--vscode-editor-findMatchHighlightBackground, var(--vscode-list-inactiveSelectionBackground)); }
.action-create { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green)); }
.action-update, .action-upsert { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-blue)); }
.action-disable { color: var(--vscode-editorWarning-foreground); }
.action-delete { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground)); }
.chip[class*="action-"] { background: transparent; }
.list { padding-left: 18px; }
.skipped table { margin-top: 6px; }
`;
}
