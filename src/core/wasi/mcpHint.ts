// What the MCP bridge says about where it runs, so a server that finds no repository can be told what to fix
// (#86: a user-level MCP entry has no repository root of its own, and depends on the directory the editor starts it
// in). vscode-free.
import * as fs from "node:fs";
import * as path from "node:path";

/** The variable that names the repository root for opentide's MCP server. */
export const ROOT_VARIABLE = "OPENTIDE_REPO_ROOT";

export interface RootCheck {
  /** `OPENTIDE_REPO_ROOT` as set, or undefined. */
  readonly configured: string | undefined;
  /** The detection repository the server will use, or undefined when it will find none. */
  readonly resolved: string | undefined;
}

/**
 * The root the server will use: `OPENTIDE_REPO_ROOT` when it names a folder that exists, else the nearest
 * directory at or above `cwd` that holds `.opentide/` or `objects/` (what opentide's `get_repo_root` walks for).
 */
export function checkRoot(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  isDirectory: (folder: string) => boolean = (folder) => {
    try {
      return fs.statSync(folder).isDirectory();
    } catch {
      return false;
    }
  },
): RootCheck {
  const configured = env[ROOT_VARIABLE]?.trim() || undefined;
  if (configured) return { configured, resolved: isDirectory(configured) ? configured : undefined };
  for (let folder = path.resolve(cwd); ; ) {
    if (isDirectory(path.join(folder, ".opentide")) || isDirectory(path.join(folder, "objects")))
      return { configured: undefined, resolved: folder };
    const parent = path.dirname(folder);
    if (parent === folder) return { configured: undefined, resolved: undefined };
    folder = parent;
  }
}

/** The one line the bridge writes to stderr (the editor's log for the server) when it starts. */
export function startupLine(cwd: string, check: RootCheck): string {
  const root = check.configured ? `${ROOT_VARIABLE}=${check.configured}` : `${ROOT_VARIABLE} not set`;
  return `opentide mcp bridge: cwd=${cwd}; ${root}; repository root: ${check.resolved ?? "none found"}`;
}

/** What to do when the server finds no repository, naming where the bridge was started. */
export function workspaceHint(cwd: string, check: RootCheck): string {
  const where = check.configured
    ? `${ROOT_VARIABLE} is ${check.configured}, which is not a folder`
    : `the editor started this server in ${cwd}, which is not inside a detection repository (no .opentide/ or objects/ there or above)`;
  return (
    `opentide found no repository: ${where}. Open the repository's folder in the editor, or set ` +
    `${ROOT_VARIABLE} to its absolute path in the opentide server's env in the editor's MCP settings.`
  );
}

/**
 * A line of the module's with the hint added to its tool result when it says `workspace_not_found`: an extra
 * text part, so the agent reads it too. Any other line is returned as it is, byte for byte.
 */
export function withWorkspaceHint(line: string, hint: string): string {
  if (!line.includes("workspace_not_found")) return line;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  const result = (message as { result?: { content?: unknown } } | null)?.result;
  if (!result || !Array.isArray(result.content)) return line;
  const mentions = result.content.some(
    (part: unknown) =>
      typeof (part as { text?: unknown })?.text === "string" &&
      (part as { text: string }).text.includes("workspace_not_found"),
  );
  if (!mentions) return line;
  const tail = line.endsWith("\n") ? "\n" : "";
  return `${JSON.stringify({ ...(message as object), result: { ...result, content: [...result.content, { type: "text", text: hint }] } })}${tail}`;
}
