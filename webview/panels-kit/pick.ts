// A pick from a list that opens VS Code's own QuickPick (see src/core/webview/pick.ts): a button that
// looks like VS Code's dropdown, replacing a native <select> whose popup is Chromium's. Clicking it, or
// Enter, Space or the arrow keys on it, posts a `pick` to the host; the host's `picked` answer changes the
// value, and Escape in the picker leaves it alone. The focus returns to the button either way.
import {
  isPickResult,
  type PickItem,
  type PickRequest,
  type PickResult,
  pickLabel,
} from "../../src/core/webview/pick";
import { vscodeApi } from "../shared/channel";
import { h } from "./dom";

const waiting = new Map<string, (result: PickResult) => void>();
let listening = false;
let counter = 0;

/** Ask the host to show `request` (its `id` is set here); the chosen values, or undefined if dismissed. */
export function requestPick(request: Omit<PickRequest, "id">): Promise<readonly string[] | undefined> {
  if (!listening) {
    listening = true;
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: unknown; payload?: unknown } | null;
      if (data?.type !== "picked" || !isPickResult(data.payload)) return;
      const resolve = waiting.get(data.payload.id);
      if (!resolve) return;
      waiting.delete(data.payload.id);
      resolve(data.payload);
    });
  }
  const id = `pick-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    waiting.set(id, (result) => resolve(result.values ?? undefined));
    vscodeApi().postMessage({ type: "pick", payload: { ...request, id } });
  });
}

export interface PickButtonOptions {
  /** The accessible name of the control (the value is added: "Filter in column: all columns"). */
  readonly label: string;
  /** The picker's title. */
  readonly title?: string;
  readonly placeHolder?: string;
  readonly focusKey?: string;
  /** Called with the new value after a pick that changed it. */
  readonly onChange: (value: string) => void;
}

/** A single-choice pick button: `value` is the chosen item's value; `setItems` and `setValue` redraw it. */
export class PickButton {
  readonly element: HTMLButtonElement;
  private readonly text: HTMLSpanElement;
  private items: readonly PickItem[] = [];
  private current = "";
  private open = false;

  constructor(private readonly options: PickButtonOptions) {
    this.text = h("span", { class: "ot-pick-value" });
    this.element = h(
      "button",
      {
        class: "ot-pick",
        attrs: {
          type: "button",
          "aria-haspopup": "listbox",
          "aria-expanded": "false",
          ...(options.focusKey ? { "data-focus": options.focusKey } : {}),
        },
        on: {
          click: () => void this.pick(),
          // A <select> opens on the arrow keys too.
          keydown: (event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              void this.pick();
            }
          },
        },
      },
      [this.text, h("span", { class: "codicon codicon-chevron-down", attrs: { "aria-hidden": "true" } })],
    );
    this.paint();
  }

  get itemCount(): number {
    return this.items.length;
  }

  get value(): string {
    return this.current;
  }

  setItems(items: readonly PickItem[], value = this.current): void {
    this.items = items;
    this.setValue(value);
  }

  /** A value the items do not have becomes the first item's (as a <select> does). */
  setValue(value: string): void {
    this.current = this.items.some((item) => item.value === value) ? value : (this.items[0]?.value ?? "");
    this.paint();
  }

  private paint(): void {
    const label = pickLabel(this.items, [this.current]);
    this.text.textContent = label;
    this.element.setAttribute("aria-label", `${this.options.label}: ${label}`);
    this.element.title = this.options.label;
    this.element.setAttribute("aria-expanded", String(this.open));
  }

  private async pick(): Promise<void> {
    if (this.open || this.items.length === 0) return;
    this.open = true;
    this.paint();
    try {
      const values = await requestPick({
        ...(this.options.title ? { title: this.options.title } : {}),
        ...(this.options.placeHolder ? { placeHolder: this.options.placeHolder } : {}),
        items: this.items,
        current: [this.current],
      });
      const chosen = values?.[0];
      if (chosen !== undefined && chosen !== this.current) {
        this.setValue(chosen);
        this.options.onChange(this.current);
      }
    } finally {
      this.open = false;
      this.paint();
      // Whatever happened, the focus is back where the user was.
      this.element.focus();
    }
  }
}
