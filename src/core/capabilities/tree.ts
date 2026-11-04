// The `opentide --json commands` tree: what the active opentide can do. vscode-free.
//
// Features never compare version numbers (CONTRACTS.md, "Versions the extension gates on"): they ask
// `hasCommand` and `hasOption`.

export interface CommandOption {
  readonly name: string;
  readonly flags: readonly string[];
  readonly secondary_flags?: readonly string[];
  readonly type: string;
  readonly choices?: readonly string[] | null;
  readonly default?: unknown;
  readonly required?: boolean;
  readonly multiple?: boolean;
  readonly is_flag?: boolean;
  readonly envvars?: readonly string[];
  readonly help?: string | null;
}

export interface CommandArgument {
  readonly name: string;
  readonly type: string;
  readonly choices?: readonly string[] | null;
  readonly default?: unknown;
  readonly required?: boolean;
  readonly multiple?: boolean;
  readonly help?: string | null;
}

export interface CommandInfo {
  /** Space-separated, without `opentide`: `"validate query"`. */
  readonly path: string;
  readonly name: string;
  readonly summary: string;
  readonly help?: string;
  readonly group: boolean;
  readonly runs_alone?: boolean;
  readonly subcommands: readonly string[];
  readonly deprecated: boolean;
  readonly arguments: readonly CommandArgument[];
  readonly options: readonly CommandOption[];
  readonly example?: string | null;
  readonly output_schema?: unknown;
}

export interface CommandsDocument {
  readonly program: string;
  readonly version: string;
  readonly global_options: readonly CommandOption[];
  readonly commands: readonly CommandInfo[];
  readonly $defs?: Readonly<Record<string, unknown>>;
}

/** A command path as words: `"info catalog"` or `["info", "catalog"]`. */
export type CommandPath = string | readonly string[];

const words = (path: CommandPath): string[] =>
  (typeof path === "string" ? path.split(/\s+/) : [...path]).filter((word) => word.length > 0);

export class CommandTree {
  private readonly byPath = new Map<string, CommandInfo>();

  constructor(readonly document: CommandsDocument) {
    for (const command of document.commands) this.byPath.set(command.path, command);
  }

  static parse(value: unknown): CommandTree {
    if (
      typeof value !== "object" ||
      value === null ||
      !Array.isArray((value as { commands?: unknown }).commands) ||
      typeof (value as { version?: unknown }).version !== "string"
    ) {
      throw new Error("not an `opentide --json commands` document");
    }
    return new CommandTree(value as CommandsDocument);
  }

  get version(): string {
    return this.document.version;
  }

  get commands(): readonly CommandInfo[] {
    return this.document.commands;
  }

  command(path: CommandPath): CommandInfo | undefined {
    return this.byPath.get(words(path).join(" "));
  }

  /**
   * Whether `path` runs. A path is either a command (`validate query`) or a command followed by a value of
   * its first positional argument's choices (`info catalog`, where `catalog` is a `section`).
   */
  hasCommand(path: CommandPath): boolean {
    const parts = words(path);
    if (parts.length === 0) return false;
    if (this.byPath.has(parts.join(" "))) return true;
    const parent = this.byPath.get(parts.slice(0, -1).join(" "));
    const last = parts[parts.length - 1];
    const positional = parent?.arguments[0];
    return Boolean(last && positional?.choices?.includes(last));
  }

  /** The option of `path` that has `flag` (`--file`), or a global option. */
  option(path: CommandPath, flag: string): CommandOption | undefined {
    const parts = words(path);
    let command = this.byPath.get(parts.join(" "));
    if (!command && parts.length > 1) command = this.byPath.get(parts.slice(0, -1).join(" "));
    const matches = (option: CommandOption): boolean =>
      option.flags.includes(flag) || (option.secondary_flags ?? []).includes(flag);
    return command?.options.find(matches) ?? this.document.global_options.find(matches);
  }

  hasOption(path: CommandPath, flag: string): boolean {
    return this.hasCommand(path) && this.option(path, flag) !== undefined;
  }

  /** Runnable command paths (no bare groups that only print help), sorted. */
  leafPaths(): string[] {
    return this.document.commands
      .filter((command) => command.runs_alone !== false)
      .map((command) => command.path)
      .sort();
  }

  /** The longest command path at the start of `argv`, after global options. */
  commandPathOf(argv: readonly string[]): { path: string; rest: string[] } {
    const args = stripGlobalOptions(argv, this.document.global_options);
    let best = 0;
    for (let n = 1; n <= args.length; n++) {
      if (this.byPath.has(args.slice(0, n).join(" "))) best = n;
      else if (n > best + 1) break;
    }
    return { path: args.slice(0, best).join(" "), rest: args.slice(best) };
  }
}

/** Global options and their values, removed from the front of an argv. */
export function stripGlobalOptions(argv: readonly string[], globals?: readonly CommandOption[]): string[] {
  const valued = new Set<string>(["--repo", "--data", "--proxy"]);
  const flags = new Set<string>(["--json", "--debug", "--quiet", "--no-color", "--version", "-V"]);
  for (const option of globals ?? []) {
    for (const flag of option.flags) (option.is_flag ? flags : valued).add(flag);
  }
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (flags.has(arg)) continue;
    if (valued.has(arg)) {
      i++;
      continue;
    }
    if (arg.includes("=") && valued.has(arg.slice(0, arg.indexOf("=")))) continue;
    out.push(arg);
  }
  return out;
}
