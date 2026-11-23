// Which installed copy of this extension the stable MCP launcher runs. vscode-free and dependency-free: the launcher
// (dist/mcp-launcher.js) is built from this file and ./main.ts, and unit tests import it.

/** An extension id, `<publisher>.<name>`: letters, digits and hyphens on each side of one dot. */
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;

/**
 * The id of the extension whose copies the launcher runs. The entry names it (`OPENTIDE_EXTENSION_ID`, from
 * `context.extension.id`): the publisher differs between the Visual Studio Marketplace and Open VSX
 * (docs/RELEASING.md). An entry written before it had the variable runs the launcher from the extension's
 * global storage folder, which VS Code names after the id: that folder's name.
 */
export function extensionIdOf(fromEnv: string | undefined, launcherDir: string): string | undefined {
  if (fromEnv !== undefined && EXTENSION_ID.test(fromEnv)) return fromEnv;
  const folder = launcherDir.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return EXTENSION_ID.test(folder) ? folder : undefined;
}

/** The folder VS Code gives an installed extension: `<publisher>.<name>-<version>[-<target platform>]`. */
function folderPattern(extensionId: string): RegExp {
  const id = extensionId.replace(/[.-]/g, (c) => `\\${c}`);
  return new RegExp(`^${id}-(\\d+)\\.(\\d+)\\.(\\d+)(?:-([a-z0-9][a-z0-9-]*))?$`, "i");
}

export interface Installed {
  /** The folder's name. */
  readonly folder: string;
  readonly version: readonly [number, number, number];
  /** `<extensions dir>/<folder>/dist/mcp-wasi.js`. */
  readonly bridge: string;
}

/** The version in an extension folder's name, or undefined when the name is not `extensionId`'s. */
export function folderVersion(
  name: string,
  extensionId: string,
): readonly [number, number, number] | undefined {
  const match = folderPattern(extensionId).exec(name);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Newest first: higher major, then minor, then patch. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface Files {
  /** The names in a directory; empty when it cannot be read. */
  list(dir: string): readonly string[];
  /** Whether `file` is a file that exists. */
  exists(file: string): boolean;
  /** The text of `file`, or undefined. */
  read(file: string): string | undefined;
  join(...parts: string[]): string;
}

/**
 * The folders VS Code has marked obsolete (`<extensions dir>/.obsolete`, `{"<folder>": true}`): an update or an
 * uninstall leaves the old folder there until the editor deletes it, and it must not be chosen.
 */
export function obsoleteFolders(text: string | undefined): ReadonlySet<string> {
  if (!text) return new Set();
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return new Set();
    return new Set(
      Object.entries(value as Record<string, unknown>)
        .filter(([, flag]) => flag === true)
        .map(([name]) => name),
    );
  } catch {
    return new Set();
  }
}

/**
 * The newest installed copy with a bridge on disk: the highest version among `extensionId`'s folders in `dir`,
 * skipping a folder marked obsolete or with no `dist/mcp-wasi.js` (an old folder the editor is deleting). On a
 * tie (the same version for two platforms) the folder name decides, so the choice is stable.
 */
export function newestInstalled(dir: string, files: Files, extensionId: string): Installed | undefined {
  const obsolete = obsoleteFolders(files.read(files.join(dir, ".obsolete")));
  const found: Installed[] = [];
  for (const folder of files.list(dir)) {
    const version = folderVersion(folder, extensionId);
    if (!version || obsolete.has(folder)) continue;
    const bridge = files.join(dir, folder, "dist", "mcp-wasi.js");
    if (files.exists(bridge)) found.push({ folder, version, bridge });
  }
  found.sort((a, b) => compareVersions(a.version, b.version) || a.folder.localeCompare(b.folder));
  return found[0];
}

/** The message a request gets when no copy of the extension is installed. */
export function notInstalledMessage(entryFile: string | undefined): string {
  return `the opentide extension is not installed; remove the opentide entry from ${entryFile ?? "the editor's MCP settings"} or reinstall`;
}

/**
 * The JSON-RPC error for the first request on `input`'s lines, or undefined while there is none (a notification,
 * a blank or unparsable line): an MCP client sends `initialize` first and waits for its answer.
 */
export function errorForFirstRequest(line: string, message: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const request = value as { id?: unknown; method?: unknown };
  if (typeof request.method !== "string") return undefined;
  if (typeof request.id !== "number" && typeof request.id !== "string") return undefined;
  return `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message } })}\n`;
}
