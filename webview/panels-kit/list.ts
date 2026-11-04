// A virtualised list for long lists of rich rows (a deploy plan's 5,000 changes, a technique's rules):
// fixed-height rows from a pool, drawn only while in view. Short lists (up to `threshold`) render plainly.
import { rowWindow } from "../../src/core/webview/kit/virtual";
import { frameThrottle, h } from "./dom";

export interface ListOptions<T> {
  readonly items: readonly T[];
  readonly rowHeight: number;
  /** Builds a row element once (the pool reuses it). */
  readonly create: () => HTMLElement;
  /** Shows `item` in a pooled row element. */
  readonly update: (element: HTMLElement, item: T, index: number) => void;
  /** Lists longer than this are virtualised (default 200). */
  readonly threshold?: number;
  /** The scrolling area's height when virtualised. */
  readonly maxHeight?: string;
  readonly label: string;
  readonly role?: string;
  /** Keeps the scroll position across a rebuild of the list under the same key (a re-run's plan). */
  readonly key?: string;
}

/** Scroll positions of virtualised lists, by key, for the page's lifetime. */
const scrollTops = new Map<string, number>();

export function virtualList<T>(options: ListOptions<T>): HTMLElement {
  const threshold = options.threshold ?? 200;
  const role = options.role ?? "list";
  if (options.items.length <= threshold) {
    const list = h("div", { class: "ot-list", attrs: { role, "aria-label": options.label } });
    options.items.forEach((item, index) => {
      const row = options.create();
      options.update(row, item, index);
      list.append(row);
    });
    return list;
  }
  const spacer = h("div", { class: "ot-vlist-spacer" });
  const body = h("div", { class: "ot-vlist-body" });
  spacer.append(body);
  const viewport = h(
    "div",
    {
      class: "ot-vlist",
      attrs: { role, "aria-label": options.label, tabindex: 0, "aria-rowcount": options.items.length },
    },
    [spacer],
  );
  viewport.style.maxHeight = options.maxHeight ?? "60vh";
  spacer.style.height = `${options.items.length * options.rowHeight}px`;
  const pool: HTMLElement[] = [];
  let key = "";
  const draw = () => {
    const window_ = rowWindow({
      scrollTop: viewport.scrollTop,
      viewportHeight: viewport.clientHeight,
      rowHeight: options.rowHeight,
      count: options.items.length,
      overscan: 6,
      fallbackHeight: 600,
    });
    const next = `${window_.first}:${window_.last}`;
    if (next === key) return;
    key = next;
    while (pool.length < window_.last - window_.first) {
      const row = options.create();
      pool.push(row);
      body.append(row);
    }
    body.style.transform = `translateY(${window_.offset}px)`;
    pool.forEach((row, slot) => {
      const index = window_.first + slot;
      const item = options.items[index];
      if (item === undefined || index >= window_.last) {
        row.hidden = true;
        return;
      }
      row.hidden = false;
      row.setAttribute("aria-posinset", String(index + 1));
      row.setAttribute("aria-setsize", String(options.items.length));
      options.update(row, item, index);
    });
  };
  const schedule = frameThrottle(draw);
  const onScroll = () => {
    if (options.key !== undefined) scrollTops.set(options.key, viewport.scrollTop);
    schedule();
  };
  viewport.addEventListener("scroll", onScroll);
  // A list replaced by a re-render lets go of its observer and listener (its resize fires on removal).
  const observer = new ResizeObserver(() => {
    if (!viewport.isConnected) {
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
      return;
    }
    const saved = options.key === undefined ? undefined : scrollTops.get(options.key);
    if (saved !== undefined && viewport.scrollTop !== saved && viewport.dataset.restored !== "1") {
      viewport.dataset.restored = "1";
      viewport.scrollTop = saved;
    }
    schedule();
  });
  observer.observe(viewport);
  draw();
  return viewport;
}
