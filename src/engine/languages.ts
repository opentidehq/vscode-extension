// The languages the server handles, and the web's document selector. No Node built-ins.

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

/**
 * The selector on vscode.dev, github.dev and other virtual workspaces, whose documents are `vscode-vfs:`
 * and other schemes: each language by id, and by file pattern with no scheme (language-server's
 * `WEB_DOCUMENT_SELECTOR`, #197).
 */
export const WEB_DOCUMENT_SELECTOR: ({ language: string } | { pattern: string })[] = LANGUAGES.flatMap(
  (language) => [{ language: language.id }, ...language.patterns.map((pattern) => ({ pattern }))],
);
