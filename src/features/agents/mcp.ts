// The opentide MCP server VS Code's agents get from the extension (SPEC §12): when to provide it, and the
// stdio definition. vscode-free; index.ts makes the vscode.McpStdioServerDefinition.
import type { Runtime } from "../../core/runtime/types";
import { cliCommand, hasCli } from "../../core/runtime/types";
import { parseJsonc } from "./jsonc";

/** The label VS Code deduplicates against workspace MCP files, `opentide setup mcp`'s and the plugin's. */
export const MCP_LABEL = "opentide";

/** `contributes.mcpServerDefinitionProviders[].id`. */
export const MCP_PROVIDER_ID = "opentide";

export type ProvideMode = "auto" | "always" | "never";

export function provideMode(value: unknown): ProvideMode {
  return value === "always" || value === "never" ? value : "auto";
}

/** Whether a `.vscode/mcp.json` text defines a server named `opentide` (`servers`, or `mcpServers`). */
export function definesOpentide(text: string | undefined): boolean {
  return opentideEntryCommand(text) !== undefined;
}

/**
 * The `command` of a `.vscode/mcp.json` text's `opentide` server: undefined when there is no such server,
 * null when it names no command (a URL server, say).
 */
export function opentideEntryCommand(text: string | undefined): string | null | undefined {
  if (text === undefined) return undefined;
  const parsed = parseJsonc(text);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  for (const key of ["servers", "mcpServers"]) {
    const servers = (parsed as Record<string, unknown>)[key];
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) continue;
    for (const [name, entry] of Object.entries(servers)) {
      if (name.toLowerCase() !== MCP_LABEL) continue;
      const command = (entry as { command?: unknown } | null)?.command;
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
  | { readonly provide: true; readonly server: McpServerPlan }
  | { readonly provide: false; readonly reason: string };

export interface McpInputs {
  readonly trusted: boolean;
  readonly mode: ProvideMode;
  readonly runtime: Runtime | undefined;
  /** The active opentide has `mcp start`. */
  readonly hasMcpStart: boolean;
  /** The folder the server is for: the first opentide folder, else the first workspace folder. */
  readonly folder: string | undefined;
  /** A workspace `.vscode/mcp.json` already defines an `opentide` server VS Code can start. */
  readonly workspaceDefines: boolean;
  /** VS Code's `http.proxy`. */
  readonly proxy?: string;
}

/** Whether to provide the server, and how it starts. Nothing in Restricted Mode (SPEC §12, §13). */
export function decideMcp(inputs: McpInputs): McpDecision {
  if (!inputs.trusted) return { provide: false, reason: "Restricted Mode" };
  if (inputs.mode === "never") return { provide: false, reason: "opentide.mcp.provide is never" };
  if (!hasCli(inputs.runtime)) return { provide: false, reason: "no opentide runtime with commands" };
  if (!inputs.hasMcpStart) return { provide: false, reason: "the active opentide has no `mcp start`" };
  if (!inputs.folder) return { provide: false, reason: "no workspace folder" };
  if (inputs.mode === "auto" && inputs.workspaceDefines)
    return { provide: false, reason: ".vscode/mcp.json already defines opentide" };
  const runtime = inputs.runtime;
  const { command, args } = cliCommand(runtime, ["mcp", "start"]);
  return {
    provide: true,
    server: {
      label: MCP_LABEL,
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
  };
}
