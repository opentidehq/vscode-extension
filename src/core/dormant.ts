// Whether a window has opentide content, so the runtime and the language server are worth starting. The extension
// activates in every window on `onStartupFinished` (the agent-knowledge feature sets a context key there), and a
// window with nothing of opentide's must not pay for a runtime it never uses. vscode-free.
import { OBJECT_LANGUAGES } from "../engine/languages";

/** The language ids that mean a file is opentide's own (the others, KQL and so on, are generic query languages). */
export const OPENTIDE_LANGUAGES: ReadonlySet<string> = new Set([...OBJECT_LANGUAGES, "opentide-config"]);

/** An opentide folder in the window, or an open opentide file (a lone rule opened from anywhere). */
export function hasOpentideContent(opentideFolders: number, openLanguageIds: Iterable<string>): boolean {
  if (opentideFolders > 0) return true;
  for (const id of openLanguageIds) if (OPENTIDE_LANGUAGES.has(id)) return true;
  return false;
}
