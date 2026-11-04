// The panels kit's components (SPEC §10 "Components"): toolbar, buttons, segmented control, chips and
// badges, progress and skeleton, empty and error states, callouts, collapsible sections, stat cards and
// the stepper. Each returns a VNode; theme variables only, codicons for icons. vscode-free, DOM-free.
import { cx, type Handler, requestFocus, type UiEvent, type VChild, type VNode, v } from "./vnode";

export type Tone = "ok" | "warning" | "error" | "info" | "muted";

/** A codicon. Decorative unless it has a label (then it is an image with that name). */
export function icon(name: string, label?: string, extraClass?: string): VNode {
  return v("span", {
    class: cx("codicon", `codicon-${name}`, extraClass),
    attrs: label ? { role: "img", "aria-label": label, title: label } : { "aria-hidden": "true" },
  });
}

/** A spinning codicon (still under `prefers-reduced-motion`). */
export function spinner(label = "Working"): VNode {
  return icon("loading", label, "codicon-modifier-spin");
}

export interface ButtonSpec {
  readonly label: string;
  readonly icon?: string;
  /** primary (default), secondary, or a bare icon button (the label is its accessible name and tooltip). */
  readonly variant?: "primary" | "secondary" | "icon" | "link";
  readonly title?: string;
  readonly disabled?: boolean;
  /** A toggle: `aria-pressed`. */
  readonly pressed?: boolean;
  /** `data-focus`, so a re-render can give it the focus back. */
  readonly focusKey?: string;
  readonly onClick?: Handler;
  readonly attrs?: Readonly<Record<string, string | number | boolean | undefined>>;
}

export function button(spec: ButtonSpec): VNode {
  const variant = spec.variant ?? "primary";
  const iconOnly = variant === "icon";
  return v(
    "button",
    {
      class: cx("ot-btn", variant !== "primary" && variant, spec.pressed && "pressed"),
      title: spec.title ?? (iconOnly ? spec.label : undefined),
      attrs: {
        type: "button",
        disabled: spec.disabled === true,
        "aria-label": iconOnly ? spec.label : undefined,
        "aria-pressed": spec.pressed === undefined ? undefined : String(spec.pressed),
        "data-focus": spec.focusKey,
        ...spec.attrs,
      },
      ...(spec.onClick ? { on: { click: spec.onClick } } : {}),
    },
    [spec.icon ? icon(spec.icon) : null, iconOnly ? null : spec.icon ? ` ${spec.label}` : spec.label],
  );
}

/** The panel's top bar: what it is about on the left, actions on the right. */
export function toolbar(spec: {
  readonly title: VChild;
  readonly context?: readonly VChild[];
  readonly actions?: readonly VChild[];
  readonly label?: string;
}): VNode {
  return v("header", { class: "ot-toolbar" }, [
    v("div", { class: "ot-toolbar-start" }, [
      v("h1", { class: "ot-title" }, [spec.title]),
      spec.context?.length ? v("div", { class: "ot-context" }, spec.context) : null,
    ]),
    spec.actions?.length
      ? v(
          "div",
          { class: "ot-toolbar-end", attrs: { role: "toolbar", "aria-label": spec.label ?? "Actions" } },
          spec.actions,
        )
      : null,
  ]);
}

/** A small labelled value ("Sentinel", "last 24h", "prod ✓ 120"). */
export function chip(spec: {
  readonly text: string;
  readonly tone?: Tone;
  readonly icon?: string;
  readonly title?: string;
  readonly strong?: string;
}): VNode {
  return v("span", { class: cx("ot-chip", spec.tone), title: spec.title }, [
    spec.icon ? icon(spec.icon) : null,
    spec.strong ? v("strong", { text: spec.strong }) : null,
    spec.text,
  ]);
}

/** A count in a pill. */
export function countBadge(count: number, label?: string): VNode {
  return v("span", {
    class: "ot-badge",
    text: String(count),
    attrs: label ? { "aria-label": `${count} ${label}` } : {},
  });
}

/** A badge naming an action or a state ("create", "merge", "this rule"). */
export function badge(text: string, tone?: Tone | string, title?: string): VNode {
  return v("span", { class: cx("ot-tag", tone), text, title });
}

export interface SegmentOption {
  readonly value: string;
  readonly label: string;
  readonly title?: string;
  readonly disabled?: boolean;
  readonly icon?: string;
}

/** The option an arrow key moves to: the next enabled one, wrapping (WAI-ARIA radio group). */
export function nextOption(
  options: readonly SegmentOption[],
  current: string,
  key: string,
): SegmentOption | undefined {
  const enabled = options.filter((o) => !o.disabled);
  if (enabled.length === 0) return undefined;
  const at = Math.max(
    0,
    enabled.findIndex((o) => o.value === current),
  );
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return enabled[(at + 1) % enabled.length];
    case "ArrowLeft":
    case "ArrowUp":
      return enabled[(at - 1 + enabled.length) % enabled.length];
    case "Home":
      return enabled[0];
    case "End":
      return enabled[enabled.length - 1];
    default:
      return undefined;
  }
}

/** A segmented control (one choice of a few): a radio group of buttons with arrow-key movement. */
export function segmented(spec: {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly SegmentOption[];
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}): VNode {
  const keydown = (event: UiEvent) => {
    const next = event.key ? nextOption(spec.options, spec.value, event.key) : undefined;
    if (!next || spec.disabled) return;
    event.preventDefault();
    requestFocus(`${spec.name}:${next.value}`);
    if (next.value !== spec.value) spec.onChange(next.value);
  };
  return v(
    "div",
    { class: "ot-segmented", attrs: { role: "radiogroup", "aria-label": spec.label } },
    spec.options.map((option) => {
      const checked = option.value === spec.value;
      return v(
        "button",
        {
          class: cx("ot-segment", checked && "checked"),
          title: option.title,
          attrs: {
            type: "button",
            role: "radio",
            "aria-checked": String(checked),
            tabindex: checked ? 0 : -1,
            disabled: spec.disabled === true || option.disabled === true,
            "data-focus": `${spec.name}:${option.value}`,
          },
          on: {
            click: () => {
              if (!checked) spec.onChange(option.value);
            },
            keydown,
          },
        },
        [option.icon ? icon(option.icon) : null, option.icon ? ` ${option.label}` : option.label],
      );
    }),
  );
}

/**
 * A thin progress bar along the top of a region. It is always there, so nothing moves when work
 * starts or stops; `active` shows it (indeterminate unless `value` 0–1 is given).
 */
export function progressBar(spec: {
  readonly active: boolean;
  readonly label: string;
  readonly value?: number;
}) {
  const determinate = spec.value !== undefined;
  return v(
    "div",
    {
      class: cx("ot-progress", spec.active && "active", determinate && "determinate"),
      attrs: {
        role: "progressbar",
        "aria-label": spec.label,
        "aria-hidden": spec.active ? undefined : "true",
        "aria-valuemin": determinate ? 0 : undefined,
        "aria-valuemax": determinate ? 100 : undefined,
        "aria-valuenow": determinate ? Math.round((spec.value ?? 0) * 100) : undefined,
      },
    },
    [
      v("div", {
        class: "ot-progress-bar",
        ...(determinate ? { style: { width: `${Math.round((spec.value ?? 0) * 100)}%` } } : {}),
      }),
    ],
  );
}

/** Placeholder rows while data loads, the height the data will take (no layout shift). */
export function skeletonRows(spec: {
  readonly rows: number;
  readonly columns?: number;
  readonly label?: string;
}) {
  const columns = Math.max(1, spec.columns ?? 4);
  return v(
    "div",
    { class: "ot-skeleton", attrs: { "aria-busy": "true", "aria-label": spec.label ?? "Loading" } },
    Array.from({ length: spec.rows }, (_, r) =>
      v(
        "div",
        { class: "ot-skeleton-row", attrs: { "aria-hidden": "true" } },
        Array.from({ length: columns }, (_, c) =>
          v("span", { class: cx("ot-skeleton-cell", (r + c) % 3 === 0 && "short") }),
        ),
      ),
    ),
  );
}

export interface ActionSpec {
  readonly label: string;
  readonly run: () => void;
  readonly icon?: string;
}

/** Nothing to show yet, and what to do about it. */
export function emptyState(spec: {
  readonly title: string;
  readonly body?: string;
  readonly icon?: string;
  readonly action?: ActionSpec;
  readonly secondary?: readonly ActionSpec[];
}): VNode {
  return v("section", { class: "ot-state", attrs: { role: "status" } }, [
    icon(spec.icon ?? "circle-large-outline", undefined, "ot-state-icon"),
    v("h2", { class: "ot-state-title", text: spec.title }),
    spec.body ? v("p", { class: "ot-state-body", text: spec.body }) : null,
    actions(spec.action, spec.secondary),
  ]);
}

/**
 * Something failed: what, why (the code), one primary action, and "Show output" for the log. Never more
 * than one primary button.
 */
export function errorState(spec: {
  readonly title: string;
  readonly body?: string;
  readonly code?: string;
  readonly action?: ActionSpec;
  readonly secondary?: readonly ActionSpec[];
  readonly onShowOutput?: () => void;
}): VNode {
  const secondary = [
    ...(spec.secondary ?? []),
    ...(spec.onShowOutput ? [{ label: "Show output", icon: "output", run: spec.onShowOutput }] : []),
  ];
  return v("section", { class: "ot-state error", attrs: { role: "alert" } }, [
    icon("error", undefined, "ot-state-icon"),
    v("h2", { class: "ot-state-title", text: spec.title }),
    spec.body ? v("p", { class: "ot-state-body", text: spec.body }) : null,
    spec.code ? v("code", { class: "ot-state-code", text: spec.code }) : null,
    actions(spec.action, secondary),
  ]);
}

function actions(
  primary: ActionSpec | undefined,
  secondary: readonly ActionSpec[] | undefined,
): VNode | null {
  if (!primary && !secondary?.length) return null;
  return v("div", { class: "ot-state-actions" }, [
    primary
      ? button({
          label: primary.label,
          ...(primary.icon ? { icon: primary.icon } : {}),
          onClick: () => primary.run(),
        })
      : null,
    ...(secondary ?? []).map((action) =>
      button({
        label: action.label,
        variant: "secondary",
        ...(action.icon ? { icon: action.icon } : {}),
        onClick: () => action.run(),
      }),
    ),
  ]);
}

const CALLOUT_ICONS: Readonly<Record<"info" | "warning" | "error", string>> = {
  info: "info",
  warning: "warning",
  error: "error",
};

/** A note in the flow: info, warning or error, with an optional action. */
export function callout(spec: {
  readonly tone: "info" | "warning" | "error";
  readonly title?: string;
  readonly body: VChild | readonly VChild[];
  readonly actions?: readonly ActionSpec[];
}): VNode {
  const body = Array.isArray(spec.body) ? spec.body : [spec.body as VChild];
  return v(
    "div",
    {
      class: cx("ot-callout", spec.tone),
      attrs: { role: spec.tone === "error" ? "alert" : "note" },
    },
    [
      icon(CALLOUT_ICONS[spec.tone], undefined, "ot-callout-icon"),
      v("div", { class: "ot-callout-body" }, [
        spec.title ? v("strong", { class: "ot-callout-title", text: spec.title }) : null,
        spec.title ? " " : null,
        ...body,
      ]),
      spec.actions?.length
        ? v(
            "div",
            { class: "ot-callout-actions" },
            spec.actions.map((action) =>
              button({
                label: action.label,
                variant: "link",
                ...(action.icon ? { icon: action.icon } : {}),
                onClick: () => action.run(),
              }),
            ),
          )
        : null,
    ],
  );
}

/** A section that folds (`details`), with a count and actions in its heading. */
export function collapsible(spec: {
  readonly id: string;
  readonly title: VChild;
  readonly count?: number;
  readonly countLabel?: string;
  readonly open: boolean;
  readonly meta?: readonly VChild[];
  readonly onToggle?: (open: boolean) => void;
  readonly children: readonly VChild[];
  readonly tone?: Tone;
}): VNode {
  const onToggle = spec.onToggle;
  return v(
    "details",
    {
      class: cx("ot-section", spec.tone),
      attrs: { open: spec.open, "data-key": spec.id },
      ...(onToggle
        ? {
            on: {
              toggle: (event: UiEvent) => onToggle((event.currentTarget as { open?: boolean }).open === true),
            },
          }
        : {}),
    },
    [
      v("summary", { class: "ot-section-head", attrs: { "data-focus": `section:${spec.id}` } }, [
        icon("chevron-right", undefined, "ot-section-chevron"),
        v("span", { class: "ot-section-title" }, [spec.title]),
        spec.count === undefined ? null : countBadge(spec.count, spec.countLabel),
        spec.meta?.length ? v("span", { class: "ot-section-meta" }, spec.meta) : null,
      ]),
      v("div", { class: "ot-section-body" }, spec.children),
    ],
  );
}

/** A number with a label ("12 create"), for summaries. */
export function statCard(spec: {
  readonly label: string;
  readonly value: number | string;
  readonly icon?: string;
  readonly tone?: Tone | string;
  readonly title?: string;
  readonly dim?: boolean;
}): VNode {
  return v(
    "div",
    {
      class: cx("ot-card", spec.tone, spec.dim && "dim"),
      title: spec.title,
      attrs: { role: "group", "aria-label": `${spec.value} ${spec.label}` },
    },
    [
      v("div", { class: "ot-card-value" }, [spec.icon ? icon(spec.icon) : null, ` ${spec.value}`]),
      v("div", { class: "ot-card-label", text: spec.label }),
    ],
  );
}

export type StepState = "done" | "current" | "invalid" | "todo";

const STEP_ICONS: Readonly<Record<StepState, string>> = {
  done: "pass-filled",
  current: "circle-large-filled",
  invalid: "error",
  todo: "circle-large-outline",
};

/** A stepper: each step's state (done, current, invalid, to do); a step is a tab of the wizard. */
export function stepper(spec: {
  readonly label: string;
  readonly steps: readonly {
    readonly id: string;
    readonly label: string;
    readonly state: StepState;
    readonly number: number;
    readonly disabled?: boolean;
  }[];
  readonly onSelect: (id: string) => void;
}): VNode {
  const ids = spec.steps.filter((s) => !s.disabled).map((s) => s.id);
  return v(
    "div",
    { class: "ot-stepper", attrs: { role: "tablist", "aria-label": spec.label } },
    spec.steps.map((step, index) => {
      const current = step.state === "current";
      const stateText = { done: "done", current: "current step", invalid: "needs attention", todo: "" }[
        step.state
      ];
      return v(
        "button",
        {
          class: cx("ot-step", step.state),
          attrs: {
            type: "button",
            role: "tab",
            id: `tab-${step.id}`,
            "aria-selected": String(current),
            "aria-controls": `step-${step.id}`,
            "aria-label": `Step ${step.number}: ${step.label}${stateText ? `, ${stateText}` : ""}`,
            tabindex: current ? 0 : -1,
            disabled: step.disabled === true,
            "data-focus": `step:${step.id}`,
          },
          on: {
            click: () => spec.onSelect(step.id),
            keydown: (event: UiEvent) => {
              const at = ids.indexOf(step.id);
              const next =
                event.key === "ArrowRight"
                  ? ids[at + 1]
                  : event.key === "ArrowLeft"
                    ? ids[at - 1]
                    : event.key === "Home"
                      ? ids[0]
                      : event.key === "End"
                        ? ids[ids.length - 1]
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              requestFocus(`step:${next}`);
              spec.onSelect(next);
            },
          },
        },
        [
          v("span", { class: "ot-step-marker", attrs: { "aria-hidden": "true" } }, [
            step.state === "todo" || step.state === "current"
              ? v("span", { class: "ot-step-number", text: String(step.number) })
              : icon(STEP_ICONS[step.state]),
          ]),
          v("span", { class: "ot-step-label", text: step.label }),
          index < spec.steps.length - 1
            ? v("span", { class: "ot-step-line", attrs: { "aria-hidden": "true" } })
            : null,
        ],
      );
    }),
  );
}

/** A keyboard hint in muted text: "↑↓ move · Enter opens". */
export function keyHint(text: string): VNode {
  return v("span", { class: "ot-hint", text });
}
