// What the bundled opentide (the WASI module) cannot do where VS Code starts it itself: a task, a terminal, the
// terminal UI. The runner's background runs are not limited: they go through `opentide serve`, where the
// extension host makes the tenant requests. vscode-free.
import { isWasi, type Runtime } from "./types";

const INSTALLED = "set opentide.runtime to installed to run your own opentide there";

/**
 * Why `argvPath` (the command's path: "tui", "query run") cannot run as a task or in a terminal on `runtime`, or
 * undefined when it can. Only the bundled opentide has limits: it has no network of its own outside `serve`, and
 * no terminal UI.
 */
export function bundledTerminalLimit(
  runtime: Runtime | undefined,
  argvPath: string,
  contactsTenant: boolean,
): string | undefined {
  if (!isWasi(runtime)) return undefined;
  if (argvPath === "tui") return `The terminal UI does not run on the bundled opentide; ${INSTALLED}.`;
  if (contactsTenant)
    return `\`opentide ${argvPath}\` contacts a tenant, and the bundled opentide has no network in a terminal or task (the editor's own runs make the request through the extension); ${INSTALLED}.`;
  return undefined;
}
