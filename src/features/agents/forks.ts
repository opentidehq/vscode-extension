// Editors that have no extension MCP API of the VS Code kind (Kiro, Devin Desktop, Windsurf; SPEC §12): a
// user-level MCP file the extension writes its entry into, after the user agrees, and keeps current. Cursor has an
// extension API instead (cursor.ts). The entry runs the bundled bridge (or the resolved runtime) by absolute path,
// since a committed config with `command: opentide` fails for teammates without opentide on PATH. Only an entry
// that carries this extension's marker is ever rewritten or removed; every other server and key is kept.
// vscode-free.
import * as path from "node:path";
import { parseJsonc } from "./jsonc";
import { MCP_LABEL } from "./mcp";

export type ForkEditor = "Kiro" | "Devin Desktop" | "Windsurf";

export interface ForkTarget {
  readonly editor: ForkEditor;
  /** The editor's user-level MCP file. */
  readonly file: string;
  /** Whether the editor expands `${workspaceFolder}` in the entry, so the server follows the open folder. */
  readonly workspaceVariable: boolean;
}

/**
 * The user-level MCP file of the editor `appName` (`vscode.env.appName`) names, if it is a known one without
 * the provider API. The paths are from the research the maintainers handed over on 2026-11-21 (Kiro's
 * `~/.kiro/settings/mcp.json`; Devin Desktop, formerly Windsurf, `~/.config/devin/mcp_config.json`,
 * `%APPDATA%\devin\mcp_config.json` on Windows; Windsurf's `~/.codeium/windsurf/mcp_config.json`), not checked
 * against the products here: docs/AGENT-INTEGRATION.md says which are verified.
 */
export function forkTarget(
  appName: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
  appData?: string,
  uriScheme = "",
): ForkTarget | undefined {
  // The host is known by its name or its URI scheme (`kiro`, `windsurf`): either says which editor this is.
  const name = `${appName} ${uriScheme}`.toLowerCase();
  if (name.includes("kiro"))
    return {
      editor: "Kiro",
      file: path.join(home, ".kiro", "settings", "mcp.json"),
      workspaceVariable: false,
    };
  if (name.includes("devin")) {
    const file =
      platform === "win32"
        ? path.win32.join(appData ?? path.win32.join(home, "AppData", "Roaming"), "devin", "mcp_config.json")
        : path.join(home, ".config", "devin", "mcp_config.json");
    return { editor: "Devin Desktop", file, workspaceVariable: false };
  }
  if (name.includes("windsurf"))
    return {
      editor: "Windsurf",
      file: path.join(home, ".codeium", "windsurf", "mcp_config.json"),
      workspaceVariable: false,
    };
  return undefined;
}

/** How the opentide MCP server reaches an editor's agent, decided by the host (SPEC §12). */
export interface McpMechanism {
  /** Cursor's `cursor.mcp.registerServer`. */
  readonly cursor: boolean;
  /** `vscode.lm.registerMcpServerDefinitionProvider`: registered wherever the host has it. */
  readonly provider: boolean;
  /** The user-level MCP file of a known editor whose agent reads it. */
  readonly fork?: ForkTarget;
  /** A line for the log: the host, what it has, and what is used. */
  readonly description: string;
}

/**
 * Which mechanisms to use. By host, not by API presence: Kiro's Code OSS core has the provider API, but
 * kiro-agent never consumes it (it reads `~/.kiro/settings/mcp.json` and `<workspace>/.kiro/settings/mcp.json`;
 * #84), so a server registered through the API reaches nothing there. A known editor therefore gets its MCP
 * file (after the user agrees) **and**, where the host has it, the provider (harmless where the agent ignores
 * it). Cursor has its own API. Any other host gets the provider when it has it.
 */
export function chooseMcpMechanism(input: {
  readonly cursor: boolean;
  readonly hasProviderApi: boolean;
  readonly appName: string;
  readonly uriScheme: string;
  readonly home: string;
  readonly platform?: NodeJS.Platform;
  readonly appData?: string;
}): McpMechanism {
  const host = `${input.appName} (${input.uriScheme})`;
  if (input.cursor)
    return {
      cursor: true,
      provider: false,
      description: `host ${host}: MCP through cursor.mcp.registerServer`,
    };
  const fork = forkTarget(
    input.appName,
    input.home,
    input.platform ?? process.platform,
    input.appData,
    input.uriScheme,
  );
  const api = input.hasProviderApi ? "has" : "has no";
  if (fork)
    return {
      cursor: false,
      provider: input.hasProviderApi,
      fork,
      description:
        `host ${host}: a known editor (${fork.editor}) whose agent reads its user-level MCP file; ` +
        `it ${api} the MCP server definition provider API${input.hasProviderApi ? ", registered too (harmless where the agent ignores it)" : ""}: ` +
        `MCP through the user-level MCP file ${fork.file}${input.hasProviderApi ? " and the provider" : ""}`,
    };
  return {
    cursor: false,
    provider: input.hasProviderApi,
    description: input.hasProviderApi
      ? `host ${host}: MCP through an MCP server definition provider`
      : `host ${host}: none (no MCP API, and not an editor with a known MCP file)`,
  };
}

export interface McpEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The environment variable that marks an entry as this extension's: only such an entry is rewritten or removed.
 * Its value is the extension's id (`context.extension.id`, passed to each function below), so a rewrite is for
 * this extension and not another that copied it. The id is never a literal: the publisher differs between the
 * Visual Studio Marketplace and Open VSX (docs/RELEASING.md).
 */
export const MARKER_ENV = "OPENTIDE_VSCODE_EXTENSION";

export type MergeResult =
  | { readonly kind: "write"; readonly text: string }
  /** The file already has this entry. */
  | { readonly kind: "same" }
  /** The file has an `opentide` server this extension did not write: it is left alone. */
  | { readonly kind: "foreign" }
  | { readonly kind: "error"; readonly error: string };

interface Parsed {
  readonly config: Record<string, unknown>;
  readonly servers: Record<string, unknown>;
  readonly indent: string;
}

/** The file's JSON, strictly: a file with comments would lose them when written again, so it is not touched. */
function parseConfig(existing: string | undefined): Parsed | { readonly error: string } {
  if (existing === undefined || existing.trim() === "") return { config: {}, servers: {}, indent: "  " };
  let config: unknown;
  try {
    config = JSON.parse(existing.replace(/^﻿/, ""));
  } catch {
    return {
      error:
        parseJsonc(existing) === undefined
          ? "is not valid JSON"
          : "has comments or trailing commas, which writing it again would drop",
    };
  }
  if (!isRecord(config)) return { error: "is not a JSON object" };
  // Only a missing `mcpServers` is absent: a null or any other non-object value is the user's, not ours to replace.
  const servers = config.mcpServers === undefined ? {} : config.mcpServers;
  if (!isRecord(servers)) return { error: "has an `mcpServers` that is not an object" };
  const indent = /^\{\r?\n([ \t]+)"/.exec(existing)?.[1] ?? "  ";
  return { config, servers, indent };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Why the file cannot be edited (the same words a merge gives), or undefined when it can, or when there is none. */
export function configProblem(existing: string | undefined): string | undefined {
  const parsed = parseConfig(existing);
  return "error" in parsed ? parsed.error : undefined;
}

/** Whether a server entry carries this extension's marker. */
export function isOurs(entry: unknown, extensionId: string): boolean {
  if (!isRecord(entry) || !isRecord(entry.env)) return false;
  return entry.env[MARKER_ENV] === extensionId;
}

const stringify = (config: unknown, indent: string): string => `${JSON.stringify(config, null, indent)}\n`;

function entryValue(entry: McpEntry, extensionId: string): Record<string, unknown> {
  return {
    command: entry.command,
    args: [...entry.args],
    env: { ...entry.env, [MARKER_ENV]: extensionId },
  };
}

/**
 * The file's text with `mcpServers.opentide` set to `entry` and marked as this extension's, keeping every other
 * server and key. An `opentide` server it did not write (no marker) is `foreign` and left alone; an unreadable
 * file is an `error`: the caller says so instead of overwriting it.
 */
export function mergeMcpEntry(
  existing: string | undefined,
  entry: McpEntry,
  extensionId: string,
): MergeResult {
  const parsed = parseConfig(existing);
  if ("error" in parsed) return { kind: "error", error: parsed.error };
  const current = parsed.servers[MCP_LABEL];
  if (current !== undefined && !isOurs(current, extensionId)) return { kind: "foreign" };
  const value = entryValue(entry, extensionId);
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(value)) return { kind: "same" };
  const next = { ...parsed.config, mcpServers: { ...parsed.servers, [MCP_LABEL]: value } };
  return { kind: "write", text: stringify(next, parsed.indent) };
}

export type RemoveResult =
  | { readonly kind: "write"; readonly text: string }
  /** The file has no entry this extension wrote: nothing to remove. */
  | { readonly kind: "none" }
  | { readonly kind: "error"; readonly error: string };

/**
 * The text with this extension's `opentide` entry gone (and `mcpServers` too when it was the only server).
 * An entry the user wrote is never removed (`none`); a file that cannot be read is an `error`, not "no entry".
 */
export function removeMcpEntry(existing: string | undefined, extensionId: string): RemoveResult {
  const parsed = parseConfig(existing);
  if ("error" in parsed) return { kind: "error", error: parsed.error };
  if (!isOurs(parsed.servers[MCP_LABEL], extensionId)) return { kind: "none" };
  const { [MCP_LABEL]: _gone, ...rest } = parsed.servers;
  const { mcpServers: _servers, ...others } = parsed.config;
  const next = Object.keys(rest).length > 0 ? { ...others, mcpServers: rest } : others;
  return { kind: "write", text: stringify(next, parsed.indent) };
}

/** Whether the file has an `opentide` entry this extension wrote. */
export function hasOurEntry(existing: string | undefined, extensionId: string): boolean {
  const parsed = parseConfig(existing);
  return !("error" in parsed) && isOurs(parsed.servers[MCP_LABEL], extensionId);
}
