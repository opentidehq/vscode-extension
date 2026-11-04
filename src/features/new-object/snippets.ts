// The workspace's `tide-*` snippets (`.vscode/*.code-snippets`, written by `opentide generate
// snippets` and `opentide setup vscode`). VS Code serves a snippet whose `scope` names
// `opentide-yaml` (opentide#752) or has no scope; the others, scoped to `yaml` alone, vanish in
// object files, so the extension offers those itself (SPEC §7 "Templates and snippets"). vscode-free.

export interface TideSnippet {
  readonly name: string;
  readonly prefix: string;
  readonly body: string;
  readonly description: string;
  /** `tide-<platform>`: a platform block for a rule's `configurations:`. */
  readonly platform: string | undefined;
}

const OBJECT_PREFIXES = new Set(["tide-threat", "tide-objective", "tide-rule"]);

/** JSON with comments and trailing commas, as `.code-snippets` files allow. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next;
        i++;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Does VS Code itself offer a snippet with this `scope` in `opentide-yaml` files? */
export function servedNatively(scope: unknown): boolean {
  if (typeof scope !== "string" || !scope.trim()) return true;
  return scope
    .split(",")
    .map((part) => part.trim())
    .includes("opentide-yaml");
}

/**
 * The `tide-*` snippets of one `.code-snippets` file. `all` includes those VS Code already serves
 * (for "Add <platform> block…"); otherwise only the ones it does not.
 */
export function tideSnippets(text: string, all = false): TideSnippet[] {
  let document: unknown;
  try {
    document = parseJsonc(text);
  } catch {
    return [];
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) return [];
  const out: TideSnippet[] = [];
  for (const [name, value] of Object.entries(document as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const snippet = value as { prefix?: unknown; body?: unknown; description?: unknown; scope?: unknown };
    const prefixes = Array.isArray(snippet.prefix) ? snippet.prefix : [snippet.prefix];
    const prefix = prefixes.find((p): p is string => typeof p === "string" && p.startsWith("tide-"));
    if (!prefix) continue;
    if (!all && servedNatively(snippet.scope)) continue;
    const body = Array.isArray(snippet.body)
      ? snippet.body.filter((line): line is string => typeof line === "string").join("\n")
      : typeof snippet.body === "string"
        ? snippet.body
        : undefined;
    if (body === undefined) continue;
    out.push({
      name,
      prefix,
      body,
      description: typeof snippet.description === "string" ? snippet.description : name,
      platform: OBJECT_PREFIXES.has(prefix) ? undefined : prefix.slice("tide-".length),
    });
  }
  return out;
}

/** A platform block's body indented under `configurations:` (each line two more spaces). */
export function indentBlock(body: string, indent: string): string {
  return body
    .split("\n")
    .map((line) => (line ? `${indent}${line}` : line))
    .join("\n");
}

/** The 0-based line of a top-level `configurations:` key, if any. */
export function configurationsLine(lines: readonly string[]): number | undefined {
  const index = lines.findIndex((line) => /^configurations:\s*(#.*)?$/.test(line));
  return index >= 0 ? index : undefined;
}
