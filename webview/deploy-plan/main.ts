// The deploy plan panel (SPEC §10.5): what `deploy --dry-run` would change, per platform and tenant.
// There is no Deploy button (D6): the Commands section copies the command for a terminal or CI.
// The page's regions are built once; platform sections are patched by key and rebuilt only when their
// part of the plan changed, so a re-run keeps what is open and where the focus is.
import {
  badge,
  button,
  callout,
  chip,
  collapsible,
  emptyState,
  errorState,
  progressBar,
  segmented,
  statCard,
  toolbar,
} from "../../src/core/webview/kit/components";
import { fingerprint } from "../../src/core/webview/kit/keyed";
import type { ChangeRow, PlanView, PlatformPlan, TenantPlan } from "../../src/features/deploy-plan/plan";
import {
  type DeployPanelState,
  type DeployPlanProtocol,
  noPlanBox,
  type ScopeKind,
  type Strategy,
  webviewValidators,
} from "../../src/features/deploy-plan/protocol";
import { formatMs } from "../../src/features/query/results";
import { addStyles, announce, h, mount, patchKeyed, replace, setText } from "../panels-kit/dom";
import { virtualList } from "../panels-kit/list";
import { createChannel, vscodeApi } from "../shared/channel";

const channel = createChannel<DeployPlanProtocol>(webviewValidators);
const root = document.getElementById("root") ?? document.body;
let state: DeployPanelState | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

/** Which sections are open, by key (kept across reloads of the page). */
const savedOpen = (vscodeApi().getState() as { open?: Record<string, boolean> } | undefined)?.open;
const open: Record<string, boolean> =
  typeof savedOpen === "object" && savedOpen !== null ? { ...savedOpen } : {};
const isOpen = (key: string, fallback: boolean) => open[key] ?? fallback;
const setOpen = (key: string, value: boolean) => {
  open[key] = value;
  vscodeApi().setState({ open });
};

const header = h("div");
const controls = h("div");
const progress = h("div", { class: "region-progress" });
const notes = h("div");
const summary = h("div");
const problems = h("div");
const platforms = h("div", { class: "platforms" });
const skipped = h("div");
const commands = h("div");
replace(root, header, controls, progress, notes, summary, problems, platforms, skipped, commands);

const ACTIONS = ["create", "update", "upsert", "disable", "delete"] as const;
const ACTION_LABELS: Readonly<Record<string, string>> = {
  create: "create",
  update: "update",
  upsert: "create or update",
  disable: "disable",
  delete: "delete",
};
const ACTION_ICONS: Readonly<Record<string, string>> = {
  create: "diff-added",
  update: "diff-modified",
  upsert: "diff-modified",
  disable: "circle-slash",
  delete: "diff-removed",
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

/** Before the first state: the layout's shape (cards and sections as placeholders). */
function renderLoading(): void {
  replace(header, toolbar({ title: "Deploy plan", context: [chip({ text: "dry run", icon: "shield" })] }));
  replace(progress, progressBar({ active: true, label: "Planning" }));
  replace(summary, cardsPlaceholder());
}

function cardsPlaceholder() {
  return h(
    "div",
    { class: "ot-cards", attrs: { "aria-hidden": "true" } },
    ACTIONS.map((action) => statCard({ label: ACTION_LABELS[action] ?? action, value: "–", dim: true })),
  );
}

function render(): void {
  const s = state;
  if (!s) return;
  if (timer) clearInterval(timer);
  timer =
    s.phase === "running"
      ? setInterval(() => {
          const element = document.getElementById("elapsed");
          if (element && state) setText(element, formatMs(Date.now() - state.startedAt));
        }, 250)
      : undefined;
  renderHeader(s);
  renderControls(s);
  replace(progress, progressBar({ active: s.phase === "running", label: "Planning the deploy" }));
  replace(notes, s.note ? callout({ tone: "info", body: s.note }) : null);
  renderBody(s);
  renderCommands(s);
}

function label(s: DeployPanelState, platform: string): string {
  return s.platformLabels[platform] ?? platform;
}

function renderHeader(s: DeployPanelState): void {
  const running = s.phase === "running";
  const scope =
    s.scope === "selected"
      ? (s.selection ?? "selected rules")
      : s.scope === "all"
        ? "all rules"
        : "changed rules";
  const context = [
    chip({ text: s.folderName, icon: "folder", title: s.folder }),
    chip({ text: scope, icon: s.scope === "selected" ? "file-code" : "files", title: "Scope" }),
    chip({ text: s.strategies.join(" + "), icon: "rocket", title: "Strategy" }),
    chip({
      text: "dry run · nothing is sent",
      icon: "shield",
      tone: "ok",
      title:
        "opentide compiles each rule and shows what a deploy would send. No credentials are needed; CI deploys.",
    }),
  ];
  const status = running
    ? h("span", { class: "ot-hint", attrs: { "aria-live": "off" } }, [
        h("span", { id: "progress-step", text: s.progress ? `Planning ${s.progress}…` : "Planning…" }),
        " ",
        h("span", { id: "elapsed" }),
      ])
    : s.durationMs !== null
      ? h("span", {
          class: "ot-hint",
          text: `${s.phase === "cancelled" ? "Cancelled after" : "Planned in"} ${formatMs(s.durationMs)}`,
        })
      : null;
  replace(
    header,
    toolbar({
      title: "Deploy plan",
      context,
      label: "Plan",
      actions: [
        status,
        running
          ? button({
              label: "Cancel",
              icon: "debug-stop",
              focusKey: "cancel",
              onClick: () => channel.post("cancel", undefined),
            })
          : button({
              label: "Preview again",
              icon: "refresh",
              focusKey: "rerun",
              onClick: () => request({}),
            }),
        button({
          label: s.locked ? "Unlock: the next preview reuses this panel" : "Lock: keep this plan here",
          variant: "icon",
          icon: s.locked ? "lock" : "unlock",
          pressed: s.locked,
          focusKey: "lock",
          onClick: () => channel.post("lock", !s.locked),
        }),
      ],
    }),
  );
}

function renderControls(s: DeployPanelState): void {
  const running = s.phase === "running";
  const strategyValue = s.strategies.length === 2 ? "both" : (s.strategies[0] ?? "PREVIEW");
  replace(
    controls,
    h("div", { class: "ot-bar", attrs: { role: "group", "aria-label": "Plan options" } }, [
      segmented({
        name: "scope",
        label: "Scope",
        value: s.scope,
        disabled: running,
        options: [
          {
            value: "changed",
            label: "Changed",
            icon: "git-compare",
            title: "The rule files the last commit (or the pull request) changed, as CI deploys them",
          },
          { value: "all", label: "All", icon: "files", title: "Every rule (--all)" },
          {
            value: "selected",
            label: s.selection ? `Only ${s.selection}` : "Only this rule",
            icon: "file-code",
            disabled: !s.canSelect || s.selection === null,
            title: !s.canSelect
              ? "Needs an opentide whose deploy has --uuid and --file (opentide#753)"
              : s.selection === null
                ? "Preview from a rule (its editor, the catalogue or search) to plan only that rule"
                : `--uuid / --file: ${s.selection}`,
          },
        ],
        onChange: (scope) => request({ scope: scope as ScopeKind }),
      }),
      segmented({
        name: "strategy",
        label: "Strategy",
        value: strategyValue,
        disabled: running,
        options: [
          { value: "PREVIEW", label: "PREVIEW" },
          { value: "RELEASE", label: "RELEASE" },
          { value: "both", label: "Both" },
        ],
        onChange: (value) =>
          request({ strategies: value === "both" ? ["PREVIEW", "RELEASE"] : [value as Strategy] }),
      }),
      h("span", { class: "ot-spacer" }),
      h("label", {}, [
        "Platform",
        h(
          "select",
          {
            attrs: { disabled: running, "data-focus": "platform" },
            on: {
              change: (event) => request({ platform: (event.target as HTMLSelectElement).value || null }),
            },
          },
          [["", "All platforms"], ...s.platforms.map((p) => [p, label(s, p)])].map(([value, text]) =>
            h("option", { text, attrs: { value, selected: (s.platform ?? "") === value } }),
          ),
        ),
      ]),
    ]),
  );
}

function renderBody(s: DeployPanelState): void {
  if (s.failure) {
    const failure = s.failure;
    const runtime = failure.code === "untrusted" || failure.code === "no-runtime";
    replace(
      summary,
      errorState({
        title: failure.message || "The dry run failed",
        code: failure.code,
        ...(runtime
          ? { action: { label: "Switch runtime…", run: () => channel.post("action", "switchRuntime") } }
          : {}),
        secondary: runtime ? [] : [{ label: "Preview again", icon: "refresh", run: () => request({}) }],
        onShowOutput: () => channel.post("action", "output"),
      }),
    );
    clearPlan();
    return;
  }
  const plan = s.plan;
  if (!plan) {
    const box = noPlanBox(s);
    replace(
      summary,
      box.kind === "info"
        ? emptyState({
            icon: "circle-slash",
            title: box.title,
            body: box.body,
            action: { label: "Preview again", icon: "refresh", run: () => request({}) },
          })
        : cardsPlaceholder(),
    );
    clearPlan();
    return;
  }
  const stale = s.phase === "running";
  document.body.classList.toggle("stale", stale);
  root.setAttribute("aria-busy", String(stale));
  renderSummary(plan);
  renderProblems(plan);
  renderPlatforms(s, plan);
  renderSkipped(plan);
}

function clearPlan(): void {
  replace(problems);
  replace(platforms);
  replace(skipped);
}

function renderSummary(plan: PlanView): void {
  const c = plan.counts;
  const total = ACTIONS.reduce((n, a) => n + c[a], 0);
  replace(
    summary,
    h("section", { class: "summary", attrs: { "aria-label": "Plan summary" } }, [
      total > 0 ? h("p", { class: "summary-message", text: plan.message }) : null,
      h(
        "div",
        { class: "ot-cards" },
        ACTIONS.map((action) =>
          statCard({
            label: ACTION_LABELS[action] ?? action,
            value: c[action],
            icon: ACTION_ICONS[action],
            tone: action,
            dim: c[action] === 0,
          }),
        ),
      ),
      total === 0 && plan.platforms.length === 0 && plan.unmatched.length === 0
        ? emptyState({
            icon: "check-all",
            title: plan.message || "Nothing to deploy",
            ...(plan.advice ? { body: plan.advice } : {}),
            ...(state?.scope === "changed"
              ? {
                  action: { label: "Preview all rules", icon: "files", run: () => request({ scope: "all" }) },
                }
              : {}),
          })
        : null,
    ]),
  );
}

function renderProblems(plan: PlanView): void {
  replace(
    problems,
    plan.unmatched.length
      ? callout({
          tone: "error",
          title: "No rule matches.",
          body: `${plan.unmatched.join(", ")}: only rule files directly in the rules folder can be selected.`,
        })
      : null,
    ...plan.warnings.map((w) => callout({ tone: "warning", body: w })),
    plan.detail ? h("p", { class: "ot-hint", text: plan.detail }) : null,
    plan.diagnostics.length
      ? collapsible({
          id: "diagnostics",
          title: "Would fail to compile",
          count: plan.diagnostics.length,
          tone: "error",
          open: isOpen("diagnostics", true),
          onToggle: (value) => setOpen("diagnostics", value),
          meta: ["Also in Problems, under opentide deploy"],
          children: [
            h(
              "ul",
              { class: "plain" },
              plan.diagnostics.map((d) =>
                h("li", {}, [
                  badge(`${d.severity} ${d.code}`, d.severity === "error" ? "error" : "warning"),
                  " ",
                  ruleLink(d.name ?? d.path ?? d.uuid ?? "rule", d.uuid ?? d.path ?? ""),
                  h("span", { class: "muted", text: ` on ${d.platform}: ` }),
                  d.message,
                  d.help ? h("div", { class: "ot-hint", text: `help: ${d.help}` }) : null,
                ]),
              ),
            ),
          ],
        })
      : null,
  );
}

function ruleLink(text: string, ref: string, title?: string): HTMLElement {
  return mount(
    button({
      label: text,
      variant: "link",
      ...(title ? { title } : {}),
      onClick: () => channel.post("open", ref),
    }),
  );
}

/** Platform sections, patched by key: unchanged ones (and their open state) stay as they are. */
function renderPlatforms(s: DeployPanelState, plan: PlanView): void {
  patchKeyed(
    platforms,
    plan.platforms,
    (p) => p.platform,
    (p) => {
      const element = h("div", { class: "platform-host" });
      fillPlatform(element, p, s);
      return element;
    },
    (element, p) => {
      if (element.dataset.fp !== platformFingerprint(p, s)) fillPlatform(element, p, s);
    },
  );
}

const platformFingerprint = (p: PlatformPlan, s: DeployPanelState) => fingerprint([p, s.focus]);

function fillPlatform(element: HTMLElement, p: PlatformPlan, s: DeployPanelState): void {
  element.dataset.fp = platformFingerprint(p, s);
  const changes = p.tenants.reduce((n, t) => n + t.changes.length, 0);
  const tenants = p.tenants.filter((t) => t.tenant).length;
  const failed = p.payloads.filter((row) => row.failed);
  const key = `platform:${p.platform}`;
  replace(
    element,
    collapsible({
      id: key,
      title: label(s, p.platform),
      count: changes,
      countLabel: "changes",
      open: isOpen(key, true),
      onToggle: (value) => setOpen(key, value),
      tone: p.missingTenants ? "warning" : undefined,
      meta: [
        `${tenants} tenant${tenants === 1 ? "" : "s"}`,
        failed.length ? badge(`${failed.length} would fail`, "error") : null,
      ],
      children: [
        p.missingTenants
          ? callout({
              tone: "warning",
              title: "No tenant configured.",
              body: `${p.missingTenants} has no [[tenants]]: a real deploy would stop here.`,
              actions: [
                {
                  label: "Open configuration",
                  icon: "go-to-file",
                  run: () => channel.post("action", `configure:${p.platform}`),
                },
              ],
            })
          : null,
        ...p.tenants.map((tenant) => tenantBlock(p, tenant, s)),
        failed.length
          ? h(
              "ul",
              { class: "plain" },
              failed.map((row) =>
                h("li", { class: "error" }, [
                  `${row.name}: ${row.error ?? "could not compile"}`,
                  row.help ? h("div", { class: "ot-hint", text: `help: ${row.help}` }) : null,
                ]),
              ),
            )
          : null,
      ],
    }),
  );
}

function tenantBlock(p: PlatformPlan, tenant: TenantPlan, s: DeployPanelState): HTMLElement {
  const payloadByUuid = new Map(p.payloads.map((row) => [row.uuid, row]));
  const counts = ACTIONS.map((a) => [a, tenant.changes.filter((c) => c.action === a).length] as const).filter(
    ([, n]) => n > 0,
  );
  return h("section", { class: "tenant" }, [
    h("h3", { class: "tenant-name" }, [
      h("span", { class: "codicon codicon-server", attrs: { "aria-hidden": "true" } }),
      ` ${tenant.tenant ?? "(no tenant yet)"}`,
      h(
        "span",
        { class: "tenant-counts" },
        counts.map(([action, n]) => badge(`${n} ${ACTION_LABELS[action]}`, action)),
      ),
    ]),
    h("div", { class: "change-head", attrs: { "aria-hidden": "true" } }, [
      h("span", { text: "Action" }),
      h("span", { text: "Rule" }),
      h("span", { text: "Status" }),
      h("span", { text: "" }),
    ]),
    virtualList<ChangeRow>({
      items: tenant.changes,
      rowHeight: 28,
      label: `Changes on ${tenant.tenant ?? label(s, p.platform)}`,
      create: () =>
        h("div", { class: "change", attrs: { role: "listitem" } }, [
          h("span", { class: "change-action" }),
          h("span", { class: "change-rule" }),
          h("span", { class: "change-status" }),
          h("span", { class: "change-tools" }),
        ]),
      update: (row, change) => {
        const focused = s.focus.includes(change.uuid);
        row.classList.toggle("focus", focused);
        row.classList.toggle("fails", change.fails);
        const [action, rule, status, tools] = Array.from(row.children) as HTMLElement[];
        if (!action || !rule || !status || !tools) return;
        replace(
          action,
          badge(
            ACTION_LABELS[change.action] ?? change.action,
            String(change.action),
            `${change.action} on ${tenant.tenant ?? "the platform"}`,
          ),
        );
        replace(
          rule,
          ruleLink(change.name, change.uuid, `${change.uuid}\nOpen the rule`),
          focused ? badge("this rule", "focus") : null,
          change.fails ? badge("would fail to compile", "error") : null,
        );
        setText(status, change.status);
        const payload = payloadByUuid.get(change.uuid);
        replace(
          tools,
          payload?.hasRequest
            ? button({
                label: "Payload",
                variant: "secondary",
                icon: "json",
                title: "Open the API request beside, as a read-only JSON document",
                onClick: () => channel.post("payload", payload.key),
              })
            : null,
          payload?.hasDeployed
            ? button({
                label: "Diff",
                variant: "secondary",
                icon: "diff",
                title: "Compare with what is deployed",
                onClick: () => channel.post("diff", payload.key),
              })
            : null,
        );
      },
    }),
  ]);
}

function renderSkipped(plan: PlanView): void {
  replace(
    skipped,
    plan.skipped.length
      ? collapsible({
          id: "skipped",
          title: "Skipped",
          count: plan.skipped.length,
          open: isOpen("skipped", false),
          onToggle: (value) => setOpen("skipped", value),
          meta: ["no run strategy deploys their status"],
          children: [
            h("div", { class: "skip-head", attrs: { "aria-hidden": "true" } }, [
              h("span", { text: "Rule" }),
              h("span", { text: "Platform" }),
              h("span", { text: "Status" }),
              h("span", { text: "Maps to" }),
            ]),
            virtualList({
              items: plan.skipped,
              rowHeight: 26,
              label: "Skipped rules",
              create: () =>
                h("div", { class: "skip", attrs: { role: "listitem" } }, [
                  h("span"),
                  h("span"),
                  h("span"),
                  h("span"),
                ]),
              update: (row, item) => {
                const [rule, platform, status, strategy] = Array.from(row.children) as HTMLElement[];
                if (rule) replace(rule, ruleLink(item.rule, item.uuid));
                if (platform) setText(platform, state ? label(state, item.platform) : item.platform);
                if (status) setText(status, item.status);
                if (strategy) setText(strategy, item.strategy);
              },
            }),
          ],
        })
      : null,
  );
}

function renderCommands(s: DeployPanelState): void {
  const line = (title: string, text: string, copy: "dryRun" | "deploy") =>
    h("div", {}, [
      h("div", { class: "ot-command-label", text: title }),
      h("div", { class: "ot-command" }, [
        h("code", { class: "ot-code", text }),
        mount(
          button({
            label: `Copy: ${title}`,
            variant: "icon",
            icon: "copy",
            onClick: () => channel.post("copy", copy),
          }),
        ),
      ]),
    ]);
  replace(
    commands,
    collapsible({
      id: "commands",
      title: "Commands",
      open: isOpen("commands", false),
      onToggle: (value) => setOpen("commands", value),
      meta: ["The editor never deploys: run the deploy in a terminal or in CI"],
      children: [
        line("This preview ran", s.argvDisplay, "dryRun"),
        line("To deploy (terminal or CI)", s.deployCommand, "deploy"),
        h("div", { class: "ot-bar" }, [
          mount(
            button({
              label: "Copy as CI step",
              variant: "secondary",
              icon: "github-action",
              title: "A GitHub Actions step whose env names every credential the plan's tenants need",
              onClick: () => channel.post("copy", "ci"),
            }),
          ),
        ]),
      ],
    }),
  );
}

addStyles(`
.region-progress { margin: 0 calc(-1 * var(--ot-space-4)); }
.summary-message { margin: var(--ot-space-3) 0 0; font-weight: 600; }
body.stale .summary, body.stale .platforms { opacity: 0.6; }
.tenant { margin: var(--ot-space-2) 0 var(--ot-space-3); }
.tenant-name { display: flex; align-items: center; gap: var(--ot-space-1); margin: var(--ot-space-2) 0 var(--ot-space-1); }
.tenant-counts { display: inline-flex; gap: var(--ot-space-1); margin-left: var(--ot-space-2); font-weight: normal; }
.change, .change-head, .skip, .skip-head { display: grid; grid-template-columns: 140px minmax(160px, 1fr) 140px max-content;
  align-items: center; gap: var(--ot-space-2); min-height: 28px; padding: 0 var(--ot-space-2); }
.skip, .skip-head { grid-template-columns: minmax(160px, 1fr) 160px 140px 140px; min-height: 26px; }
.change-head, .skip-head { color: var(--ot-muted); font-size: var(--ot-font-sm); border-bottom: 1px solid var(--ot-border); }
.change + .change, .skip + .skip { border-top: 1px solid color-mix(in srgb, var(--ot-border) 50%, transparent); }
.change:hover, .skip:hover { background: var(--vscode-list-hoverBackground); }
.change.focus { box-shadow: inset 3px 0 var(--ot-focus);
  background: var(--vscode-editor-findMatchHighlightBackground, var(--vscode-list-inactiveSelectionBackground)); }
.change-rule { display: flex; gap: var(--ot-space-2); align-items: center; min-width: 0; overflow: hidden; white-space: nowrap; }
.change-rule .ot-btn.link { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.change-tools { display: inline-flex; gap: var(--ot-space-1); }
.change-tools .ot-btn { min-height: 22px; padding: 0 6px; }
.change-status { color: var(--ot-muted); font-family: var(--vscode-editor-font-family); font-size: var(--ot-font-sm); }
ul.plain { list-style: none; padding: 0; margin: 0; }
ul.plain li { padding: 2px 0; }
`);

// Last: every constant above is initialised before the first render.
renderLoading();

channel.on("state", (next) => {
  const was = state?.phase;
  state = next;
  render();
  if (was === "running" && next.phase !== "running")
    announce(next.plan?.message ?? next.failure?.message ?? "Done");
});
channel.on("progress", (step) => {
  const element = document.getElementById("progress-step");
  if (element) setText(element, `Planning ${step}…`);
});
channel.post("ready", undefined);
