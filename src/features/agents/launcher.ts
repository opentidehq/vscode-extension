// The user-level MCP entry of Kiro, Devin Desktop and Windsurf, for the bundled bridge: it names a small stable
// launcher in the extension's global storage, not `<extensions>/opentidehq.opentide-<version>/dist/mcp-wasi.js`.
// An update deletes the old extension folder, and the entry is only rewritten when the extension next activates;
// until then a path with the version in it points at nothing. The launcher (src/mcp-launcher) finds the newest
// installed copy when the agent starts it, so the entry stays byte-identical across updates. vscode-free.
import * as path from "node:path";
import type { McpEntry } from "./forks";

/** The launcher's file name in the global storage folder. */
export const LAUNCHER_FILE = "mcp-launcher.cjs";

export interface LauncherInput {
  /** The editor's own binary (`process.execPath`), run as Node with `ELECTRON_RUN_AS_NODE`. */
  readonly execPath: string;
  /** The extension's global storage folder (`context.globalStorageUri.fsPath`). */
  readonly storageDir: string;
  /** Where the editor keeps installed extensions: the folder that holds this extension's own. */
  readonly extensionPath: string;
  /** The user-level MCP file the entry is in, named when no copy of the extension is installed. */
  readonly entryFile: string;
  /** VS Code's `http.proxy`, for the bridge's tenant requests. */
  readonly proxy?: string | undefined;
}

/** Where the launcher is written. */
export function launcherPath(storageDir: string): string {
  return path.join(storageDir, LAUNCHER_FILE);
}

/**
 * The entry for the bundled bridge. Nothing in it depends on the extension's version: the launcher's path, the
 * editor's binary, the extensions folder and the MCP file.
 */
export function launcherEntry(input: LauncherInput): McpEntry {
  return {
    command: input.execPath,
    args: [launcherPath(input.storageDir)],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      OPENTIDE_EXTENSIONS_DIR: path.dirname(input.extensionPath),
      OPENTIDE_MCP_ENTRY_FILE: input.entryFile,
      ...(input.proxy ? { OPENTIDE_PROXY: input.proxy } : {}),
    },
  };
}

/** Whether the launcher file must be written: it is missing, or its text is not the extension's. */
export function launcherStale(existing: string | undefined, source: string): boolean {
  return existing !== source;
}
