// What kind of folder the wizard is in, from its top-level entries. vscode-free.
import * as path from "node:path";

/**
 * The file a wizard link names, inside `folder`, or undefined when it leaves it. A prefix check let
 * `../<folder>-x/…` through: the path relative to the folder must not start with `..` nor be absolute.
 */
export function fileInFolder(
  folder: string,
  relative: string,
  paths: Pick<typeof path, "join" | "relative" | "isAbsolute" | "sep"> = path,
): string | undefined {
  const file = paths.join(folder, relative);
  const inside = paths.relative(folder, file);
  if (inside === "" || inside === ".." || inside.startsWith(`..${paths.sep}`) || paths.isAbsolute(inside))
    return undefined;
  return file;
}

export type FolderKind = "opentide" | "legacy" | "empty" | "other";

export interface Entry {
  readonly name: string;
  readonly directory: boolean;
}

/** Entries an empty folder may still have: VCS and editor folders, OS litter. */
const IGNORABLE =
  /^(\.git|\.vscode|\.idea|\.DS_Store|Thumbs\.db|\.gitignore|\.gitattributes|README(\.md)?|LICENSE(\.\w+)?)$/i;

/** What the wizard and the Catalogue's welcome link to for a CoreTIDE layout. */
export const LEGACY_LAYOUT_URL = "https://github.com/opentidehq/opentide/releases/tag/v0.21.0";

export const LEGACY_LAYOUT_MESSAGE =
  "has a CoreTIDE layout (Objects/, Configurations/ or global.toml), which opentide does not support: it does not read CoreTIDE content, and there is no migration.";

export function folderKind(entries: readonly Entry[]): FolderKind {
  const dirs = new Set(entries.filter((e) => e.directory).map((e) => e.name));
  if (dirs.has(".opentide") || dirs.has("objects")) return "opentide";
  // CoreTIDE (no longer supported, opentide 0.21.0): say so instead of offering a migration.
  if (
    dirs.has("Objects") ||
    dirs.has("Configurations") ||
    entries.some((e) => !e.directory && e.name === "global.toml")
  )
    return "legacy";
  if (entries.every((e) => IGNORABLE.test(e.name))) return "empty";
  return "other";
}

/** Whether the folder is a Git work tree root (it has `.git`, a folder or a worktree's file). */
export function isGitRepository(entries: readonly Entry[]): boolean {
  return entries.some((e) => e.name === ".git");
}

/** Context keys the walkthrough completes on, from a finished run (SPEC §8 "Walkthrough"). */
export function walkthroughKeys(run: {
  readonly argv: readonly string[];
  readonly status: "running" | "ok" | "failed" | "cancelled" | "error";
}): string[] {
  if (run.status !== "ok" && run.status !== "failed") return [];
  const [first, second] = run.argv;
  const keys: string[] = [];
  const has = (flag: string) => run.argv.includes(flag);
  // A validate that ran, whatever it found, is the step done.
  if (first === "validate" && second !== "query") keys.push("opentide.setup.validated");
  if (first === "deploy" && has("--dry-run")) keys.push("opentide.setup.deployPreviewed");
  if (run.status !== "ok") return keys;
  if (first === "new" && ["rule", "objective", "threat"].includes(second ?? ""))
    keys.push("opentide.setup.created");
  if (first === "setup" && !has("--plan")) {
    if (second === undefined || second.startsWith("-") || second === "repo") keys.push("opentide.setup.done");
    if (second === "mcp" || second === "skills" || has("--mcp") || has("--skills") || has("--plugin"))
      keys.push("opentide.setup.agentReady");
  }
  return keys;
}

/** The command each walkthrough button (`opentide.setup.step` with a step id) runs. */
export const WALKTHROUGH_COMMANDS: Readonly<Record<string, string>> = {
  create: "opentide.newObject.rule",
  validate: "opentide.diagnostics.validateWorkspace",
  graph: "opentide.graph.open",
  matrix: "opentide.matrix.open",
  deploy: "opentide.deployPlan.open",
  editorMcp: "opentide.agents.addToEditorMcp",
};

export function walkthroughCommand(step: string): string | undefined {
  return Object.hasOwn(WALKTHROUGH_COMMANDS, step) ? WALKTHROUGH_COMMANDS[step] : undefined;
}
