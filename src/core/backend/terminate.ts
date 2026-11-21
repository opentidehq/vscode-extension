// How the extension ends a process it started: one helper for every path (a command's cancellation, `serve`, the
// language server, the WASI launcher's children), so they differ only in what they ask for, not in how a process that
// does not leave is dealt with. vscode-free.
import * as cp from "node:child_process";

export type SpawnFn = (command: string, args: readonly string[], options: cp.SpawnOptions) => cp.ChildProcess;

/** Whether the process has already ended. */
function ended(child: cp.ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** End a process tree at once: `taskkill /T /F` on Windows, SIGKILL elsewhere. */
export function killTree(child: cp.ChildProcess, platform: NodeJS.Platform, spawn: SpawnFn = cp.spawn): void {
  if (ended(child)) return;
  if (platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => child.kill());
    return;
  }
  child.kill("SIGKILL");
}

export interface TerminateOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnFn;
  /**
   * What to ask first, elsewhere than Windows (which has no such signal there): `SIGINT` is a user's Ctrl-C, which
   * opentide ends with exit code 130; `SIGTERM` (the default) is a polite stop. The process is then killed.
   */
  readonly signal?: "SIGINT" | "SIGTERM";
  /** How long the process has to leave after that signal before its tree is killed. 0: kill it at once. */
  readonly graceMs?: number;
}

/** The default grace: long enough for a clean exit, short enough to fit in the window VS Code gives `deactivate`. */
export const TERMINATE_GRACE_MS = 2000;

/**
 * Ask a process to stop and kill its tree if it has not left after `graceMs`. Resolves when it has ended (or, for a
 * process that cannot be signalled, after the kill). Calling it again for a process already being ended waits for
 * the same end.
 */
export function terminateChild(child: cp.ChildProcess, options: TerminateOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? TERMINATE_GRACE_MS;
  if (ended(child)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once("close", done);
    child.once("exit", done);
    if (platform === "win32" || graceMs <= 0) {
      killTree(child, platform, options.spawn);
      // A kill that could not even be sent (no pid, a process gone in the meantime) must not hang the caller.
      timer = setTimeout(done, 1000);
      return;
    }
    child.kill(options.signal ?? "SIGTERM");
    timer = setTimeout(() => {
      killTree(child, platform, options.spawn);
      timer = setTimeout(done, 1000);
    }, graceMs);
  });
}
