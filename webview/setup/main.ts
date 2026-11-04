// The setup wizard (SPEC §8): a stepper over `opentide setup` flags. It gathers answers, checks them inline
// and shows the host's review, the progress of each command Apply runs, and a finish screen with what to
// do next. Every command runs in the host.
import {
  badge,
  button,
  callout,
  emptyState,
  icon,
  progressBar,
  skeletonRows,
  stepper,
} from "../../src/core/webview/kit/components";
import {
  type ApplyProgress,
  type Finished,
  type McpHost,
  type Review,
  reviewTotals,
  type SetupAnswers,
  type SkillsHost,
  type WizardInit,
  type WizardProtocol,
  webviewValidators,
} from "../../src/features/setup/protocol";
import { fieldError, STEP_NAMES, stepStates, validateAnswers } from "../../src/features/setup/validate";
import { addStyles, h, mount, replace } from "../panels-kit/dom";
import { createChannel, vscodeApi } from "../shared/channel";

const channel = createChannel<WizardProtocol>(webviewValidators);

const MCP_LABELS: Record<McpHost, string> = {
  vscode: "VS Code (.vscode/mcp.json, for teammates without this extension)",
  cursor: "Cursor (.cursor/mcp.json)",
  "claude-code": "Claude Code (.mcp.json)",
  generic: "Other MCP hosts (generic)",
};
const SKILLS_LABELS: Record<SkillsHost, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  "github-copilot": "GitHub Copilot",
  generic: "Other agents (AGENTS.md, .agents/skills)",
};
const CI_LABELS: Record<string, string> = {
  github: "GitHub Actions",
  gitlab: "GitLab CI",
  azure: "Azure Pipelines",
  none: "None for now",
};
const ACTION_TEXT = { create: "new", merge: "merge", skip: "unchanged", delete: "remove" } as const;
const ACTION_ICONS = {
  create: "diff-added",
  merge: "diff-modified",
  skip: "circle-slash",
  delete: "diff-removed",
};

interface State {
  init?: WizardInit;
  answers?: SetupAnswers;
  step: number;
  /** Steps the person has been on (for done / invalid in the stepper). */
  visited: Set<number>;
  /** Fields the person has typed in or left (their inline message shows). */
  touched: Set<string>;
  /** Steps the person pressed Next on: their fields' messages show. */
  attempted: Set<number>;
  review?: Review;
  reviewing: boolean;
  progress?: ApplyProgress;
  finished?: Finished;
}

/** Whether a field's inline message shows: touched, or its step was left with Next, or Review was reached. */
const showsErrors = (key: string) =>
  state.touched.has(key) || state.attempted.has(state.step) || state.visited.has(5);

const saved = vscodeApi().getState() as
  | { step?: number; answers?: SetupAnswers; visited?: number[] }
  | undefined;
const state: State = {
  step: saved?.step ?? 0,
  visited: new Set(saved?.visited ?? []),
  touched: new Set(),
  attempted: new Set(),
  reviewing: false,
  ...(saved?.answers ? { answers: saved.answers } : {}),
};

function save(): void {
  vscodeApi().setState({ step: state.step, answers: state.answers, visited: [...state.visited] });
}

/** The answers now (handlers outlive the render that made them). */
function current(): SetupAnswers {
  return (
    state.answers ?? {
      name: "",
      org: "",
      description: "",
      platforms: [],
      ci: "none",
      staging: true,
      inflight: true,
      sharing: false,
      explorerPages: false,
      pythonVersion: "",
      defaultBranch: "",
      mcp: [],
      skills: [],
      plugin: false,
      hooks: false,
      env: false,
    }
  );
}

/** Change the answers; `rerender` redraws the step (for choices that show or hide fields). */
function update(patch: Partial<SetupAnswers>, rerender = false): void {
  if (!state.answers) return;
  state.answers = { ...state.answers, ...patch };
  save();
  if (rerender) render();
  else renderChrome();
}

function visibleSteps(): number[] {
  return state.init?.mode === "existing" ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5];
}

function go(step: number): void {
  state.visited.add(state.step);
  state.step = step;
  state.visited.add(step);
  save();
  if (step === 5 && state.answers) {
    state.review = undefined;
    channel.post("review", state.answers);
  }
  render();
  document.querySelector<HTMLElement>(`#step-${step} h2`)?.focus();
}

function fieldId(label: string): string {
  return `f-${label.replace(/\W+/g, "-").toLowerCase()}`;
}

/** A text field with its hint and, once touched, its inline message. */
function textField(
  label: string,
  value: string,
  onInput: (value: string) => void,
  extra: {
    required?: boolean;
    hint?: string;
    placeholder?: string;
    error?: (answers: SetupAnswers) => string | undefined;
  } = {},
): HTMLElement {
  const id = fieldId(label);
  const message = h("span", { class: "field-error", id: `${id}-error`, attrs: { "aria-live": "polite" } });
  const input = h("input", {
    id,
    attrs: {
      type: "text",
      value,
      required: extra.required,
      placeholder: extra.placeholder,
      "aria-describedby": [extra.hint ? `${id}-hint` : "", `${id}-error`].filter(Boolean).join(" "),
      "data-focus": id,
    },
    on: {
      input: (event) => {
        onInput((event.target as HTMLInputElement).value);
        state.touched.add(id);
        check();
      },
      blur: () => {
        state.touched.add(id);
        check();
      },
    },
  });
  const check = () => {
    const error = showsErrors(id) ? extra.error?.(current()) : undefined;
    message.replaceChildren(...(error ? [mount(icon("error")), ` ${error}`] : []));
    input.setAttribute("aria-invalid", error ? "true" : "false");
    input.classList.toggle("invalid", Boolean(error));
  };
  check();
  return h("div", { class: "field" }, [
    h("label", { attrs: { for: id } }, [
      label,
      extra.required ? h("span", { class: "required", text: " *" }) : null,
    ]),
    input,
    extra.hint ? h("span", { class: "ot-hint", id: `${id}-hint`, text: extra.hint }) : null,
    message,
  ]);
}

function checkbox(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
  extra: { hint?: string; disabled?: boolean } = {},
): HTMLElement {
  const id = `c-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return h("div", { class: "check" }, [
    h("input", {
      id,
      attrs: { type: "checkbox", checked, disabled: extra.disabled, "data-focus": id },
      on: { change: (event) => onChange((event.target as HTMLInputElement).checked) },
    }),
    h("label", { attrs: { for: id } }, [
      label,
      extra.hint ? h("span", { class: "ot-hint", text: ` — ${extra.hint}` }) : null,
    ]),
  ]);
}

function toggled<T extends string>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? [...new Set([...list, value])] : list.filter((item) => item !== value);
}

function repositoryStep(a: SetupAnswers, init: WizardInit): HTMLElement {
  return h("div", {}, [
    h("h2", { text: "Repository", attrs: { tabindex: -1 } }),
    textField("Name", a.name, (name) => update({ name }), {
      required: true,
      hint: "Used in the README.",
      error: (answers) => fieldError("name", answers, init.mode),
    }),
    textField("Organisation", a.org, (org) => update({ org }), { hint: "Optional, for the README." }),
    textField("Description", a.description, (description) => update({ description }), {
      hint: "One line, optional.",
    }),
    init.gitRepository
      ? null
      : mount(
          callout({
            tone: "info",
            body: "This folder is not a Git repository yet. The pipeline and hooks work best in one.",
            actions: [
              { label: "Initialize Git…", icon: "git-commit", run: () => channel.post("gitInit", undefined) },
            ],
          }),
        ),
  ]);
}

function platformsStep(a: SetupAnswers, init: WizardInit): HTMLElement {
  const yes = (on: boolean | undefined, label: string) =>
    on
      ? mount(icon("check", label))
      : h("span", { class: "muted", text: "—", attrs: { "aria-label": `no ${label}` } });
  const error = showsErrors("platforms") ? fieldError("platforms", a, init.mode) : undefined;
  const rows = init.platforms.map((p) => {
    const id = `p-${p.id}`;
    const checked = p.enabled || a.platforms.includes(p.id);
    return h("tr", { class: checked ? "on" : "" }, [
      h("td", {}, [
        h("input", {
          id,
          attrs: {
            type: "checkbox",
            checked,
            disabled: p.enabled && init.mode === "existing",
            "data-focus": id,
          },
          on: {
            change: (event) => {
              state.touched.add("platforms");
              update(
                { platforms: toggled(current().platforms, p.id, (event.target as HTMLInputElement).checked) },
                true,
              );
            },
          },
        }),
        " ",
        h("label", { attrs: { for: id }, text: p.label }),
        p.enabled ? mount(badge("enabled", "muted")) : null,
      ]),
      h("td", { class: "can" }, [yes(p.canDeploy, "deploy")]),
      h("td", { class: "can" }, [
        p.canValidate
          ? h("span", { text: p.languages ?? "" }, [mount(icon("check", "validates"))])
          : yes(false, "validation"),
      ]),
      h("td", { class: "can" }, [yes(p.canQuery, "query")]),
    ]);
  });
  return h("div", {}, [
    h("h2", { text: "Platforms", attrs: { tabindex: -1 } }),
    h("p", {
      class: "ot-hint",
      text:
        init.mode === "new"
          ? "Pick at least one. You can add more later."
          : "Add platforms to this repository.",
    }),
    h("table", { class: "platforms", attrs: { "aria-describedby": "platforms-error" } }, [
      h("thead", {}, [
        h("tr", {}, [
          h("th", { text: "Platform", attrs: { scope: "col" } }),
          h("th", { text: "Deploy", attrs: { scope: "col" } }),
          h("th", { text: "Validate", attrs: { scope: "col" } }),
          h("th", { text: "Query", attrs: { scope: "col" } }),
        ]),
      ]),
      h("tbody", {}, rows),
    ]),
    h(
      "div",
      { class: "field-error", id: "platforms-error", attrs: { "aria-live": "polite" } },
      error ? [mount(icon("error")), ` ${error}`] : [],
    ),
  ]);
}

function ciStep(a: SetupAnswers, init: WizardInit): HTMLElement {
  const providers = init.ciProviders.map((provider) =>
    h("div", { class: "check" }, [
      h("input", {
        id: `ci-${provider}`,
        attrs: { type: "radio", name: "ci", checked: a.ci === provider, "data-focus": `ci-${provider}` },
        on: { change: () => update({ ci: provider }, true) },
      }),
      h("label", { attrs: { for: `ci-${provider}` }, text: CI_LABELS[provider] ?? provider }),
    ]),
  );
  const features =
    a.ci === "none"
      ? []
      : [
          h("h3", { text: "Pipeline features" }),
          checkbox("Staging", a.staging, (staging) => update({ staging }), {
            hint: "deploy to staging tenants from pull requests",
          }),
          checkbox("Inflight", a.inflight, (inflight) => update({ inflight }), {
            hint: "preview shards on pull requests",
          }),
          checkbox("Sharing", a.sharing, (sharing) => update({ sharing }), {
            hint: "share changed objects on the default branch",
          }),
          checkbox("Promotion", a.promotion === true, (promotion) => update({ promotion }), {
            hint: "promote rules' status on deploy",
          }),
          a.ci === "github" && init.explorerPages
            ? checkbox("Explorer pages", a.explorerPages, (explorerPages) => update({ explorerPages }), {
                hint: "GitHub Pages explorer",
              })
            : null,
          textField("Python version", a.pythonVersion, (pythonVersion) => update({ pythonVersion }), {
            placeholder: "3.12",
            error: (answers) => fieldError("pythonVersion", answers, init.mode),
          }),
          textField("Default branch", a.defaultBranch, (defaultBranch) => update({ defaultBranch }), {
            placeholder: "origin/HEAD, else main",
            hint: "The branch that deploys. Empty: opentide works it out.",
            error: (answers) => fieldError("defaultBranch", answers, init.mode),
          }),
        ];
  return h("div", {}, [
    h("h2", { text: "CI provider", attrs: { tabindex: -1 } }),
    h("div", { attrs: { role: "radiogroup", "aria-label": "CI provider" } }, providers),
    ...features,
  ]);
}

function agentsStep(a: SetupAnswers, init: WizardInit): HTMLElement {
  return h("div", {}, [
    h("h2", { text: "MCP", attrs: { tabindex: -1 } }),
    mount(
      callout({
        tone: "info",
        body: init.mcpProvided
          ? "VS Code needs no MCP file: this extension provides opentide's MCP server to every VS Code agent."
          : "VS Code agents get opentide's MCP server from this extension once the runtime is ready.",
      }),
    ),
    ...init.mcpHosts.map((host) =>
      checkbox(MCP_LABELS[host], a.mcp.includes(host), (on) =>
        update({ mcp: toggled(current().mcp, host, on) }),
      ),
    ),
    init.skillsHosts.length ? h("h2", { text: "Agent skills" }) : null,
    ...init.skillsHosts.map((host) =>
      checkbox(SKILLS_LABELS[host], a.skills.includes(host), (on) =>
        update({ skills: toggled(current().skills, host, on) }),
      ),
    ),
    init.plugin
      ? checkbox("The opentidehq/skills Agent Plugin", a.plugin, (plugin) => update({ plugin }), {
          hint: "for Claude Code",
        })
      : null,
  ]);
}

function extrasStep(a: SetupAnswers, init: WizardInit): HTMLElement {
  return h("div", {}, [
    h("h2", { text: "Extras", attrs: { tabindex: -1 } }),
    init.hooks
      ? checkbox("Pre-commit hooks", a.hooks, (hooks) => update({ hooks }), {
          hint: "validate objects on every commit",
        })
      : null,
    init.env
      ? checkbox(".env.example", a.env, (env) => update({ env }), {
          hint: "the credential variables, with .env ignored",
        })
      : null,
  ]);
}

function reviewStep(): HTMLElement {
  if (state.finished && state.progress) return finishView(state.progress, state.finished);
  if (state.progress) return progressView(state.progress);
  const review = state.review;
  if (!review)
    return h("div", { attrs: { "aria-busy": "true" } }, [
      h("h2", { text: "Review", attrs: { tabindex: -1 } }),
      mount(progressBar({ active: true, label: "Planning the files" })),
      h("p", { class: "ot-hint", text: "opentide plans each command (setup --plan); nothing is written." }),
      mount(skeletonRows({ rows: 6, columns: 2 })),
    ]);
  const problems = review.problems.map((p) =>
    mount(
      callout({
        tone: "error",
        body: p.message,
        actions: [{ label: `Go to ${STEP_NAMES[p.step - 1]}`, run: () => go(p.step - 1) }],
      }),
    ),
  );
  const steps = review.steps.map((step) =>
    h("section", { class: "review-step" }, [
      h("div", { class: "ot-command" }, [
        h("code", { class: "ot-code", text: step.command, attrs: { "aria-label": "command" } }),
      ]),
      step.files
        ? h(
            "div",
            {},
            step.files.map((group) =>
              h("div", {}, [
                h("div", { class: "ot-command-label", text: group.step }),
                h(
                  "ul",
                  { class: "files" },
                  group.files.map((f) =>
                    h("li", {}, [
                      h("span", {
                        class: `codicon codicon-${ACTION_ICONS[f.action]} file-${f.action}`,
                        attrs: { "aria-hidden": "true" },
                      }),
                      mount(badge(ACTION_TEXT[f.action], f.action === "skip" ? "skip" : f.action)),
                      h("code", { text: f.path }),
                    ]),
                  ),
                ),
              ]),
            ),
          )
        : h("p", { text: step.summary }),
      ...step.warnings.map((w) => mount(callout({ tone: "warning", body: w }))),
    ]),
  );
  const totals = review.totals;
  return h("div", {}, [
    h("h2", { text: "Review", attrs: { tabindex: -1 } }),
    ...problems,
    review.error ? mount(callout({ tone: "error", body: review.error })) : null,
    totals
      ? h("div", { class: "totals" }, [
          mount(badge(`${totals.create} new`, "create")),
          mount(badge(`${totals.merge} merged`, "merge")),
          mount(badge(`${totals.skip} unchanged`, "skip")),
          totals.delete ? mount(badge(`${totals.delete} to remove`, "delete")) : null,
          h("span", { class: "ot-hint", text: reviewTotals(totals).replace(/^.*?\. /, "") }),
        ])
      : null,
    review.note ? mount(callout({ tone: "info", body: review.note })) : null,
    ...steps,
  ]);
}

const STATUS_ICON = {
  pending: "circle-large-outline",
  running: "loading",
  ok: "pass-filled",
  failed: "error",
  cancelled: "circle-slash",
} as const;
const STATUS_WORD = {
  pending: "Waiting",
  running: "Running",
  ok: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
} as const;

function progressView(progress: ApplyProgress): HTMLElement {
  const done = progress.commands.filter((c) => c.status === "ok").length;
  const total = progress.commands.length;
  return h("div", { attrs: { "aria-live": "polite" } }, [
    h("h2", {
      text: progress.done ? (progress.ok ? "Your repository is ready" : "Setup stopped") : "Applying…",
      attrs: { tabindex: -1 },
    }),
    mount(
      progressBar({
        active: !progress.done,
        label: `${done} of ${total} commands`,
        value: total ? done / total : 0,
      }),
    ),
    h("p", { class: "ot-hint", text: `${done} of ${total} commands done` }),
    h(
      "ol",
      { class: "commands" },
      progress.commands.map((c) =>
        h("li", { class: `command ${c.status}` }, [
          h("div", { class: "command-head" }, [
            mount(
              icon(
                STATUS_ICON[c.status],
                STATUS_WORD[c.status],
                c.status === "running" ? "codicon-modifier-spin" : undefined,
              ),
            ),
            h("code", { text: c.command }),
            h("span", { class: "ot-hint", text: STATUS_WORD[c.status] }),
          ]),
          ...c.steps.map((s) =>
            h("div", { class: "command-step" }, [
              h("div", { text: `${s.step}: ${s.message}` }),
              h(
                "ul",
                { class: "files" },
                s.files.map((file) =>
                  h("li", {}, [
                    mount(
                      button({
                        label: file,
                        variant: "link",
                        title: "Open beside",
                        onClick: () => channel.post("openFile", file),
                      }),
                    ),
                  ]),
                ),
              ),
            ]),
          ),
          c.failure
            ? mount(
                callout({
                  tone: "error",
                  body: c.failure.fix
                    ? [c.failure.message, h("div", { class: "ot-hint", text: `Fix: ${c.failure.fix}` })]
                    : c.failure.message,
                }),
              )
            : null,
        ]),
      ),
    ),
  ]);
}

/** After Apply: what was done, and the next steps (Open README, New Rule, Show Graph). */
function finishView(progress: ApplyProgress, finished: Finished): HTMLElement {
  const files = progress.commands.flatMap((c) => c.steps.flatMap((s) => s.files));
  const next = (
    label: string,
    iconName: string,
    body: string,
    action: Parameters<typeof post>[0],
    primary = false,
  ) =>
    h(
      "button",
      {
        class: `next ${primary ? "primary" : ""}`,
        attrs: { type: "button", "data-focus": `next:${action}` },
        on: { click: () => post(action) },
      },
      [
        h("span", { class: `codicon codicon-${iconName}`, attrs: { "aria-hidden": "true" } }),
        h("span", { class: "next-text" }, [
          h("strong", { text: label }),
          h("span", { class: "ot-hint", text: body }),
        ]),
      ],
    );
  const post = (action: "readme" | "newRule" | "graph" | "openFolder" | "catalogue") =>
    channel.post("next", action);
  return h("div", { class: "finish" }, [
    mount(
      emptyState({
        icon: "pass-filled",
        title: "Your repository is ready",
        body: `${progress.commands.length} command${progress.commands.length === 1 ? "" : "s"} ran; ${files.length} file${files.length === 1 ? "" : "s"} written. Nothing else changed.`,
      }),
    ),
    h("div", { class: "next-actions", attrs: { role: "group", "aria-label": "Next steps" } }, [
      finished.inWorkspace
        ? null
        : next(
            "Open the folder",
            "folder-opened",
            "Open it in this window to start writing detections.",
            "openFolder",
            true,
          ),
      finished.readme
        ? next(
            /^readme(\.md)?$/i.test(finished.readme.split("/").at(-1) ?? "")
              ? "Open README"
              : `Open ${finished.readme.split("/").at(-1)}`,
            "book",
            finished.readme,
            "readme",
            finished.inWorkspace,
          )
        : null,
      finished.inWorkspace && finished.newRule
        ? next(
            "New Rule",
            "new-file",
            "Scaffold your first detection, with placeholders to replace.",
            "newRule",
          )
        : null,
      finished.inWorkspace && finished.graph
        ? next("Show Graph", "type-hierarchy", "See how threats, objectives and rules connect.", "graph")
        : null,
      finished.inWorkspace
        ? next("Catalogue", "list-tree", "The objects in the opentide sidebar.", "catalogue")
        : null,
    ]),
    h("details", { class: "ot-section" }, [
      h("summary", { class: "ot-section-head" }, [
        mount(icon("chevron-right", undefined, "ot-section-chevron")),
        h("span", { class: "ot-section-title", text: "What ran" }),
      ]),
      h("div", { class: "ot-section-body" }, [progressView(progress)]),
    ]),
  ]);
}

function footer(): HTMLElement {
  const steps = visibleSteps();
  const index = steps.indexOf(state.step);
  const progress = state.progress;
  if (state.finished)
    return h("footer", {}, [
      mount(
        button({ label: "Close", variant: "secondary", onClick: () => channel.post("close", undefined) }),
      ),
    ]);
  if (progress?.done)
    return h("footer", {}, [
      mount(
        button({
          label: "Back to Review",
          icon: "arrow-left",
          onClick: () => {
            state.progress = undefined;
            go(5);
          },
        }),
      ),
    ]);
  if (progress)
    return h("footer", {}, [
      mount(
        button({
          label: "Cancel",
          variant: "secondary",
          icon: "debug-stop",
          onClick: () => channel.post("cancel", undefined),
        }),
      ),
    ]);
  const back =
    index > 0
      ? mount(
          button({
            label: "Back",
            variant: "secondary",
            focusKey: "back",
            onClick: () => go(steps[index - 1] ?? 0),
          }),
        )
      : null;
  if (state.step < 5) {
    const problems =
      state.answers && state.init
        ? validateAnswers(state.answers, state.init.mode).filter((p) => p.step - 1 === state.step)
        : [];
    return h("footer", {}, [
      back,
      mount(
        button({
          label: state.step === 4 ? "Review" : "Next",
          icon: "arrow-right",
          focusKey: "next",
          onClick: () => {
            // Leaving a step shows its inline messages there; Next still moves on (Review lists them all).
            state.attempted.add(state.step);
            go(steps[index + 1] ?? 5);
          },
        }),
      ),
      problems.length
        ? h("span", {
            class: "footer-note",
            text: `${problems.length} thing${problems.length === 1 ? "" : "s"} to fix on this step`,
          })
        : null,
    ]);
  }
  const blocked = !state.review || state.review.problems.length > 0 || Boolean(state.review.error);
  return h("footer", {}, [
    back,
    mount(
      button({
        label: "Copy as Script",
        variant: "secondary",
        icon: "copy",
        disabled: !state.review || state.review.problems.length > 0,
        onClick: () => {
          if (state.answers) channel.post("copyScript", state.answers);
        },
      }),
    ),
    mount(
      button({
        label: "Apply",
        icon: "check",
        focusKey: "apply",
        disabled: blocked,
        title: blocked ? "Fix the problems Review lists first" : "Run the commands above, in order",
        onClick: () => {
          if (state.answers) channel.post("apply", state.answers);
        },
      }),
    ),
  ]);
}

const stepsHost = h("div");
const bodyHost = h("section", { class: "step-body" });
const footerHost = h("div");

/** The stepper and the footer, which follow every answer (done / invalid states, Next's note). */
function renderChrome(): void {
  const init = state.init;
  const a = state.answers;
  if (!init || !a) return;
  const steps = visibleSteps();
  const states = stepStates({
    answers: a,
    mode: init.mode,
    steps,
    current: state.step,
    visited: state.visited,
    applied: Boolean(state.finished),
  });
  replace(
    stepsHost,
    stepper({
      label: "Setup steps",
      steps: states.map(({ step, state: s }, i) => ({
        id: String(step),
        label: STEP_NAMES[step] ?? "",
        number: init.mode === "existing" ? i + 2 : i + 1,
        state: s,
        disabled: Boolean(state.progress && !state.progress.done) || Boolean(state.finished),
      })),
      onSelect: (id) => go(Number(id)),
    }),
  );
  replace(footerHost, footer());
}

function render(): void {
  const root = document.getElementById("root");
  const init = state.init;
  const a = state.answers;
  if (!root) return;
  if (!init || !a) {
    replace(
      root,
      h("div", { attrs: { "aria-busy": "true" } }, [
        mount(progressBar({ active: true, label: "Loading" })),
        mount(skeletonRows({ rows: 6, columns: 2 })),
      ]),
    );
    return;
  }
  const steps = visibleSteps();
  if (!steps.includes(state.step)) state.step = steps[0] ?? 0;
  const body =
    [repositoryStep, platformsStep, ciStep, agentsStep, extrasStep][state.step]?.(a, init) ?? reviewStep();
  bodyHost.id = `step-${state.step}`;
  bodyHost.setAttribute("role", "tabpanel");
  bodyHost.setAttribute("aria-labelledby", `tab-${state.step}`);
  replace(bodyHost, body);
  if (!root.contains(stepsHost))
    replace(
      root,
      h("header", { class: "wizard-head" }, [
        h("h1", { text: init.mode === "new" ? "Set up a detection repository" : "Add to this repository" }),
        h("p", {
          class: "ot-hint",
          text: `In ${init.folderName}. Each step is an opentide setup flag; nothing is written until you apply.`,
        }),
      ]),
      stepsHost,
      bodyHost,
      footerHost,
    );
  renderChrome();
}

channel.on("init", (init) => {
  state.init = init;
  state.answers = state.answers ?? init.answers;
  if (init.startStep !== undefined && saved?.step === undefined) state.step = init.startStep;
  if (!visibleSteps().includes(state.step)) state.step = visibleSteps()[0] ?? 0;
  state.visited.add(state.step);
  render();
  if (state.step === 5) go(5);
});
channel.on("reviewing", () => {
  state.reviewing = true;
});
channel.on("review", (review) => {
  state.reviewing = false;
  state.review = review;
  if (state.step === 5) render();
});
channel.on("progress", (progress) => {
  state.progress = progress;
  state.step = 5;
  render();
});
channel.on("finished", (finished) => {
  state.finished = finished;
  render();
  document.querySelector<HTMLElement>(".next")?.focus();
});

addStyles(`
body.ot-kit { padding: var(--ot-space-4) var(--ot-space-6); max-width: 920px; }
.wizard-head h1 { font-size: var(--ot-font-xl); margin: 0 0 2px; }
.step-body { min-height: 320px; }
.step-body h2:focus { outline: none; }
.field { display: grid; gap: var(--ot-space-1); margin: var(--ot-space-3) 0; max-width: 520px; }
.field input[type=text] { width: 100%; box-sizing: border-box; height: var(--ot-control-height); }
.field input.invalid { border-color: var(--vscode-inputValidation-errorBorder, var(--ot-error)); }
.required { color: var(--ot-error); }
.field-error { color: var(--ot-error); font-size: var(--ot-font-sm); min-height: 1.3em; display: flex; gap: var(--ot-space-1); align-items: center; }
.check { display: flex; gap: var(--ot-space-2); align-items: baseline; margin: var(--ot-space-1) 0; }
table.platforms { border-collapse: collapse; margin-top: var(--ot-space-2); }
table.platforms td, table.platforms th { padding: var(--ot-space-1) var(--ot-space-3); }
table.platforms tr.on td:first-child { font-weight: 600; }
table.platforms td.can { text-align: center; }
table.platforms td .ot-tag { margin-left: var(--ot-space-2); }
footer { display: flex; gap: var(--ot-space-2); align-items: center; margin-top: var(--ot-space-6); padding-top: var(--ot-space-3); border-top: 1px solid var(--ot-border); }
.footer-note { color: var(--ot-warning); font-size: var(--ot-font-sm); }
.review-step { margin: var(--ot-space-3) 0; }
.totals { display: flex; flex-wrap: wrap; gap: var(--ot-space-2); align-items: center; margin: var(--ot-space-2) 0; }
ul.files { list-style: none; padding-left: 0; margin: var(--ot-space-1) 0 var(--ot-space-2); }
ul.files li { display: flex; gap: var(--ot-space-2); align-items: center; padding: 1px 0; min-width: 0; }
ul.files li code { overflow-wrap: anywhere; min-width: 0; }
.next-text .ot-hint { overflow-wrap: anywhere; }
ul.files li .ot-tag { min-width: 72px; text-align: center; }
.file-create { color: var(--vscode-gitDecoration-addedResourceForeground, var(--ot-ok)); }
.file-merge { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--ot-info)); }
.file-skip { color: var(--ot-muted); }
.file-delete { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--ot-error)); }
ol.commands { list-style: none; padding: 0; margin: var(--ot-space-2) 0; }
.command { padding: var(--ot-space-2) 0; border-bottom: 1px solid var(--ot-border); }
.command-head { display: flex; gap: var(--ot-space-2); align-items: center; }
.command.ok .command-head .codicon { color: var(--ot-ok); }
.command.failed .command-head .codicon { color: var(--ot-error); }
.command.pending { opacity: 0.7; }
.command-step { margin: var(--ot-space-1) 0 0 var(--ot-space-6); }
.finish .ot-state { margin: var(--ot-space-4) auto var(--ot-space-3); }
.finish .ot-state .ot-state-icon.codicon { color: var(--ot-ok); }
.next-actions { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--ot-space-2); margin: var(--ot-space-3) 0; }
button.next { display: flex; gap: var(--ot-space-3); align-items: flex-start; text-align: left; padding: var(--ot-space-3);
  color: var(--vscode-foreground); background: var(--ot-surface); border: 1px solid var(--ot-border); border-radius: var(--ot-radius-2); }
button.next:hover { background: var(--ot-hover); border-color: var(--ot-focus); }
button.next.primary { border-color: var(--vscode-button-background); }
button.next .codicon { font-size: 20px; color: var(--vscode-textLink-foreground); }
.next-text { display: flex; flex-direction: column; gap: 2px; }
`);
render();
channel.post("ready", undefined);
