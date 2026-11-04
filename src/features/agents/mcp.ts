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
 * first (`.vscode/mcp.json` 0, `.mcp.json` and `.cursor/mcp.json` 1, a `.code-workspace` 100) and
 * extension providers at 300, so a workspace file's `opentide` wins over this label: `auto` defers to it
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

export interface McpFile {
  readonly kind: McpFileKind;
  /** The path under the folder. */
  readonly segments: readonly string[];
  /** The watcher's glob. */
  readonly glob: string;
}

/** In VS Code's priority order: `.vscode/mcp.json` (order 0) before the other two (order 1). */
export const MCP_FILES: readonly McpFile[] = [
  { kind: "vscode", segments: [".vscode", "mcp.json"], glob: "**/.vscode/mcp.json" },
  { kind: "root", segments: [".mcp.json"], glob: "**/.mcp.json" },
  { kind: "cursor", segments: [".cursor", "mcp.json"], glob: "**/.cursor/mcp.json" },
];

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 */
export function opentideEntryCommand(
  text: string | undefined,
  kind: McpFileKind = "vscode",
): string | null | undefined {
  if (text === undefined) return undefined;
  const parsed = parseJsonc(text);
  if (!isObject(parsed)) return undefined;
  for (const servers of serverMaps(parsed, kind)) {
    if (!isObject(servers)) continue;
    for (const [name, entry] of Object.entries(servers)) {
      if (name.toLowerCase() !== MCP_LABEL || !isObject(entry)) continue;
      const command = entry.command;
      return typeof command === "string" && command.trim() ? command.trim() : null;
    }
  }
  return undefined;
}

export interface CommandLookup {
  isAbsolute(file: string): boolean;
  exists(file: string): boolean;
  /** The command found on the PATH VS Code starts MCP servers with, or undefined. */
  which(name: string): string | undefined;
}

/**
 * Whether VS Code can start the workspace entry's command: an absolute path that exists, a name on PATH,
 * or one with `${…}` variables VS Code resolves itself. `setup mcp --vscode` writes `opentide`, which a
 * user with only the bundled runtime does not have.
 */
export function entryUsable(command: string | null, lookup: CommandLookup): boolean {
  if (command === null || command.includes("${")) return true;
  if (lookup.isAbsolute(command)) return lookup.exists(command);
  if (/[\\/]/.test(command)) return true;
  return lookup.which(command) !== undefined;
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
   * The workspace MCP files' `opentide` servers, in VS Code's priority order ({@link workspaceMcpFiles}
   * of each folder): the first is the one VS Code keeps enabled.
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
  // The entry VS Code keeps of every `opentide` (MCP_LABEL): deferring to one that cannot start would
  // leave the agents a server that fails with ENOENT, and sharing its label would get ours disabled.
  const kept = inputs.workspaceEntries[0];
  if (inputs.mode === "auto" && kept?.usable)
    return { provide: false, reason: `${kept.file} already defines opentide` };
  const separate = kept !== undefined && !kept.usable;
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
    ...(separate
      ? {
          note: `${kept.file}'s opentide server runs \`${kept.command}\`, which is not found, and VS Code keeps one server named opentide`,
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
