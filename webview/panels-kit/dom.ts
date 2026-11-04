// DOM helpers for the panels' webviews (query results, deploy plan, ATT&CK matrix, setup). The kit's
// components (src/core/webview/kit/components.ts) describe elements as VNodes; `mount` builds them.
// Styles are dist/webview/kit.css, linked by the page (theme variables and codicons only).
import { keyedPlan } from "../../src/core/webview/kit/keyed";
import { isVNode, takeFocusIntent, type VNode } from "../../src/core/webview/kit/vnode";

export type Child = Node | VNode | string | number | null | undefined | false;

export interface Props {
  readonly id?: string;
  readonly class?: string;
  readonly text?: string;
  readonly title?: string;
  readonly attrs?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly on?: { readonly [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

function setAttrs(element: Element, attrs: Readonly<Record<string, string | number | boolean | undefined>>) {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? "" : String(value));
  }
}

function node(child: Child): Node | undefined {
  if (child === null || child === undefined || child === false) return undefined;
  if (typeof child === "string" || typeof child === "number") return document.createTextNode(String(child));
  if (isVNode(child)) return mount(child);
  return child;
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
  setAttrs(element, props.attrs ?? {});
  for (const [name, handler] of Object.entries(props.on ?? {})) {
    if (handler) element.addEventListener(name, handler as EventListener);
  }
  for (const child of children) {
    const built = node(child);
    if (built) element.append(built);
  }
  return element;
}

/** Build a kit VNode. */
export function mount(vnode: VNode): HTMLElement {
  const element = document.createElement(vnode.tag);
  const { props } = vnode;
  if (props.class) element.className = props.class;
  if (props.text !== undefined) element.textContent = props.text;
  if (props.title) element.title = props.title;
  setAttrs(element, props.attrs ?? {});
  for (const [name, value] of Object.entries(props.style ?? {})) element.style.setProperty(name, value);
  for (const [name, handler] of Object.entries(props.on ?? {}))
    element.addEventListener(name, handler as unknown as EventListener);
  for (const child of vnode.children) {
    const built = node(child as Child);
    if (built) element.append(built);
  }
  return element;
}

function nodes(children: readonly Child[]): Node[] {
  return children.flatMap((c) => {
    const built = node(c);
    return built ? [built] : [];
  });
}

/**
 * Replace an element's children, keeping the keyboard focus where it was: on the element a handler asked
 * for (`requestFocus`), else on the new element with the focused one's `data-focus` key.
 */
export function replace(element: Element, ...children: readonly Child[]): void {
  const active = document.activeElement as HTMLElement | null;
  const had = active && element.contains(active) ? active.dataset.focus : undefined;
  const wanted = takeFocusIntent() ?? had;
  element.replaceChildren(...nodes(children));
  if (wanted) focusKey(wanted, element);
}

/** Focus the element with this `data-focus` key, if there is one. */
export function focusKey(key: string, within: ParentNode = document): boolean {
  const target = within.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`);
  if (!target) return false;
  target.focus({ preventScroll: false });
  return true;
}

/**
 * Update a container's children by key: items whose key stays are updated in place (`update`), new
 * ones built (`create`), gone ones removed; nothing else is touched. Children carry `data-key`.
 */
export function patchKeyed<T>(
  container: HTMLElement,
  items: readonly T[],
  key: (item: T) => string,
  create: (item: T) => HTMLElement,
  update: (element: HTMLElement, item: T) => void,
): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) {
    const k = (child as HTMLElement).dataset.key;
    if (k !== undefined) existing.set(k, child as HTMLElement);
  }
  const keys = items.map(key);
  const plan = keyedPlan([...existing.keys()], keys);
  for (const gone of plan.remove) existing.get(gone)?.remove();
  let previous: HTMLElement | null = null;
  items.forEach((item, index) => {
    const k = keys[index] ?? "";
    let element = existing.get(k);
    if (element) update(element, item);
    else {
      element = create(item);
      element.dataset.key = k;
    }
    const expected: Element | null = previous ? previous.nextElementSibling : container.firstElementChild;
    if (expected !== element) {
      if (previous) previous.after(element);
      else container.prepend(element);
    }
    previous = element;
  });
}

/** Set an element's text only when it changed (no layout work otherwise). */
export function setText(element: Element, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** Toggle a class only when needed. */
export function setClass(element: Element, name: string, on: boolean): void {
  if (element.classList.contains(name) !== on) element.classList.toggle(name, on);
}

/**
 * Add a page-specific stylesheet. The page's CSP allows styles from the extension and with the page's
 * nonce, which the page's own script element carries.
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

/** Run `work` at most once per animation frame (scroll, resize, hover). */
export function frameThrottle(work: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      work();
    });
  };
}
