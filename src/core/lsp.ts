// Pure pieces of the language client: the document selector, `experimental.opentide`, and the
// `opentide.showReferences` argument conversion. vscode-free (types only).
import type * as vscode from "vscode";
import type { Location as LspLocation, Position as LspPosition } from "vscode-languageclient";
import type { OpentideServerInfo } from "./context";

/** Every language the server handles, by id and by file pattern (copied from `@opentide/lsp-client`,
 * language-server#191, plus `opentide-config`, language-server#197). */
export const LANGUAGES: readonly { id: string; patterns: readonly string[] }[] = [
  { id: "opentide-yaml", patterns: ["**/objects/**/*.yaml", "**/objects/**/*.yml"] },
  { id: "opentide-config", patterns: ["**/.opentide/configurations/**/*.toml"] },
  { id: "kql", patterns: ["**/*.kql"] },
  { id: "spl", patterns: ["**/*.spl"] },
  { id: "esql", patterns: ["**/*.esql"] },
  { id: "eql", patterns: ["**/*.eql"] },
  { id: "kuery", patterns: ["**/*.kuery"] },
  { id: "lucene", patterns: ["**/*.lucene"] },
  { id: "falco", patterns: ["**/*.falco"] },
];

export const DOCUMENT_SELECTOR: ({ language: string } | { scheme: string; pattern: string })[] =
  LANGUAGES.flatMap((language) => [
    { language: language.id },
    ...language.patterns.map((pattern) => ({ scheme: "file", pattern })),
  ]);

export const LANGUAGE_IDS = LANGUAGES.map((language) => language.id);

/** `capabilities.experimental.opentide`, when the server sent one that looks right. */
export function readServerInfo(experimental: unknown): OpentideServerInfo | undefined {
  const value = (experimental as { opentide?: unknown } | undefined)?.opentide;
  if (!value || typeof value !== "object") return undefined;
  const info = value as Partial<OpentideServerInfo>;
  return typeof info.engine === "string" ? (value as OpentideServerInfo) : undefined;
}

/** The arguments of the server's `opentide.showReferences` lens, converted for `editor.action.showReferences`. */
export function convertShowReferencesArgs(
  args: readonly unknown[],
  convert: {
    asUri(value: string): vscode.Uri;
    asPosition(value: LspPosition): vscode.Position;
    asLocation(value: LspLocation): vscode.Location;
  },
): [vscode.Uri, vscode.Position, vscode.Location[]] | undefined {
  const [uri, position, locations] = args;
  if (typeof uri !== "string" || !position || typeof position !== "object" || !Array.isArray(locations))
    return undefined;
  return [
    convert.asUri(uri),
    convert.asPosition(position as LspPosition),
    locations.map((location) => convert.asLocation(location as LspLocation)),
  ];
}
