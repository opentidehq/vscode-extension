// The panels kit's element descriptions (SPEC §10 "Components"). vscode-free and DOM-free: kit components
// return a VNode, which webview/panels-kit/dom.ts turns into elements, so the components are unit-tested
// in plain node.

/** The part of a DOM event the kit's handlers use (a real Event satisfies it). */
export interface UiEvent {
  readonly type: string;
  readonly key?: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly currentTarget: unknown;
  readonly target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

export type Handler = (event: UiEvent) => void;

export type Attr = string | number | boolean | undefined;

export interface VProps {
  readonly class?: string;
  readonly text?: string;
  readonly title?: string;
  readonly attrs?: Readonly<Record<string, Attr>>;
  /** Inline style properties, set through the CSSOM (the CSP allows no `style` attribute). */
  readonly style?: Readonly<Record<string, string>>;
  readonly on?: Readonly<Record<string, Handler>>;
}

/** An element built elsewhere (a webview's own DOM node), placed in a VNode tree as it is. */
export interface Foreign {
  readonly nodeType: number;
}

export type VChild = VNode | Foreign | string | number | null | undefined | false;

export interface VNode {
  readonly kind: "vnode";
  readonly tag: string;
  readonly props: VProps;
  readonly children: readonly VChild[];
}

export function v(tag: string, props: VProps = {}, children: readonly VChild[] = []): VNode {
  return { kind: "vnode", tag, props, children };
}

export function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "vnode";
}

/** Class names, leaving out the falsy ones: `cx("chip", ok && "ok")`. */
export function cx(...names: readonly (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/** The text a VNode shows (for tests and accessible names). */
export function textOf(node: VChild): string {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!isVNode(node)) return "";
  return `${node.props.text ?? ""}${node.children.map(textOf).join("")}`;
}

/** Every VNode in the tree, depth first (for tests). */
export function walk(node: VChild): VNode[] {
  if (!isVNode(node)) return [];
  return [node, ...node.children.flatMap(walk)];
}

/** The first node whose class list has `name` (for tests). */
export function findByClass(node: VChild, name: string): VNode | undefined {
  return walk(node).find((n) => (n.props.class ?? "").split(/\s+/).includes(name));
}

/**
 * Focus to restore after the next render: a handler that re-renders asks for the element with this
 * `data-focus` key, and the webview's render puts the focus there (keyboard users keep their place).
 */
export const focusIntent: { key: string | undefined } = { key: undefined };

export function requestFocus(key: string): void {
  focusIntent.key = key;
}

export function takeFocusIntent(): string | undefined {
  const key = focusIntent.key;
  focusIntent.key = undefined;
  return key;
}
