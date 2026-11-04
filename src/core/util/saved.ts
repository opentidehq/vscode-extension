// opentide reads rules from disk, so a command on a rule with unsaved edits would act on the saved
// version without saying so. Before such a command: save the edits, use the saved version, or stop.
// vscode-free: a `vscode.TextDocument` and `vscode.window.showWarningMessage` qualify.

export interface SavableDocument {
  readonly isDirty: boolean;
  save(): PromiseLike<boolean>;
}

export type Ask = (message: string, ...items: string[]) => PromiseLike<string | undefined>;

/**
 * Asks, when one of `documents` has unsaved edits, "opentide <verb> the saved rule. Save it first?" with
 * "Save and <action>" and "<action> Saved Version". True when the command may go on: nothing was dirty,
 * the edits were saved, or the person chose the saved version; false on Escape or a failed save.
 */
export async function ensureSaved(
  documents: readonly SavableDocument[],
  wording: { readonly verb: string; readonly action: string },
  ask: Ask,
): Promise<boolean> {
  const dirty = documents.filter((document) => document.isDirty);
  if (dirty.length === 0) return true;
  const what = dirty.length === 1 ? "the saved rule. Save it" : "the saved rules. Save them";
  const save = `Save and ${wording.action}`;
  const saved = `${wording.action} Saved Version${dirty.length === 1 ? "" : "s"}`;
  const answer = await ask(`opentide ${wording.verb} ${what} first?`, save, saved);
  if (answer === saved) return true;
  if (answer !== save) return false;
  for (const document of dirty) if (!(await document.save())) return false;
  return true;
}
