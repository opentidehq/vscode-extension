// Which workspace folders are opentide repositories, and their object folders. vscode-free.
import * as fs from "node:fs";
import * as path from "node:path";

export { DEFAULT_OBJECT_FOLDERS, objectFolders, readTomlTable } from "../engine/pathsToml";

export interface DirEntry {
  readonly name: string;
  readonly directory: boolean;
}

/** A folder's entries with their exact names (symlinks followed), or none when it cannot be read. */
export function listDir(folder: string): DirEntry[] {
  try {
    return fs.readdirSync(folder, { withFileTypes: true }).map((entry) => {
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          directory = fs.statSync(path.join(folder, entry.name)).isDirectory();
        } catch {
          directory = false;
        }
      }
      return { name: entry.name, directory };
    });
  } catch {
    return [];
  }
}

/**
 * A folder is an opentide workspace when it has `.opentide/` or `objects/`, by exact name: on a
 * case-insensitive filesystem (APFS, NTFS) a stat of `objects` also finds a CoreTIDE `Objects/`.
 */
export function isOpentideFolder(
  folder: string,
  list: (dir: string) => readonly DirEntry[] = listDir,
): boolean {
  return list(folder).some(
    (entry) => entry.directory && (entry.name === ".opentide" || entry.name === "objects"),
  );
}

export function pathsTomlFile(folder: string): string {
  return path.join(folder, ".opentide", "configurations", "paths.toml");
}

/** Is `file` (absolute) a YAML file directly inside one of the folder's object folders, or under objects/? */
export function isObjectFile(
  folder: string,
  file: string,
  folders: Readonly<Record<string, string>>,
): boolean {
  if (!/\.ya?ml$/i.test(file)) return false;
  const relative = path.relative(folder, file).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) return false;
  if (relative.startsWith("objects/") || relative.includes("/objects/")) return true;
  return Object.values(folders).some((dir) => relative.startsWith(dir));
}

/**
 * Is `file` (absolute) a YAML file directly in one of the folder's family folders (`objects/rules/`, or
 * what paths.toml names)? Those are the only files `validate --file` and `lint --file` accept: a file in a
 * subfolder fails `lint --file` and matches nothing in `validate --file`.
 */
export function isFamilyFile(
  folder: string,
  file: string,
  folders: Readonly<Record<string, string>>,
): boolean {
  if (!/\.ya?ml$/i.test(file)) return false;
  const relative = path.relative(folder, file).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) return false;
  return Object.values(folders).some(
    (dir) => relative.startsWith(dir) && !relative.slice(dir.length).includes("/"),
  );
}

/**
 * Whether `file` gets `opentide-yaml` from the static objects-folder glob in contrib/core.json only because VS Code
 * matches glob patterns without case: a folder of its path is `Objects` (CoreTIDE's layout) or another
 * spelling, and none is `objects`.
 */
export function objectsOnlyByCase(file: string): boolean {
  const dirs = file.split(/[\\/]/).slice(0, -1);
  return dirs.some((dir) => dir.toLowerCase() === "objects") && !dirs.includes("objects");
}
