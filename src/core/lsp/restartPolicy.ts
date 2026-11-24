// When the language server's connection closes on its own, how soon the client starts it again, and when it
// stops trying: the crashes of the last three minutes decide. vscode-free.

/** The wait before each restart: the first crash in the window waits the first entry, the second the second, … */
export const BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000];

/** The crash that ends the restarts: this many in the window and the server is given up on. */
export const CRASH_CEILING = BACKOFF_MS.length + 1;

/** The window the crashes are counted in; a crash older than this no longer counts. */
export const CRASH_WINDOW_MS = 3 * 60 * 1000;

export type RestartDecision =
  /** Start the server again after this many milliseconds. */
  | { readonly restartAfterMs: number }
  /** Stop: it crashed `crashes` times within the window. */
  | { readonly giveUp: true; readonly crashes: number };

/**
 * What to do about a crash that happened at `now`. `crashes` are the timestamps (ms) of the crashes so far,
 * this one included; only those within the last three minutes count, so a server that ran well for a while
 * starts again from the shortest wait.
 */
export function restartDecision(crashes: readonly number[], now: number): RestartDecision {
  const recent = crashes.filter((at) => now - at < CRASH_WINDOW_MS).length;
  if (recent >= CRASH_CEILING) return { giveUp: true, crashes: recent };
  const wait = BACKOFF_MS[Math.max(recent, 1) - 1];
  return { restartAfterMs: wait ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 0 };
}

/** The crash timestamps worth keeping at `now`: the ones still inside the window. */
export function recentCrashes(crashes: readonly number[], now: number): number[] {
  return crashes.filter((at) => now - at < CRASH_WINDOW_MS);
}

/** The failed message writes in a row the client carries on through before it shuts the connection down. */
export const WRITE_ERRORS_TOLERATED = 3;

/**
 * What to do when the connection to the language server errors. vscode-jsonrpc counts the messages it failed to
 * write in a row; an error of the streams themselves (the server's output breaking, or its input refusing writes as
 * the process ends: on Windows a pipe can error before it closes) comes with no count. That is the server going away:
 * the close that follows decides, under the crash policy above, whether it starts again. Shutting down on it instead
 * stopped the client, and a stopping client skips the close handler, so a crashed server was never started again.
 */
export function connectionErrorAction(count: number | undefined): "continue" | "shutdown" {
  if (count === undefined) return "continue";
  return count <= WRITE_ERRORS_TOLERATED ? "continue" : "shutdown";
}
