// Popup menus (a toolbar's "Export" menu, a table cell's context menu) and hover cards, with the keyboard
// behaviour of VS Code's own menus: arrows move, Enter runs, Escape closes and gives the focus back.
import { button } from "../../src/core/webview/kit/components";
import { menuMove, placePopup } from "../../src/core/webview/kit/menu";
import { h, mount } from "./dom";

export interface MenuItem {
  readonly label: string;
  readonly icon?: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

export type MenuEntry = MenuItem | "separator";

let openMenu: { element: HTMLElement; restore: HTMLElement | null; close: () => void } | undefined;

/** Close the open menu, if any. */
export function closeMenu(): void {
  openMenu?.close();
}

/** Show a menu at a point or under an element. */
export function showMenu(
  entries: readonly MenuEntry[],
  at:
    | { readonly anchor: HTMLElement; readonly align?: "start" | "end" }
    | { readonly x: number; readonly y: number },
  label = "Menu",
): void {
  closeMenu();
  const restore = document.activeElement as HTMLElement | null;
  const items: HTMLElement[] = [];
  const list = h("div", { class: "ot-menu", attrs: { role: "menu", "aria-label": label, tabindex: -1 } });
  for (const entry of entries) {
    if (entry === "separator") {
      list.append(h("div", { class: "ot-menu-separator", attrs: { role: "separator" } }));
      continue;
    }
    const item = h(
      "div",
      {
        class: "ot-menu-item",
        attrs: { role: "menuitem", tabindex: -1, "aria-disabled": entry.disabled ? "true" : undefined },
        on: {
          click: (event) => {
            event.stopPropagation();
            if (entry.disabled) return;
            close(false);
            entry.run();
          },
          mouseenter: () => item.focus({ preventScroll: true }),
        },
      },
      [
        h("span", { class: `codicon codicon-${entry.icon ?? "blank"}`, attrs: { "aria-hidden": "true" } }),
        h("span", { class: "ot-menu-label", text: entry.label }),
        entry.description ? h("span", { class: "ot-menu-description", text: entry.description }) : null,
      ],
    );
    items.push(item);
    list.append(item);
  }
  const enabled = entries.filter((e): e is MenuItem => e !== "separator").map((e) => !e.disabled);
  const close = (refocus = true) => {
    list.remove();
    document.removeEventListener("mousedown", outside, true);
    window.removeEventListener("blur", blur);
    if (openMenu?.element === list) openMenu = undefined;
    if (refocus) restore?.focus({ preventScroll: true });
  };
  const outside = (event: MouseEvent) => {
    if (!list.contains(event.target as Node)) close(false);
  };
  const blur = () => close(false);
  list.addEventListener("keydown", (event) => {
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = menuMove(event.key, index, enabled);
    if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      close();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      items[index]?.click();
    }
  });
  document.body.append(list);
  const size = { width: list.offsetWidth, height: list.offsetHeight };
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const anchor =
    "anchor" in at ? at.anchor.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
  const align = "anchor" in at ? (at.align ?? "start") : "start";
  const { left, top } = placePopup({ anchor, size, viewport, align, gap: "anchor" in at ? 4 : 0 });
  list.style.left = `${left}px`;
  list.style.top = `${top}px`;
  document.addEventListener("mousedown", outside, true);
  window.addEventListener("blur", blur);
  openMenu = { element: list, restore, close: () => close(false) };
  const first = menuMove("Home", -1, enabled);
  if (first !== undefined) items[first]?.focus({ preventScroll: true });
}

/** A toolbar button that opens a menu (`aria-haspopup`); Down arrow opens it too. */
export function menuButton(spec: {
  readonly label: string;
  readonly icon?: string;
  readonly variant?: "secondary" | "icon";
  readonly title?: string;
  readonly disabled?: boolean;
  readonly focusKey?: string;
  readonly items: () => readonly MenuEntry[];
}): HTMLElement {
  const element = mount(
    button({
      label: spec.label,
      variant: spec.variant ?? "secondary",
      ...(spec.icon ? { icon: spec.icon } : {}),
      ...(spec.title ? { title: spec.title } : {}),
      ...(spec.disabled ? { disabled: true } : {}),
      ...(spec.focusKey ? { focusKey: spec.focusKey } : {}),
      attrs: { "aria-haspopup": "menu", "aria-expanded": "false" },
    }),
  );
  if (spec.variant !== "icon") element.append(h("span", { class: "codicon codicon-chevron-down ot-caret" }));
  const open = () => {
    element.setAttribute("aria-expanded", "true");
    showMenu(spec.items(), { anchor: element, align: "end" }, spec.label);
    const observer = new MutationObserver(() => {
      if (!document.querySelector(".ot-menu")) {
        element.setAttribute("aria-expanded", "false");
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true });
  };
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    open();
  });
  element.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      open();
    }
  });
  return element;
}

let card: HTMLElement | undefined;
let cardTimer: ReturnType<typeof setTimeout> | undefined;
let cardListeners = false;

/** Show a hover card for `anchor` after a short delay (one card at a time, never focusable). */
export function hoverCard(anchor: HTMLElement, content: () => Node, delayMs = 350): void {
  hideHoverCard();
  if (!cardListeners) {
    // The pointer leaving the page (to the editor beside it) or the page losing focus hides the card.
    cardListeners = true;
    document.documentElement.addEventListener("mouseleave", hideHoverCard);
    window.addEventListener("blur", hideHoverCard);
    window.addEventListener("scroll", hideHoverCard, true);
  }
  cardTimer = setTimeout(() => {
    card ??= h("div", { class: "ot-hovercard", attrs: { role: "tooltip" } });
    card.replaceChildren(content());
    document.body.append(card);
    const { left, top } = placePopup({
      anchor: anchor.getBoundingClientRect(),
      size: { width: card.offsetWidth, height: card.offsetHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    anchor.setAttribute("aria-describedby", "ot-hovercard");
    card.id = "ot-hovercard";
  }, delayMs);
}

export function hideHoverCard(): void {
  if (cardTimer) clearTimeout(cardTimer);
  cardTimer = undefined;
  card?.remove();
}
