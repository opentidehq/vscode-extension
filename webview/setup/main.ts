// The setup wizard (SPEC §8): a stepper over `opentide setup` flags. It gathers answers and shows the
// host's review and progress; every command runs in the host.
import {
  type ApplyProgress,
  type McpHost,
  type Review,
  reviewTotals,
  type SetupAnswers,
  type SkillsHost,
  type WizardInit,
  type WizardProtocol,
  webviewValidators,
} from "../../src/features/setup/protocol";
import { createChannel, vscodeApi } from "../shared/channel";

const channel = createChannel<WizardProtocol>(webviewValidators);

const STEPS = ["Repository", "Platforms", "CI", "Agents", "Extras", "Review"] as const;
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥"];

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

interface State {
  init?: WizardInit;
  answers?: SetupAnswers;
  step: number;
  review?: Review;
  reviewing: boolean;
  progress?: ApplyProgress;
}

const saved = vscodeApi().getState() as Partial<State> | undefined;
const state: State = {
  step: saved?.step ?? 0,
  reviewing: false,
  ...(saved?.answers ? { answers: saved.answers } : {}),
};

type Child = Node | string | false | null | undefined;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | number | ((event: Event) => void) | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") element.addEventListener(key.replace(/^on/, ""), value);
    else if (key === "className") element.className = String(value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, String(value));
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

function installStyles(): void {
  const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "";
  const style = h("style", { nonce });
  style.textContent = `
    body { padding: 16px 24px; max-width: 900px; }
    h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 2px; }
    h2 { font-size: 1.1em; font-weight: 600; margin: 20px 0 8px; }
    .steps { display: flex; flex-wrap: wrap; gap: 4px; margin: 16px 0; padding: 0; border-bottom: 1px solid var(--vscode-panel-border); }
    .steps button { background: none; color: var(--vscode-foreground); border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 6px 10px; opacity: .75; }
    .steps button[aria-selected="true"] { opacity: 1; border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
    .steps button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .field { display: grid; gap: 4px; margin: 12px 0; max-width: 520px; }
    .field input[type=text] { width: 100%; box-sizing: border-box; }
    .check { display: flex; gap: 8px; align-items: baseline; margin: 6px 0; }
    .hint { color: var(--vscode-descriptionForeground); font-size: .92em; }
    .note { border-left: 3px solid var(--vscode-textLink-foreground); padding: 6px 10px; margin: 12px 0; background: var(--vscode-textBlockQuote-background); }
    .problem { border-left-color: var(--vscode-errorForeground); }
    table.platforms td, table.platforms th { padding: 4px 10px; }
    table.platforms td.can { text-align: center; }
    footer { display: flex; gap: 8px; margin-top: 24px; }
    pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
    ul.files { list-style: none; padding-left: 0; margin: 4px 0 8px; }
    ul.files li { display: flex; gap: 8px; padding: 1px 0; }
    .badge { display: inline-block; min-width: 72px; font-size: .85em; padding: 0 6px; border-radius: 8px; text-align: center;
      color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
    .badge.skip { background: none; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); }
    .badge.delete { color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
      background: var(--vscode-inputValidation-errorBackground, var(--vscode-badge-background)); }
    .status { font-weight: 600; }
    .status.ok { color: var(--vscode-testing-iconPassed); }
    .status.failed { color: var(--vscode-errorForeground); }
    a.file { cursor: pointer; }
  `;
  document.head.append(style);
}

function save(): void {
  vscodeApi().setState({ step: state.step, answers: state.answers });
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

function update(patch: Partial<SetupAnswers>): void {
  if (!state.answers) return;
  state.answers = { ...state.answers, ...patch };
  save();
}

function visibleSteps(): number[] {
  return state.init?.mode === "existing" ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5];
}

function go(step: number): void {
  state.step = step;
  save();
  if (step === 5 && state.answers) {
    state.review = undefined;
    channel.post("review", state.answers);
  }
  render();
  document.querySelector<HTMLElement>(`#step-${step}`)?.focus();
}

function textField(
  label: string,
  value: string,
  onInput: (value: string) => void,
  extra: { required?: boolean; hint?: string; placeholder?: string } = {},
): HTMLElement {
  const id = `f-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return h(
    "div",
    { className: "field" },
    h("label", { for: id }, label, extra.required ? " (required)" : ""),
    h("input", {
      type: "text",
      id,
      value,
      required: extra.required,
      placeholder: extra.placeholder,
      "aria-describedby": extra.hint ? `${id}-hint` : undefined,
      oninput: (event) => onInput((event.target as HTMLInputElement).value),
    }),
    extra.hint ? h("span", { className: "hint", id: `${id}-hint` }, extra.hint) : null,
  );
}

function checkbox(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
  extra: { hint?: string; disabled?: boolean } = {},
): HTMLElement {
  const id = `c-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return h(
    "div",
    { className: "check" },
    h("input", {
      type: "checkbox",
      id,
      checked,
      disabled: extra.disabled,
      onchange: (event) => onChange((event.target as HTMLInputElement).checked),
    }),
    h("label", { for: id }, label, extra.hint ? h("span", { className: "hint" }, ` — ${extra.hint}`) : null),
  );
}

function toggle<T extends string>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? [...new Set([...list, value])] : list.filter((item) => item !== value);
}

function repositoryStep(a: SetupAnswers, init: WizardInit): HTMLElement {
  return h(
    "div",
    {},
    h("h2", {}, "Repository"),
    textField("Name", a.name, (name) => update({ name }), { required: true, hint: "Used in the README." }),
    textField("Organisation", a.org, (org) => update({ org }), { hint: "Optional, for the README." }),
    textField("Description", a.description, (description) => update({ description }), {
      hint: "One line, optional.",
    }),
    init.gitRepository
      ? null
      : h(
          "div",
          { className: "note" },
          "This folder is not a Git repository yet. The pipeline and hooks work best in one. ",
          h(
            "button",
            { className: "secondary", onclick: () => channel.post("gitInit", undefined) },
            "Initialize Git…",
          ),
        ),
  );
}

function platformsStep(a: SetupAnswers, init: WizardInit): HTMLElement {
  const yes = (on: boolean | undefined, text = "✓") => (on ? text : "—");
  const rows = init.platforms.map((p) => {
    const id = `p-${p.id}`;
    const checked = p.enabled || a.platforms.includes(p.id);
    return h(
      "tr",
      {},
      h(
        "td",
        {},
        h("input", {
          type: "checkbox",
          id,
          checked,
          disabled: p.enabled && init.mode === "existing",
          onchange: (event) =>
            update({
              platforms: toggle(current().platforms, p.id, (event.target as HTMLInputElement).checked),
            }),
        }),
        " ",
        h("label", { for: id }, p.label),
        p.enabled ? h("span", { className: "hint" }, " (enabled)") : null,
      ),
      h(
        "td",
        { className: "can", "aria-label": p.canDeploy ? "deploys" : "does not deploy" },
        yes(p.canDeploy),
      ),
      h("td", { className: "can" }, p.canValidate ? `✓ ${p.languages ?? ""}`.trim() : "—"),
      h("td", { className: "can" }, yes(p.canQuery)),
    );
  });
  return h(
    "div",
    {},
    h("h2", {}, "Platforms"),
    h(
      "p",
      { className: "hint" },
      init.mode === "new"
        ? "Pick at least one. You can add more later."
        : "Add platforms to this repository.",
    ),
    h(
      "table",
      { className: "platforms" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { scope: "col" }, "Platform"),
          h("th", { scope: "col" }, "Deploy"),
          h("th", { scope: "col" }, "Validate"),
          h("th", { scope: "col" }, "Query"),
        ),
      ),
      h("tbody", {}, ...rows),
    ),
  );
}

function ciStep(a: SetupAnswers, init: WizardInit): HTMLElement {
  const providers = init.ciProviders.map((provider) =>
    h(
      "div",
      { className: "check" },
      h("input", {
        type: "radio",
        name: "ci",
        id: `ci-${provider}`,
        checked: a.ci === provider,
        onchange: () => {
          update({ ci: provider });
          render();
        },
      }),
      h("label", { for: `ci-${provider}` }, CI_LABELS[provider] ?? provider),
    ),
  );
  const features =
    a.ci === "none"
      ? []
      : [
          h("h2", {}, "Pipeline features"),
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
          }),
          textField("Default branch", a.defaultBranch, (defaultBranch) => update({ defaultBranch }), {
            placeholder: "origin/HEAD, else main",
            hint: "The branch that deploys. Empty: opentide works it out.",
          }),
        ];
  return h(
    "div",
    { role: "radiogroup", "aria-label": "CI provider" },
    h("h2", {}, "CI provider"),
    ...providers,
    ...features,
  );
}

function agentsStep(a: SetupAnswers, init: WizardInit): HTMLElement {
  return h(
    "div",
    {},
    h("h2", {}, "MCP"),
    h(
      "p",
      { className: "note" },
      init.mcpProvided
        ? "VS Code needs no MCP file: this extension provides opentide's MCP server to every VS Code agent."
        : "VS Code agents get opentide's MCP server from this extension once the runtime is ready.",
    ),
    ...init.mcpHosts.map((host) =>
      checkbox(MCP_LABELS[host], a.mcp.includes(host), (on) =>
        update({ mcp: toggle(current().mcp, host, on) }),
      ),
    ),
    init.skillsHosts.length ? h("h2", {}, "Agent skills") : null,
    ...init.skillsHosts.map((host) =>
      checkbox(SKILLS_LABELS[host], a.skills.includes(host), (on) =>
        update({ skills: toggle(current().skills, host, on) }),
      ),
    ),
    init.plugin
      ? checkbox("The opentidehq/skills Agent Plugin", a.plugin, (plugin) => update({ plugin }), {
          hint: "for Claude Code",
        })
      : null,
  );
}

function extrasStep(a: SetupAnswers, init: WizardInit): HTMLElement {
  return h(
    "div",
    {},
    h("h2", {}, "Extras"),
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
  );
}

function reviewStep(): HTMLElement {
  const review = state.review;
  if (state.progress) return progressView(state.progress);
  if (!review) return h("div", { "aria-busy": "true" }, h("h2", {}, "Review"), h("p", {}, "Planning…"));
  const problems = review.problems.map((p) =>
    h(
      "div",
      { className: "note problem", role: "alert" },
      p.message,
      " ",
      h("button", { className: "secondary", onclick: () => go(p.step - 1) }, `Go to ${STEPS[p.step - 1]}`),
    ),
  );
  const steps = review.steps.map((step) =>
    h(
      "div",
      {},
      h("pre", { "aria-label": "command" }, step.command),
      step.files
        ? h(
            "div",
            {},
            ...step.files.map((group) =>
              h(
                "div",
                {},
                h("div", { className: "hint" }, group.step),
                h(
                  "ul",
                  { className: "files" },
                  ...group.files.map((f) =>
                    h(
                      "li",
                      {},
                      h("span", { className: `badge ${f.action}` }, ACTION_TEXT[f.action]),
                      h("code", {}, f.path),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h("p", {}, step.summary),
      ...step.warnings.map((w) => h("p", { className: "warning" }, `! ${w}`)),
    ),
  );
  const totals = review.totals;
  return h(
    "div",
    {},
    h("h2", {}, "Review"),
    ...problems,
    review.error ? h("div", { className: "note problem", role: "alert" }, review.error) : null,
    totals ? h("p", {}, reviewTotals(totals)) : null,
    review.note ? h("p", { className: "note" }, review.note) : null,
    ...steps,
  );
}

function progressView(progress: ApplyProgress): HTMLElement {
  const word = {
    pending: "Waiting",
    running: "Running…",
    ok: "✓ Done",
    failed: "✗ Failed",
    cancelled: "Cancelled",
  } as const;
  return h(
    "div",
    { "aria-live": "polite" },
    h("h2", {}, progress.done ? (progress.ok ? "Your repository is ready" : "Setup stopped") : "Applying…"),
    ...progress.commands.map((c) =>
      h(
        "div",
        {},
        h("pre", {}, c.command),
        h("p", { className: `status ${c.status}` }, word[c.status]),
        ...c.steps.map((s) =>
          h(
            "div",
            {},
            h("div", {}, `${s.step}: ${s.message}`),
            h(
              "ul",
              { className: "files" },
              ...s.files.map((file) =>
                h(
                  "li",
                  {},
                  h(
                    "a",
                    {
                      className: "file",
                      href: "#",
                      onclick: (e) => {
                        e.preventDefault();
                        channel.post("openFile", file);
                      },
                    },
                    file,
                  ),
                ),
              ),
            ),
          ),
        ),
        c.failure
          ? h(
              "div",
              { className: "note problem", role: "alert" },
              c.failure.message,
              c.failure.fix ? h("div", {}, `Fix: ${c.failure.fix}`) : null,
            )
          : null,
      ),
    ),
  );
}

function footer(): HTMLElement {
  const steps = visibleSteps();
  const index = steps.indexOf(state.step);
  const progress = state.progress;
  if (progress?.done)
    return h(
      "footer",
      {},
      progress.ok
        ? h("button", { onclick: () => channel.post("close", undefined) }, "Close")
        : h(
            "button",
            {
              onclick: () => {
                state.progress = undefined;
                go(5);
              },
            },
            "Back to Review",
          ),
    );
  if (progress)
    return h(
      "footer",
      {},
      h("button", { className: "secondary", onclick: () => channel.post("cancel", undefined) }, "Cancel"),
    );
  const back =
    index > 0
      ? h("button", { className: "secondary", onclick: () => go(steps[index - 1] ?? 0) }, "Back")
      : null;
  if (state.step < 5)
    return h(
      "footer",
      {},
      back,
      h("button", { onclick: () => go(steps[index + 1] ?? 5) }, state.step === 4 ? "Review" : "Next"),
    );
  const blocked = !state.review || state.review.problems.length > 0 || Boolean(state.review.error);
  return h(
    "footer",
    {},
    back,
    h(
      "button",
      {
        className: "secondary",
        disabled: !state.review || state.review.problems.length > 0,
        onclick: () => state.answers && channel.post("copyScript", state.answers),
      },
      "Copy as Script",
    ),
    h(
      "button",
      { disabled: blocked, onclick: () => state.answers && channel.post("apply", state.answers) },
      "Apply",
    ),
  );
}

function render(): void {
  const root = document.getElementById("root");
  const init = state.init;
  const a = state.answers;
  if (!root) return;
  root.replaceChildren();
  if (!init || !a) {
    root.append(h("p", { "aria-busy": "true" }, "Loading…"));
    return;
  }
  const steps = visibleSteps();
  if (!steps.includes(state.step)) state.step = steps[0] ?? 0;
  const tabs = h(
    "div",
    { className: "steps", role: "tablist", "aria-label": "Setup steps" },
    ...steps.map((step) =>
      h(
        "button",
        {
          role: "tab",
          id: `tab-${step}`,
          "aria-selected": String(step === state.step),
          "aria-controls": `step-${step}`,
          tabindex: step === state.step ? 0 : -1,
          disabled: Boolean(state.progress && !state.progress.done),
          onclick: () => go(step),
          onkeydown: (event) => {
            const key = (event as KeyboardEvent).key;
            const at = steps.indexOf(step);
            const next =
              key === "ArrowRight" ? steps[at + 1] : key === "ArrowLeft" ? steps[at - 1] : undefined;
            if (next !== undefined) {
              event.preventDefault();
              go(next);
              document.getElementById(`tab-${next}`)?.focus();
            }
          },
        },
        `${CIRCLED[step]} ${STEPS[step]}`,
      ),
    ),
  );
  const body =
    [repositoryStep, platformsStep, ciStep, agentsStep, extrasStep][state.step]?.(a, init) ?? reviewStep();
  root.append(
    h("h1", {}, init.mode === "new" ? "Set up a detection repository" : "Add to this repository"),
    h(
      "p",
      { className: "muted" },
      `In ${init.folderName}. Each step is an opentide setup flag; nothing is written until you apply.`,
    ),
    tabs,
    h(
      "section",
      { role: "tabpanel", id: `step-${state.step}`, "aria-labelledby": `tab-${state.step}`, tabindex: -1 },
      body,
    ),
    footer(),
  );
}

channel.on("init", (init) => {
  state.init = init;
  state.answers = state.answers ?? init.answers;
  if (init.startStep !== undefined && saved?.step === undefined) state.step = init.startStep;
  if (!visibleSteps().includes(state.step)) state.step = visibleSteps()[0] ?? 0;
  render();
  if (state.step === 5) go(5);
});
channel.on("reviewing", () => {
  state.reviewing = true;
  render();
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

installStyles();
render();
channel.post("ready", undefined);
