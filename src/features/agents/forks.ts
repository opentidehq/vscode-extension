// Editors without the MCP provider API (Cursor, Windsurf; SPEC §12): a user-level MCP entry that runs the
// resolved runtime by its absolute path, since a committed config with `command: opentide` fails for
// teammates without opentide on PATH. vscode-free.
import * as path from "node:path";
import { parseJsonc } from "./jsonc";
import { MCP_LABEL } from "./mcp";

export interface ForkTarget {
  readonly editor: "Cursor" | "Windsurf";
  /** The editor's user-level MCP file. */
  readonly file: string;
  /** Whether the editor expands `${workspaceFolder}` in the entry, so the server follows the open folder. */
  readonly workspaceVariable: boolean;
}

/** The user-level MCP file of the editor `appName` (`vscode.env.appName`) names, if it is a known fork. */
export function forkTarget(appName: string, home: string): ForkTarget | undefined {
  const name = appName.toLowerCase();
  if (name.includes("cursor"))
    return { editor: "Cursor", file: path.join(home, ".cursor", "mcp.json"), workspaceVariable: true };
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

/**
 * The file's text with `mcpServers.opentide` set to `entry`, keeping every other server and key. An
 * unreadable file is left alone: the caller says so instead of overwriting it.
 */
export function mergeMcpEntry(
  existing: string | undefined,
  entry: McpEntry,
): { readonly text: string } | { readonly error: string } {
  let config: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    const parsed = parseJsonc(existing);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return { error: "is not a JSON object" };
    config = parsed as Record<string, unknown>;
  }
  const servers = config.mcpServers ?? {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers))
    return { error: "has an `mcpServers` that is not an object" };
  const next = {
    ...config,
    mcpServers: {
      ...(servers as Record<string, unknown>),
      [MCP_LABEL]: {
        command: entry.command,
        args: [...entry.args],
        ...(Object.keys(entry.env).length > 0 ? { env: { ...entry.env } } : {}),
      },
    },
  };
  return { text: `${JSON.stringify(next, null, 2)}\n` };
}
