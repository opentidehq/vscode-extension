// The opentide MCP server VS Code's agents get from the extension (SPEC §12): when to provide it, and the
// stdio definition. vscode-free; index.ts makes the vscode.McpStdioServerDefinition.
import type { Runtime } from "../../core/runtime/types";
import { cliCommand, hasCli } from "../../core/runtime/types";
import { parseJsonc } from "./jsonc";

/**
 * The extension's server label, the name `opentide setup mcp`, the opentidehq/skills plugin and Cursor's
 * file use. VS Code (1.145, `McpCollisionEnablementModel` in src/vs/workbench/contrib/mcp/common/mcpService.ts)
 * groups the servers of every MCP collection by label, compared without case. With
 * `chat.mcp.collisionBehavior` at its default, `disable`, only the server of the collection with the
 * lowest `order` stays enabled by default, and enabling another disables the rest. Workspace files come
 * first (`.vscode/mcp.json` 0, `.mcp.json` and `.cursor/mcp.json` 1, a `.code-workspace` 100, the
 * user's mcp.json 200) and extension providers at 300, so a workspace file's `opentide` wins over this label: `auto` defers to it
 * only when VS Code can start it, and otherwise the extension's server takes {@link MCP_SEPARATE_LABEL}.
 */
export const MCP_LABEL = "opentide";

/**
 * The label when the workspace file whose `opentide` VS Code keeps cannot start (`opentide` with only the
 * bundled runtime): a label VS Code does not group with `opentide`, so the extension's server stays
 * enabled beside the file's instead of being disabled in its favour.
 */
export const MCP_SEPARATE_LABEL = "opentide (VS Code)";

/** `contributes.mcpServerDefinitionProviders[].id`. */
export const MCP_PROVIDER_ID = "opentide";

export type ProvideMode = "auto" | "always" | "never";

export function provideMode(value: unknown): ProvideMode {
  return value === "always" || value === "never" ? value : "auto";
}

/**
 * A workspace folder's MCP file, as VS Code 1.145 reads it:
 * - `vscode`: `.vscode/mcp.json`, `servers` (`mcpServers` accepted too);
 * - `root`: `.mcp.json` at the folder root (`WorkspaceDotMcpDiscovery`), read whenever MCP is on (the
 *   setting `chat.mcp.workspaceRootConfig.enabled` only gates adding servers to it), `mcpServers` or
 *   the server map itself; `opentide setup mcp --claude-code` and the setup wizard write it;
 * - `cursor`: `.cursor/mcp.json`, `mcpServers`, read only when `chat.mcp.discovery.enabled` turns on
 *   `cursor-workspace` (off by default).
 */
export type McpFileKind = "vscode" | "root" | "cursor";

/**
 * What VS Code does with `${…}` in a server's command before it spawns it:
 * - `variables`: `.vscode/mcp.json` goes through VS Code's variable resolver (`${workspaceFolder}`,
 *   `${env:X}`, `${input:x}`), assumed to resolve;
 * - `environment`: the root `.mcp.json` gets only `${VAR}` and `${VAR:-default}` from VS Code's own
 *   environment (its `environmentVariableExpansion`, envVarResolution.ts), an unset one left as written;
 *   `${workspaceFolder}` is such a reference too, to a variable that is not set;
 * - `none`: `.cursor/mcp.json` gets nothing: a `${` is part of the path.
 */
export type Expansion = "variables" | "environment" | "none";

export interface McpFile {
  readonly kind: McpFileKind;
  readonly expansion: Expansion;
  /** VS Code's collection order: the lowest wins a name. */
  readonly order: number;
  /** The path under the folder. */
  readonly segments: readonly string[];
  /** The watcher's glob. */
  readonly glob: string;
}

/** In VS Code's priority order: `.vscode/mcp.json` (order 0) before the other two (order 1). */
export const MCP_FILES: readonly McpFile[] = [
  {
    kind: "vscode",
    expansion: "variables",
    order: 0,
    segments: [".vscode", "mcp.json"],
    glob: "**/.vscode/mcp.json",
  },
  { kind: "root", expansion: "environment", order: 1, segments: [".mcp.json"], glob: "**/.mcp.json" },
  {
    kind: "cursor",
    expansion: "none",
    order: 1,
    segments: [".cursor", "mcp.json"],
    glob: "**/.cursor/mcp.json",
  },
];

/**
 * VS Code's order for the `mcp.servers` of a `.code-workspace` and of the user's mcp.json, which also
 * come before the extension's provider (300). Both go through VS Code's variable resolver.
 */
export const WORKSPACE_CONFIG_ORDER = 100;
export const USER_CONFIG_ORDER = 200;

/**
 * Whether `chat.mcp.discovery.enabled` makes VS Code read `.cursor/mcp.json`, as its
 * `isDiscoverySourceEnabled`: a boolean applies to every source, an object names each (off by default).
 */
export function cursorWorkspaceDiscovered(discovery: unknown): boolean {
  if (typeof discovery === "boolean") return discovery;
  const value =
    typeof discovery === "object" && discovery !== null
      ? (discovery as Record<string, unknown>)["cursor-workspace"]
      : undefined;
  return value === true;
}

/** The files VS Code reads in each folder, in its priority order, given `chat.mcp.discovery.enabled`. */
export function workspaceMcpFiles(discovery: unknown): readonly McpFile[] {
  return MCP_FILES.filter((file) => file.kind !== "cursor" || cursorWorkspaceDiscovered(discovery));
}

/** Whether an MCP file's text defines a server named `opentide` (`.vscode/mcp.json` unless `kind` says). */
export function definesOpentide(text: string | undefined, kind: McpFileKind = "vscode"): boolean {
  return opentideEntryCommand(text, kind) !== undefined;
}

function parseStrict(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `command` of the `opentide` server in a server map (`mcp.servers` of a configuration, or a file's):
 * undefined when there is none, null when it names no command.
 */
export function opentideServerCommand(servers: unknown): string | null | undefined {
  if (!isObject(servers)) return undefined;
  for (const [name, entry] of Object.entries(servers)) {
    if (name.toLowerCase() !== MCP_LABEL || !isObject(entry)) continue;
    const command = entry.command;
    return typeof command === "string" && command.trim() ? command.trim() : null;
  }
  return undefined;
}

/** The server maps of a file's parsed text, as VS Code reads that kind of file. */
function serverMaps(parsed: Record<string, unknown>, kind: McpFileKind): unknown[] {
  if (kind === "vscode") return [parsed.servers, parsed.mcpServers];
  if (kind === "cursor") return [parsed.mcpServers];
  // `.mcp.json`: `{ "mcpServers": {…} }`, or the map at the top level.
  return [Object.hasOwn(parsed, "mcpServers") ? parsed.mcpServers : parsed];
}

/**
 * The `command` of an MCP file's `opentide` server: undefined when there is no such server, null when it
 * names no command (a URL server, say). An entry that is not an object is no server: VS Code drops it.
 * `.cursor/mcp.json` is read with strict JSON, as VS Code reads it: a comment or a trailing comma there
 * makes VS Code read no server, so there is none to defer to.
 */
export function opentideEntryCommand(
  text: string | undefined,
  kind: McpFileKind = "vscode",
): string | null | undefined {
  if (text === undefined) return undefined;
  const parsed = kind === "cursor" ? parseStrict(text) : parseJsonc(text);
  if (!isObject(parsed)) return undefined;
  for (const servers of serverMaps(parsed, kind)) {
    const command = opentideServerCommand(servers);
    if (command !== undefined) return command;
  }
  return undefined;
}

export interface CommandLookup {
  isAbsolute(file: string): boolean;
  exists(file: string): boolean;
  /** The command found on the PATH VS Code starts MCP servers with, or undefined. */
  which(name: string): string | undefined;
  /** A variable of VS Code's environment ({@link environmentLookup}); none when omitted. */
  env?(name: string): string | undefined;
}

/** `name` in `env`, without case on Windows as `process.env` reads it there. */
export function environmentLookup(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): (name: string) => string | undefined {
  if (platform !== "win32") return (name) => env[name];
  return (name) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : env[key];
  };
}

/**
 * `${VAR}` and `${VAR:-default}` in `value` replaced as VS Code does for the root `.mcp.json`: a set
 * variable gives its value (an empty one too), an unset one its default, else the reference stays as
 * written. The default ends at its matching `}` and is not expanded again. Bare `$VAR` stays literal.
 */
export function expandEnvironment(value: string, env: (name: string) => string | undefined): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const name = value.startsWith("${", i) ? /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(i + 2)) : null;
    if (!name) {
      out += value[i];
      i++;
      continue;
    }
    let j = i + 2 + name[0].length;
    let fallback: string | undefined;
    if (value.startsWith(":-", j)) {
      let depth = 0;
      let k = j + 2;
      for (; k < value.length; k++) {
        if (value.startsWith("${", k)) {
          depth++;
          k++;
        } else if (value[k] === "}") {
          if (depth === 0) break;
          depth--;
        }
      }
      fallback = value.slice(j + 2, k);
      j = k;
    }
    if (value[j] !== "}") {
      out += value[i];
      i++;
      continue;
    }
    const set = env(name[0]);
    out += set ?? fallback ?? value.slice(i, j + 1);
    i = j + 1;
  }
  return out;
}

/**
 * Whether VS Code can start a workspace entry's command: an absolute path that exists, a name on PATH,
 * or (in `.vscode/mcp.json`) one with `${…}` variables VS Code resolves itself. `setup mcp` writes
 * `opentide`, which a user with only the bundled runtime does not have. In the root `.mcp.json` only
 * environment references are expanded first, and in `.cursor/mcp.json` nothing is: a `${` left in the
 * command is spawned as written, so it counts only as an absolute path that exists.
 */
export function entryUsable(
  command: string | null,
  lookup: CommandLookup,
  expansion: Expansion = "variables",
): boolean {
  if (command === null) return true;
  if (expansion === "variables" && command.includes("${")) return true;
  const spawned =
    expansion === "environment" ? expandEnvironment(command, lookup.env ?? (() => undefined)) : command;
  if (lookup.isAbsolute(spawned)) return lookup.exists(spawned);
  if (spawned.includes("${")) return false;
  if (/[\\/]/.test(spawned)) return true;
  return lookup.which(spawned) !== undefined;
}

export interface McpServerPlan {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  /** The workspace folder the server answers for (its cwd and `OPENTIDE_REPO_ROOT`). */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** The opentide version: a new one makes VS Code read the server's tools again. */
  readonly version: string;
}

export type McpDecision =
  | {
      readonly provide: true;
      readonly server: McpServerPlan;
      /** Why the server has {@link MCP_SEPARATE_LABEL}: the workspace entry VS Code would keep cannot start. */
      readonly note?: string;
    }
  /** `pending`: the answer is not known yet (the runtime's command tree is still loading). */
  | { readonly provide: false; readonly reason: string; readonly pending?: true };

/** A workspace MCP file's `opentide` server. */
export interface WorkspaceEntry {
  /** The file, for the log: `<folder>/.mcp.json`. */
  readonly file: string;
  /** Its `command`; null for a server with none (a URL server). */
  readonly command: string | null;
  /** VS Code can start it ({@link entryUsable}). */
  readonly usable: boolean;
  /** Its collection's order in VS Code ({@link McpFile.order}). */
  readonly order: number;
}

export interface McpInputs {
  readonly trusted: boolean;
  readonly mode: ProvideMode;
  readonly runtime: Runtime | undefined;
  /** The active opentide has `mcp start`; undefined while its command tree has not loaded yet. */
  readonly hasMcpStart: boolean | undefined;
  /** The folder the server is for: the first opentide folder, else the first workspace folder. */
  readonly folder: string | undefined;
  /**
   * The workspace MCP sources' `opentide` servers. VS Code keeps the one with the lowest order. Among
   * several with that order it keeps the one registered first, which depends on when each file appeared
   * (a `.mcp.json` created during the session registers after an existing `.cursor/mcp.json`, or after
   * another folder's), so the decision is conservative: it defers only when every one of them can start,
   * and takes {@link MCP_SEPARATE_LABEL} when any cannot.
   */
  readonly workspaceEntries: readonly WorkspaceEntry[];
  /** VS Code's `http.proxy`. */
  readonly proxy?: string;
}

/** Whether to provide the server, how it starts and its label. Nothing in Restricted Mode (SPEC §12, §13). */
export function decideMcp(inputs: McpInputs): McpDecision {
  if (!inputs.trusted) return { provide: false, reason: "Restricted Mode" };
  if (inputs.mode === "never") return { provide: false, reason: "opentide.mcp.provide is never" };
  if (!hasCli(inputs.runtime)) return { provide: false, reason: "no opentide runtime with commands" };
  if (inputs.hasMcpStart === undefined)
    return { provide: false, reason: "the command tree is loading", pending: true };
  if (!inputs.hasMcpStart) return { provide: false, reason: "the active opentide has no `mcp start`" };
  if (!inputs.folder) return { provide: false, reason: "no workspace folder" };
  // The entries VS Code may keep of every `opentide` (MCP_LABEL): deferring to one that cannot start
  // would leave the agents a server that fails with ENOENT, and sharing its label would get ours disabled.
  const first = Math.min(...inputs.workspaceEntries.map((entry) => entry.order));
  const candidates = inputs.workspaceEntries.filter((entry) => entry.order === first);
  const kept = candidates[0];
  const broken = candidates.find((entry) => !entry.usable);
  if (inputs.mode === "auto" && kept && !broken)
    return { provide: false, reason: `${kept.file} already defines opentide` };
  const separate = broken !== undefined;
  const runtime = inputs.runtime;
  const { command, args } = cliCommand(runtime, ["mcp", "start"]);
  return {
    provide: true,
    server: {
      label: separate ? MCP_SEPARATE_LABEL : MCP_LABEL,
      command,
      args,
      cwd: inputs.folder,
      env: {
        ...runtime.env,
        OPENTIDE_REPO_ROOT: inputs.folder,
        ...(inputs.proxy ? { OPENTIDE_PROXY: inputs.proxy } : {}),
      },
      version: runtime.version,
    },
    ...(broken
      ? {
          note: `${broken.file}'s opentide server runs \`${broken.command}\`, which is not found, and VS Code keeps one server named opentide`,
        }
      : {}),
  };
}

/**
 * The output channel's line for a decision, once per change: why the server is not provided, that it is
 * provided after it was not, and why it is provided as {@link MCP_SEPARATE_LABEL}. Nothing while the
 * answer is pending: right after a trust grant the command tree had not loaded yet, and the log said there
 * was no `mcp start` before providing it (#49).
 */
export class McpDecisionLog {
  private last: string | undefined;

  line(decision: McpDecision): string | undefined {
    if (!decision.provide && decision.pending) return undefined;
    const key = decision.provide ? `provided ${decision.note ?? ""}` : decision.reason;
    if (key === this.last) return undefined;
    const said = this.last;
    this.last = key;
    if (decision.provide && decision.note)
      return `MCP server provided as "${decision.server.label}": ${decision.note}`;
    if (decision.provide)
      return said === undefined ? undefined : `MCP server provided: ${decision.server.command}`;
    return `MCP server not provided: ${decision.reason}`;
  }
}
