// opentide resolves the repository root, so the paths it reports are real paths. A folder opened through
// a symlink or junction (~/src -> /data/src, a subst drive, macOS /tmp -> /private/tmp) spells them
// differently from the workspace, and a finding or a created file would land outside the folder.
// vscode-free.
import * as fs from "node:fs";
import * as path from "node:path";

/** A function that rewrites a path under `folder`'s real path to `folder`'s own spelling. */
export function folderSpelling(
  folder: string,
  realpath: (file: string) => string = fs.realpathSync.native,
): (file: string) => string {
  let real: string;
  try {
    real = realpath(folder);
  } catch {
    return (file) => file;
  }
  if (path.resolve(real) === path.resolve(folder)) return (file) => file;
  return (file) => {
    const relative = path.relative(real, file);
    if (relative === "") return folder;
    if (relative.startsWith("..") || path.isAbsolute(relative)) return file;
    return path.join(folder, relative);
  };
}
