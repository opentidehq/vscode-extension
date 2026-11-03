// Logic of the palette commands SPEC §11 gives a home of their own: Generate…, Open generated docs, Show
// vocabulary…, Show unreviewed rules, Explain a code…. vscode-free.
import type { CommandTree } from "../../core/capabilities/tree";

// ---------------------------------------------------------------------------------------------- generate

export interface GenerateChoice {
  /** `docs`, `schemas`, `extract sentinel`. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** A phase of `generate <phase…>` (run together), or a subcommand (a run of its own). */
  readonly kind: "phase" | "subcommand";
  readonly contactsTenant: boolean;
}

/**
 * The phases `generate` takes as words (`opentide generate schemas templates`), from its help text: the
 * tree lists subcommands, not these. Empty when the help does not list them.
 */
export function generatePhases(help: string | undefined): string[] {
  const match = /phases? to run only those[^:]*:\s*([a-z][a-z, -]*[a-z])/i.exec(help ?? "");
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((phase) => phase.trim().replace(/^and\s+/, ""))
    .filter((phase) => /^[a-z][a-z-]*$/.test(phase));
}

/** Everything Generate… offers, for the active opentide: subcommands first (in pipeline order), then phases. */
export function generateChoices(tree: CommandTree): GenerateChoice[] {
  const generate = tree.command("generate");
  if (!generate) return [];
  const choices: GenerateChoice[] = [];
  for (const sub of generate.subcommands) {
    const command = tree.command(`generate ${sub}`);
    if (!command) continue;
    if (command.runs_alone === false) {
      // `generate extract` needs a platform: one choice per platform.
      for (const platform of command.subcommands) {
        const leaf = tree.command(`generate ${sub} ${platform}`);
        if (!leaf) continue;
        choices.push({
          id: `${sub} ${platform}`,
          label: `${sub} ${platform}`,
          description: leaf.summary,
          kind: "subcommand",
          contactsTenant: sub === "extract",
        });
      }
      continue;
    }
    choices.push({
      id: sub,
      label: sub,
      description: command.summary,
      kind: "subcommand",
      contactsTenant: false,
    });
  }
  for (const phase of generatePhases(generate.help)) {
    if (choices.some((choice) => choice.id === phase)) continue;
    choices.push({ id: phase, label: phase, description: "phase", kind: "phase", contactsTenant: false });
  }
  return choices;
}

/** The runs for a pick: each subcommand alone, the phases together in one `generate <phase…>`. */
export function generateRuns(picked: readonly GenerateChoice[]): string[][] {
  const runs: string[][] = [];
  for (const choice of picked.filter((c) => c.kind === "subcommand")) {
    runs.push(["generate", ...choice.id.split(" ")]);
  }
  const phases = picked.filter((c) => c.kind === "phase").map((c) => c.id);
  if (phases.length > 0) runs.push(["generate", ...phases]);
  return runs;
}

// ------------------------------------------------------------------------------------------- vocabulary

export interface VocabularySummary {
  readonly name: string;
  readonly title: string;
  readonly entries?: number;
}

/** The vocabularies `info vocab` lists. */
export function vocabularies(document: unknown): VocabularySummary[] {
  const list = (document as { vocabularies?: unknown } | null)?.vocabularies;
  if (!Array.isArray(list)) return [];
  return list
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .filter((v) => typeof v.name === "string")
    .map((v) => ({
      name: String(v.name),
      title: typeof v.title === "string" ? v.title : "",
      ...(typeof v.entries === "number" ? { entries: v.entries } : {}),
    }));
}

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
};

const words = (key: string): string => {
  const spaced = key.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** A Markdown table of objects (the union of their keys, in first-seen order). */
export function markdownTable(rows: readonly Record<string, unknown>[]): string {
  const keys: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
  if (keys.length === 0) return "";
  return [
    `| ${keys.map(words).join(" | ")} |`,
    `| ${keys.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${keys.map((key) => cell(row[key])).join(" | ")} |`),
  ].join("\n");
}

/** `info vocab <name>`'s `vocabulary` as a Markdown document: facts, then one table per list. */
export function vocabularyMarkdown(document: unknown, argvDisplay: string): string {
  const vocabulary = (document as { vocabulary?: unknown } | null)?.vocabulary;
  if (typeof vocabulary !== "object" || vocabulary === null) return "";
  const v = vocabulary as Record<string, unknown>;
  const name = typeof v.name === "string" ? v.name : "vocabulary";
  const out = [`# ${name}${typeof v.title === "string" && v.title ? `: ${v.title}` : ""}`, ""];
  out.push(`\`${argvDisplay}\``, "");
  const facts = Object.entries(v).filter(
    ([key, value]) => key !== "name" && key !== "title" && (typeof value !== "object" || value === null),
  );
  for (const [key, value] of facts) out.push(`- **${words(key)}:** ${cell(value)}`);
  for (const [key, value] of Object.entries(v)) {
    if (!Array.isArray(value)) continue;
    out.push("", `## ${words(key)}`, "");
    if (value.length === 0) out.push("None.");
    else if (value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item)))
      out.push(markdownTable(value as Record<string, unknown>[]));
    else out.push(...value.map((item) => `- ${cell(item)}`));
  }
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------- reviews

export interface UnreviewedRule {
  readonly path: string;
  readonly reason: string;
  readonly reviewed: string | null;
}

/** The rules `rules unreviewed` lists. */
export function unreviewedRules(document: unknown): UnreviewedRule[] {
  const list = (document as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (r): r is Record<string, unknown> => typeof r === "object" && r !== null && typeof r.path === "string",
    )
    .map((r) => ({
      path: String(r.path),
      reason: typeof r.reason === "string" ? r.reason : "",
      reviewed: typeof r.reviewed === "string" ? r.reviewed : null,
    }));
}

// ------------------------------------------------------------------------------------------------- docs

/** Where `generate docs` wrote: the document's `output`/`outputs`, else the default `docs` folder. */
export function docsFolders(document: unknown): string[] {
  const out: string[] = [];
  const d = (document ?? {}) as { output?: unknown; outputs?: unknown };
  if (typeof d.output === "string" && d.output) out.push(d.output);
  if (Array.isArray(d.outputs))
    for (const item of d.outputs) if (typeof item === "string" && item) out.push(item);
  out.push("docs");
  return [...new Set(out)];
}

/** The page to open first among a docs folder's Markdown files (workspace-relative): an index, else the first. */
export function docsIndex(files: readonly string[]): string | undefined {
  const sorted = [...files].filter((file) => file.toLowerCase().endsWith(".md")).sort();
  const index = (name: string) => sorted.find((file) => file.split("/").pop()?.toLowerCase() === name);
  const shallow = (file: string) => file.split("/").length;
  return (
    [index("index.md"), index("readme.md")]
      .filter((file): file is string => file !== undefined)
      .sort((a, b) => shallow(a) - shallow(b))[0] ?? sorted[0]
  );
}

// ---------------------------------------------------------------------------------------------- explain

export interface ExplainEntry {
  readonly code: string;
  readonly meaning: string;
}

/** `explain` with no code: every code and what it means. */
export function explainEntries(document: unknown): ExplainEntry[] {
  const list = (document as { codes?: unknown } | null)?.codes;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (e): e is Record<string, unknown> => typeof e === "object" && e !== null && typeof e.code === "string",
    )
    .map((e) => ({ code: String(e.code), meaning: typeof e.meaning === "string" ? e.meaning : "" }));
}

/** `explain <code>`'s Markdown page, or a short page from its meaning. */
export function explainMarkdown(document: unknown): string {
  const d = (document ?? {}) as { markdown?: unknown; code?: unknown; meaning?: unknown };
  if (typeof d.markdown === "string" && d.markdown.trim()) return d.markdown;
  const code = typeof d.code === "string" ? d.code : "code";
  return `# ${code}\n\n${typeof d.meaning === "string" ? d.meaning : ""}\n`;
}
