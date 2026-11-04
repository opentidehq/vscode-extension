// Small DOM helpers of the graph page.

export type Child = Node | string | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
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

/** A codicon (the bundled font), hidden from screen readers: its meaning is in the text beside it. */
export function icon(name: string, extra = ""): HTMLSpanElement {
  return h("span", { class: `codicon codicon-${name}${extra ? ` ${extra}` : ""}`, "aria-hidden": "true" });
}

/** A toolbar button: an icon, an optional text, the label as its accessible name and tooltip. */
export function iconButton(
  name: string,
  label: string,
  options: { text?: string; pressed?: boolean; extra?: Record<string, string> } = {},
): HTMLButtonElement {
  const button = h(
    "button",
    {
      type: "button",
      class: "icon-button",
      "aria-label": label,
      title: label,
      ...(options.pressed !== undefined ? { "aria-pressed": String(options.pressed) } : {}),
      ...(options.extra ?? {}),
    },
    icon(name),
    options.text ? h("span", { class: "text", text: options.text }) : undefined,
  );
  return button;
}

export const CSS_ESCAPE = (value: string): string => (window.CSS?.escape ? window.CSS.escape(value) : value);

export const reducedMotion = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
