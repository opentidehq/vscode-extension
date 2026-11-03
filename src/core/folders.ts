// Which workspace folders are opentide repositories, and their object folders. vscode-free.
import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_OBJECT_FOLDERS: Readonly<Record<string, string>> = {
  threat: "objects/threats/",
  objective: "objects/objectives/",
  rule: "objects/rules/",
};

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

/**
 * The object folders, relative to the workspace with forward slashes and a trailing slash, from
 * `[paths.objects]` in `.opentide/configurations/paths.toml`, else the defaults. Mirrors opentide's
 * `cli/completion.py:object_folders`.
 */
export function objectFolders(pathsToml: string | undefined): Record<string, string> {
  const folders: Record<string, string> = { ...DEFAULT_OBJECT_FOLDERS };
  if (!pathsToml) return folders;
  const configured = readTomlTable(pathsToml, ["paths", "objects"]);
  for (const kind of Object.keys(folders)) {
    const value = configured[kind];
    if (typeof value === "string" && value.trim()) folders[kind] = normalizeFolder(value);
  }
  return folders;
}

const KEY = `(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')`;
const unquote = (key: string): string => key.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2");
const splitKey = (key: string): string[] => (key.match(new RegExp(KEY, "g")) ?? []).map(unquote);

function tomlString(raw: string): string | undefined {
  const value = raw.trim();
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (basic?.[1] !== undefined) return basic[1].replace(/\\(["\\])/g, "$1");
  const literal = /^'([^']*)'/.exec(value);
  return literal?.[1];
}

/**
 * The string values of one table of a TOML file: `[a.b]` with `key = "value"`, dotted keys from a parent
 * table (`[a]` with `b.key = "value"`) and an inline table (`b = { key = "value" }`). Enough for
 * `paths.toml`; anything else is ignored.
 */
export function readTomlTable(text: string, table: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const target = table.join(".");
  let current: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[\s*([^[\]]+?)\s*\](?:\s*#.*)?$/.exec(line);
    if (header?.[1]) {
      current = splitKey(header[1]);
      continue;
    }
    if (line.startsWith("[[")) {
      current = ["\u0000"];
      continue;
    }
    const pair = new RegExp(`^(${KEY}(?:\\s*\\.\\s*${KEY})*)\\s*=\\s*(.*)$`).exec(line);
    if (!pair?.[1] || pair[2] === undefined) continue;
    const full = [...current, ...splitKey(pair[1])];
    const value = pair[2];
    if (full.length === table.length + 1 && full.slice(0, -1).join(".") === target) {
      const text = tomlString(value);
      const key = full[full.length - 1];
      if (text !== undefined && key !== undefined) out[key] = text;
    } else if (full.join(".") === target && value.trim().startsWith("{")) {
      const inline = value.trim().replace(/^\{|\}\s*(#.*)?$/g, "");
      for (const part of inline.split(",")) {
        const inner = new RegExp(`^\\s*(${KEY})\\s*=\\s*(.*)$`).exec(part);
        const text = inner?.[2] !== undefined ? tomlString(inner[2]) : undefined;
        if (inner?.[1] && text !== undefined) out[unquote(inner[1])] = text;
      }
    }
  }
  return out;
}

function normalizeFolder(value: string): string {
  let out = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!out.endsWith("/")) out += "/";
  return out;
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
