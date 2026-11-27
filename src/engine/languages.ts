// The languages the server handles, and the web's document selector. No Node built-ins.

/**
 * Each object type's language: the Explorer, tabs, breadcrumbs and Quick Open draw a language's icon, and only
 * a language's (contrib/core.json), so a threat, an objective and a rule each have one. The server treats them
 * as `opentide-yaml` (docs/CONTRACTS.md). `opentide-yaml` stays the language of an object of no known type.
 */
export const OBJECT_TYPE_LANGUAGES: Readonly<Record<"threat" | "objective" | "rule", string>> = {
  threat: "opentide-threat",
  objective: "opentide-objective",
  rule: "opentide-rule",
};

/** Every language of an object file: `opentide-yaml` and each type's. */
export const OBJECT_LANGUAGES: readonly string[] = ["opentide-yaml", ...Object.values(OBJECT_TYPE_LANGUAGES)];

/** Is `id` the language of an object file (of any type)? */
export function isObjectLanguage(id: string | undefined): boolean {
  return id !== undefined && OBJECT_LANGUAGES.includes(id);
}

/** The language of an object of `type`, `opentide-yaml` for no type or one this map does not know. */
export function objectLanguageOf(type: string | undefined): string {
  return type !== undefined && Object.hasOwn(OBJECT_TYPE_LANGUAGES, type)
    ? OBJECT_TYPE_LANGUAGES[type as keyof typeof OBJECT_TYPE_LANGUAGES]
    : "opentide-yaml";
}

const yamlIn = (folder: string): string[] => [
  `**/objects/${folder}/**/*.yaml`,
  `**/objects/${folder}/**/*.yml`,
];

/** Every language the server handles, by id and by file pattern (copied from `@opentide/lsp-client`,
 * language-server#191, plus `opentide-config`, language-server#197). */
export const LANGUAGES: readonly { id: string; patterns: readonly string[] }[] = [
  { id: "opentide-yaml", patterns: ["**/objects/**/*.yaml", "**/objects/**/*.yml"] },
  { id: "opentide-threat", patterns: yamlIn("threats") },
  { id: "opentide-objective", patterns: yamlIn("objectives") },
  { id: "opentide-rule", patterns: yamlIn("rules") },
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
