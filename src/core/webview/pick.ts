// A pick from a list that the webview asks the host to show as VS Code's own QuickPick, instead of a
// native <select> (whose popup is Chromium's, the one control in a webview that does not look like VS
// Code). Shared by both sides, with no vscode and no DOM: the messages and their validators, and the
// mapping from a request to QuickPick items and back. The host answers every `pick` in
// `createWebviewHelpers.connect`, so a feature's own protocol does not list it.
import { is, type Validators } from "./protocol";

export interface PickItem {
  /** What the pick returns for this item (a column name, a folder path); "" is allowed. */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

/** webview → host: show this list. */
export interface PickRequest {
  /** Chosen by the webview, echoed in the answer. */
  readonly id: string;
  readonly title?: string;
  readonly placeHolder?: string;
  readonly items: readonly PickItem[];
  /** The value(s) now chosen: marked in the list, and the starting selection of a multi-pick. */
  readonly current: readonly string[];
  readonly canPickMany?: boolean;
}

/** host → webview: what was chosen (`values`), or null when the picker was dismissed. */
export interface PickResult {
  readonly id: string;
  readonly values: readonly string[] | null;
}

export const MAX_PICK_ITEMS = 5000;
const MAX_TEXT = 500;
const MAX_ID = 64;

const text = (value: unknown, max = MAX_TEXT): value is string =>
  typeof value === "string" && value.length <= max;
const optionalText = (value: unknown): boolean => value === undefined || text(value);

function isPickItem(value: unknown): value is PickItem {
  return (
    is.object(value) &&
    typeof value.value === "string" &&
    value.value.length <= MAX_TEXT &&
    text(value.label) &&
    value.label.length > 0 &&
    optionalText(value.description) &&
    optionalText(value.detail)
  );
}

export function isPickRequest(value: unknown): value is PickRequest {
  if (!is.object(value)) return false;
  if (!text(value.id, MAX_ID) || value.id.length === 0) return false;
  if (!optionalText(value.title) || !optionalText(value.placeHolder)) return false;
  if (value.canPickMany !== undefined && typeof value.canPickMany !== "boolean") return false;
  if (!Array.isArray(value.items) || value.items.length > MAX_PICK_ITEMS || !value.items.every(isPickItem))
    return false;
  if (!Array.isArray(value.current) || !value.current.every((v) => typeof v === "string")) return false;
  const values = new Set(value.items.map((item: PickItem) => item.value));
  // One item per value: the answer names the item by it.
  return values.size === value.items.length;
}

export function isPickResult(value: unknown): value is PickResult {
  return (
    is.object(value) &&
    text(value.id, MAX_ID) &&
    (value.values === null ||
      (Array.isArray(value.values) && value.values.every((v) => typeof v === "string")))
  );
}

/** The message types of a pick, as `toHost` and `toWebview` validators. */
export const pickToHost: Validators<{ pick: PickRequest }> = { pick: isPickRequest };
export const pickToWebview: Validators<{ picked: PickResult }> = { picked: isPickResult };

/** What `showQuickPick` is given for one item: the value rides along to map the answer back. */
export interface QuickPickEntry {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  /** A multi-pick's starting selection. */
  readonly picked?: boolean;
}

/** The current choice is marked `current` in the description (a single pick has no other mark). */
export const CURRENT_MARK = "current";

export function quickPickEntries(request: PickRequest): QuickPickEntry[] {
  const current = new Set(request.current);
  return request.items.map((item) => {
    const isCurrent = current.has(item.value);
    const mark = isCurrent && !request.canPickMany;
    const description = mark
      ? item.description
        ? `${item.description} · ${CURRENT_MARK}`
        : CURRENT_MARK
      : item.description;
    return {
      value: item.value,
      label: item.label,
      ...(description !== undefined ? { description } : {}),
      ...(item.detail !== undefined ? { detail: item.detail } : {}),
      ...(request.canPickMany ? { picked: isCurrent } : {}),
    };
  });
}

/** The answer to a request from what `showQuickPick` returned: nothing (or no entry) is a dismissal. */
export function pickResult(
  request: PickRequest,
  chosen: QuickPickEntry | readonly QuickPickEntry[] | undefined,
): PickResult {
  if (chosen === undefined) return { id: request.id, values: null };
  const list = Array.isArray(chosen) ? (chosen as readonly QuickPickEntry[]) : [chosen as QuickPickEntry];
  return { id: request.id, values: list.map((entry) => entry.value) };
}

/** The text a pick button shows: the labels of the current items, joined (the first item's, if none match). */
export function pickLabel(items: readonly PickItem[], current: readonly string[]): string {
  const chosen = items.filter((item) => current.includes(item.value));
  if (chosen.length === 0) return items[0]?.label ?? "";
  return chosen.map((item) => item.label).join(", ");
}
