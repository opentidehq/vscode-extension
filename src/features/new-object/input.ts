// A multi-step quick input with back navigation (VS Code's quick input UX guidelines): one input box or
// quick pick per step, `n/total` in the title bar, a Back button from the second step on.
import * as vscode from "vscode";

export const BACK = Symbol("back");
export type Back = typeof BACK;

export interface StepHeader {
  readonly title: string;
  readonly step: number;
  readonly totalSteps: number;
}

export interface TextStep extends StepHeader {
  readonly value?: string;
  readonly placeholder?: string;
  readonly prompt?: (value: string) => string;
  readonly validate?: (value: string) => string | undefined;
}

/** An input box; resolves to the value, `BACK`, or undefined when dismissed. */
export function askText(options: TextStep): Promise<string | Back | undefined> {
  const box = vscode.window.createInputBox();
  box.title = options.title;
  box.step = options.step;
  box.totalSteps = options.totalSteps;
  box.value = options.value ?? "";
  box.placeholder = options.placeholder;
  box.ignoreFocusOut = true;
  box.buttons = options.step > 1 ? [vscode.QuickInputButtons.Back] : [];
  const update = () => {
    box.prompt = options.prompt?.(box.value);
    box.validationMessage = box.value ? options.validate?.(box.value) : undefined;
  };
  update();
  return new Promise((resolve) => {
    const disposables: vscode.Disposable[] = [];
    const done = (value: string | Back | undefined) => {
      for (const disposable of disposables) disposable.dispose();
      box.dispose();
      resolve(value);
    };
    disposables.push(
      box.onDidChangeValue(update),
      box.onDidTriggerButton((button) => {
        if (button === vscode.QuickInputButtons.Back) done(BACK);
      }),
      box.onDidAccept(() => {
        const invalid = options.validate?.(box.value);
        if (invalid) {
          box.validationMessage = invalid;
          return;
        }
        done(box.value.trim());
      }),
      box.onDidHide(() => done(undefined)),
    );
    box.show();
  });
}

export interface PickStep<T extends vscode.QuickPickItem> extends StepHeader {
  /** The items, or a promise of them (the pick shows busy until they arrive). */
  readonly items: readonly T[] | Promise<readonly T[]>;
  readonly placeholder?: string;
  readonly matchOnDescription?: boolean;
  readonly matchOnDetail?: boolean;
  /** Title-bar buttons besides Back; a press resolves with `{ button }`. */
  readonly buttons?: readonly vscode.QuickInputButton[];
}

export type PickResult<R> = R | Back | { readonly button: vscode.QuickInputButton } | undefined;

function showPick<T extends vscode.QuickPickItem, R>(
  options: PickStep<T> & { readonly canPickMany: boolean },
  accept: (pick: vscode.QuickPick<T>) => R | undefined,
): Promise<PickResult<R>> {
  const pick = vscode.window.createQuickPick<T>();
  pick.title = options.title;
  pick.step = options.step;
  pick.totalSteps = options.totalSteps;
  pick.placeholder = options.placeholder;
  pick.canSelectMany = options.canPickMany;
  pick.ignoreFocusOut = true;
  pick.matchOnDescription = options.matchOnDescription ?? false;
  pick.matchOnDetail = options.matchOnDetail ?? false;
  pick.buttons = [...(options.step > 1 ? [vscode.QuickInputButtons.Back] : []), ...(options.buttons ?? [])];
  const setItems = (items: readonly T[]) => {
    pick.items = items;
    if (options.canPickMany) pick.selectedItems = items.filter((item) => item.picked);
  };
  if (Array.isArray(options.items)) setItems(options.items as readonly T[]);
  else {
    pick.busy = true;
    void (options.items as Promise<readonly T[]>).then(
      (items) => {
        setItems(items);
        pick.busy = false;
      },
      () => {
        pick.busy = false;
      },
    );
  }
  return new Promise((resolve) => {
    const disposables: vscode.Disposable[] = [];
    const done = (value: PickResult<R>) => {
      for (const disposable of disposables) disposable.dispose();
      pick.dispose();
      resolve(value);
    };
    disposables.push(
      pick.onDidTriggerButton((button) => done(button === vscode.QuickInputButtons.Back ? BACK : { button })),
      pick.onDidAccept(() => {
        const value = accept(pick);
        if (value !== undefined) done(value);
      }),
      pick.onDidHide(() => done(undefined)),
    );
    pick.show();
  });
}

/** One item; resolves to it, `BACK`, a button press, or undefined when dismissed. */
export function pickOne<T extends vscode.QuickPickItem>(options: PickStep<T>): Promise<PickResult<T>> {
  return showPick({ ...options, canPickMany: false }, (pick) => pick.selectedItems[0] ?? pick.activeItems[0]);
}

/** Several items (possibly none); resolves to them, `BACK`, a button press, or undefined. */
export function pickMany<T extends vscode.QuickPickItem>(options: PickStep<T>): Promise<PickResult<T[]>> {
  return showPick({ ...options, canPickMany: true }, (pick) => [...pick.selectedItems]);
}

export function isButton(value: unknown): value is { readonly button: vscode.QuickInputButton } {
  return typeof value === "object" && value !== null && "button" in value;
}
