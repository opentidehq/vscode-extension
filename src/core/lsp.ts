// Pure pieces of the language client: the document selector, `experimental.opentide`, and the
// `opentide.showReferences` argument conversion. vscode-free (types only).
import { LANGUAGES } from "../engine/languages";

export { LANGUAGES } from "../engine/languages";
export { convertShowReferencesArgs, readServerInfo } from "../engine/lsp";

export const DOCUMENT_SELECTOR: ({ language: string } | { scheme: string; pattern: string })[] =
  LANGUAGES.flatMap((language) => [
    { language: language.id },
    ...language.patterns.map((pattern) => ({ scheme: "file", pattern })),
  ]);

export const LANGUAGE_IDS = LANGUAGES.map((language) => language.id);

/** What a client offers for server notifications (vscode-languageclient keeps one handler per method). */
export interface NotificationSource {
  onNotification(method: string, handler: (params: unknown) => void): { dispose(): void };
}

/** `opentide/catalogChanged`'s params: the root whose index changed, null for the root-less set. */
export interface CatalogChanged {
  readonly root: string | null;
}

/**
 * Take `method` from `client` once and hand each notification to every listener of `fire`: features
 * subscribe to the core's event, so none of them replaces another's handler.
 */
export function forwardNotification(
  client: NotificationSource,
  method: string,
  fire: (params: CatalogChanged) => void,
): { dispose(): void } {
  return client.onNotification(method, (params) => {
    const root = (params as { root?: unknown } | null | undefined)?.root;
    fire({ root: typeof root === "string" ? root : null });
  });
}
