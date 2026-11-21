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
): ForkTarget | undefined {
  const name = appName.toLowerCase();
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

export interface McpEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** The environment variable that marks an entry as this extension's: only such an entry is rewritten or removed. */
export const MARKER_ENV = "OPENTIDE_VSCODE_EXTENSION";

/** The marker's value: the extension's id, so a rewrite is for this extension and not another that copied it. */
export const MARKER_VALUE = "opentidehq.opentide";

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
  if (typeof config !== "object" || config === null || Array.isArray(config))
    return { error: "is not a JSON object" };
  const record = config as Record<string, unknown>;
  const servers = record.mcpServers ?? {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers))
    return { error: "has an `mcpServers` that is not an object" };
  const indent = /^\{\r?\n([ \t]+)"/.exec(existing)?.[1] ?? "  ";
  return { config: record, servers: servers as Record<string, unknown>, indent };
}

/** Whether a server entry carries this extension's marker. */
export function isOurs(entry: unknown): boolean {
  const env = (entry as { env?: unknown } | null)?.env;
  return (
    typeof env === "object" && env !== null && (env as Record<string, unknown>)[MARKER_ENV] === MARKER_VALUE
  );
}

const stringify = (config: unknown, indent: string): string => `${JSON.stringify(config, null, indent)}\n`;

function entryValue(entry: McpEntry): Record<string, unknown> {
  return {
    command: entry.command,
    args: [...entry.args],
    env: { ...entry.env, [MARKER_ENV]: MARKER_VALUE },
  };
}

/**
 * The file's text with `mcpServers.opentide` set to `entry` and marked as this extension's, keeping every other
 * server and key. An `opentide` server it did not write (no marker) is `foreign` and left alone; an unreadable
 * file is an `error`: the caller says so instead of overwriting it.
 */
export function mergeMcpEntry(existing: string | undefined, entry: McpEntry): MergeResult {
  const parsed = parseConfig(existing);
  if ("error" in parsed) return { kind: "error", error: parsed.error };
  const current = parsed.servers[MCP_LABEL];
  if (current !== undefined && !isOurs(current)) return { kind: "foreign" };
  const value = entryValue(entry);
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(value)) return { kind: "same" };
  const next = { ...parsed.config, mcpServers: { ...parsed.servers, [MCP_LABEL]: value } };
  return { kind: "write", text: stringify(next, parsed.indent) };
}

/**
 * The text with this extension's `opentide` entry gone (and `mcpServers` too when it was the only server),
 * or undefined when the file has none of the extension's: an entry the user wrote is never removed.
 */
export function removeMcpEntry(existing: string | undefined): string | undefined {
  const parsed = parseConfig(existing);
  if ("error" in parsed || !isOurs(parsed.servers[MCP_LABEL])) return undefined;
  const { [MCP_LABEL]: _gone, ...rest } = parsed.servers;
  const { mcpServers: _servers, ...others } = parsed.config;
  const next = Object.keys(rest).length > 0 ? { ...others, mcpServers: rest } : others;
  return stringify(next, parsed.indent);
}

/** Whether the file has an `opentide` entry this extension wrote. */
export function hasOurEntry(existing: string | undefined): boolean {
  const parsed = parseConfig(existing);
  return !("error" in parsed) && isOurs(parsed.servers[MCP_LABEL]);
}
