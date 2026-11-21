// Whether the extension asks the language server for the diagnostics of the workspace's closed files
// (`workspace/diagnostic`). vscode-free.
//
// vscode-languageclient pulls them again 2 s after every answer, and an opentide older than 1.0.0rc3 re-analyses every
// closed file on the thread that answers completions: 3 s stalls on Ctrl+Space at 1,200 objects (PyPI 0.28.1), 0.45-0.85 s
// on rc.2 (opentide#1744, fixed in rc.3). For those servers the extension does not pull, and the problems of closed files
// leave the Problems panel (the open files' stay: they are pushed or pulled per document).
import { atLeast, isUntaggedDevBuild } from "./version";

/** `opentide.diagnostics.workspacePull`. */
export type WorkspacePull = "auto" | "always" | "never";

/** The first opentide whose language server does not re-analyse closed files on each workspace pull (opentide#1744). */
export const FIXED_WORKSPACE_PULL_VERSION = "1.0.0rc3";

export function workspacePullSetting(value: unknown): WorkspacePull {
  return value === "always" || value === "never" ? value : "auto";
}

/** Whether a server of `version` is older than the fix. An untagged dev build says nothing about its age: not older. */
export function workspacePullIsSlow(version: string): boolean {
  return !isUntaggedDevBuild(version) && !atLeast(version, FIXED_WORKSPACE_PULL_VERSION);
}

/** Whether to answer `workspace/diagnostic` with nothing instead of asking the server. */
export function skipWorkspacePull(setting: WorkspacePull, serverVersion: string | undefined): boolean {
  if (setting === "never") return true;
  if (setting === "always") return false;
  return serverVersion !== undefined && workspacePullIsSlow(serverVersion);
}
