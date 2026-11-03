// Small DOM helpers for the panels stream's webviews (query results, deploy plan, ATT&CK matrix).

type Child = Node | string | number | null | undefined | false;

export interface Props {
  readonly id?: string;
  readonly class?: string;
  readonly text?: string;
  readonly title?: string;
  readonly attrs?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly on?: { readonly [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

/** Create an element: `h("button", { class: "secondary", on: { click } }, ["Re-run"])`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.id) element.id = props.id;
  if (props.class) element.className = props.class;
  if (props.text !== undefined) element.textContent = props.text;
  if (props.title) element.title = props.title;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? "" : String(value));
  }
  for (const [name, handler] of Object.entries(props.on ?? {})) {
    if (handler) element.addEventListener(name, handler as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "number" ? String(child) : child);
  }
  return element;
}

/** Replace an element's children. */
export function replace(element: Element, ...children: readonly Child[]): void {
  element.replaceChildren(
    ...children.flatMap((c) =>
      c === null || c === undefined || c === false ? [] : [typeof c === "number" ? String(c) : c],
    ),
  );
}

/**
 * Add a stylesheet. The page's CSP allows styles from the extension and with the page's nonce, which the
 * page's own script element carries.
 */
export function addStyles(css: string): void {
  const style = document.createElement("style");
  const script = document.querySelector<HTMLScriptElement>("script[nonce]");
  if (script?.nonce) style.nonce = script.nonce;
  style.textContent = css;
  document.head.append(style);
}

let live: HTMLElement | undefined;

/** Say something to screen readers (an ARIA live region). */
export function announce(text: string): void {
  if (!live) {
    live = h("div", { class: "visually-hidden", attrs: { role: "status", "aria-live": "polite" } });
    document.body.append(live);
  }
  live.textContent = "";
  const region = live;
  setTimeout(() => {
    region.textContent = text;
  }, 30);
}

/** A codicon-free icon glyph with a text alternative (webviews get no codicon font). */
export function glyph(symbol: string, label: string): HTMLSpanElement {
  return h("span", { class: "glyph", text: symbol, attrs: { "aria-hidden": "true", title: label } });
}

/** The globe that marks what contacts a tenant (SPEC P5), as inline SVG in the text colour. */
export function globeIcon(label = "Contacts tenants"): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("class", "icon-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const paths = [
    "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z",
    "M1.5 8h13",
    "M8 1.5c1.8 1.9 2.7 4 2.7 6.5S9.8 12.6 8 14.5C6.2 12.6 5.3 10.5 5.3 8S6.2 3.4 8 1.5Z",
  ];
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.1");
    svg.append(path);
  }
  return svg;
}

/** An empty, loading or error state with a next action. */
export function stateBox(options: {
  readonly kind: "empty" | "loading" | "error" | "info";
  readonly title: string;
  readonly body?: string;
  readonly actions?: readonly {
    readonly label: string;
    readonly run: () => void;
    readonly secondary?: boolean;
  }[];
}): HTMLElement {
  const symbols = { empty: "○", loading: "◌", error: "✕", info: "ℹ" };
  return h(
    "section",
    { class: `state state-${options.kind}`, attrs: { role: options.kind === "error" ? "alert" : "status" } },
    [
      h("div", {
        class: `state-icon${options.kind === "loading" ? " spin" : ""}`,
        text: symbols[options.kind],
        attrs: { "aria-hidden": "true" },
      }),
      h("h2", { text: options.title }),
      options.body ? h("p", { class: "muted", text: options.body }) : null,
      options.actions?.length
        ? h(
            "div",
            { class: "actions" },
            options.actions.map((action) =>
              h("button", {
                class: action.secondary ? "secondary" : "",
                text: action.label,
                on: { click: action.run },
              }),
            ),
          )
        : null,
    ],
  );
}

/** Styles every panel of this stream shares. Theme variables only. */
export const KIT_CSS = `
body { padding: 0 16px 16px; }
h1 { font-size: 1.3em; font-weight: 600; margin: 12px 0 4px; }
h2 { font-size: 1.1em; font-weight: 600; margin: 12px 0 6px; }
h3 { font-size: 1em; font-weight: 600; margin: 10px 0 4px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0; }
.toolbar .spacer { flex: 1; }
.toolbar label { display: inline-flex; gap: 4px; align-items: center; }
.chip { display: inline-flex; gap: 6px; align-items: center; padding: 2px 8px; border-radius: 10px;
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.92em; }
.chip.ok { background: transparent; color: var(--vscode-foreground); border-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.chip.failed { background: transparent; color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
.chip.pending { background: transparent; color: var(--vscode-descriptionForeground); }
.glyph { display: inline-block; min-width: 1em; text-align: center; }
.icon-svg { vertical-align: -2px; }
.state { margin: 32px auto; max-width: 520px; text-align: center; }
.state .state-icon { font-size: 2em; color: var(--vscode-descriptionForeground); }
.state-error .state-icon { color: var(--vscode-errorForeground); }
.state .actions { display: flex; gap: 8px; justify-content: center; margin-top: 12px; }
.spin { animation: spin 1.2s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
.banner { border-left: 3px solid var(--vscode-editorWarning-foreground); padding: 4px 8px; margin: 6px 0;
  background: var(--vscode-inputValidation-warningBackground, transparent); }
.banner.info { border-left-color: var(--vscode-focusBorder); background: transparent; }
.banner.error { border-left-color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground, transparent); }
.footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
.cmdline { display: block; padding: 4px 8px; white-space: pre-wrap; word-break: break-all;
  background: var(--vscode-textCodeBlock-background); border-radius: 2px; }
button.link { background: none; border: none; color: var(--vscode-textLink-foreground); padding: 0; cursor: pointer; text-align: left; }
button.link:hover { text-decoration: underline; background: none; }
button.icon { padding: 2px 6px; }
details > summary { cursor: pointer; }
.badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 0.85em;
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
`;
