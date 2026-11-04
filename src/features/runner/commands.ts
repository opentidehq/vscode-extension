// The generic runner's command list, and where each command may run. vscode-free.
import type { Classification, CommandClass } from "../../core/capabilities/classification";
import type { CommandInfo, CommandTree } from "../../core/capabilities/tree";

/** `background`: `--json`, result as a document. `terminal`: only in a terminal (long-running or interactive). */
export type RunMode = "background" | "terminal";

/**
 * Commands that never end on their own or need a terminal: the servers the extension runs itself (SPEC §4,
 * §12) and the TUI. They stay reachable, in a terminal.
 */
export const TERMINAL_ONLY = new Set(["tui", "serve", "lsp start", "mcp start"]);

/** Flags that keep a command running: background runs would never finish. */
export const TERMINAL_FLAGS = new Set(["--watch"]);

export interface CommandEntry {
  readonly command: CommandInfo;
  readonly classification: Classification & { readonly unclassified?: true };
  readonly modes: readonly RunMode[];
}

export function modesOf(path: string, argv: readonly string[] = []): RunMode[] {
  if (TERMINAL_ONLY.has(path) || argv.some((arg) => TERMINAL_FLAGS.has(arg))) return ["terminal"];
  return ["background", "terminal"];
}

/** Every runnable command (groups that only print help are left out), sorted by path. */
export function runnableCommands(
  tree: CommandTree,
  classify: (argv: readonly string[]) => Classification & { readonly unclassified?: true },
): CommandEntry[] {
  return tree
    .leafPaths()
    .map((path) => tree.command(path))
    .filter((command): command is CommandInfo => command !== undefined)
    .map((command) => ({
      command,
      classification: classify(command.path.split(" ")),
      modes: modesOf(command.path),
    }));
}

const ICONS: Readonly<Record<CommandClass, string>> = {
  "read-only": "$(symbol-event)",
  "writes-workspace": "$(edit)",
  "contacts-tenant": "$(globe)",
  deploys: "$(cloud-upload)",
  shares: "$(broadcast)",
};

const CLASS_LABELS: Readonly<Record<CommandClass, string>> = {
  "read-only": "reads only",
  "writes-workspace": "writes workspace files",
  "contacts-tenant": "contacts tenants",
  deploys: "deploys: dry run only",
  shares: "shares: dry run only",
};

export function classIcon(classification: Classification & { readonly unclassified?: true }): string {
  return classification.unclassified ? "$(question)" : ICONS[classification.class];
}

/** "writes workspace files · terminal only", for a quick pick item's detail. */
export function classLabel(entry: CommandEntry): string {
  const parts = [
    entry.classification.unclassified
      ? "not classified: runs alone"
      : CLASS_LABELS[entry.classification.class],
  ];
  if (!entry.modes.includes("background")) parts.push("terminal only");
  if (entry.command.deprecated) parts.push("deprecated");
  return parts.join(" · ");
}
