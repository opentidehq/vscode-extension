// On the WASI and engine tiers, a real opentide can appear later: `pip install opentide`, a new .venv. The
// core looks again when one appears in a folder's .venv, and when the window gets the focus back (the user
// may have installed it in a terminal outside), at most once per interval. vscode-free.
import type { Runtime } from "./types";

/**
 * What is watched under a workspace folder: anything created in a .venv (its `bin/opentide` or
 * `Scripts/opentide.exe` among them), looked at once it settles.
 */
export const VENV_GLOB = ".venv/**";
export const VENV_SETTLE_MS = 1000;

/** At most one look per this many milliseconds on focus. */
export const RECHECK_INTERVAL_MS = 30_000;

/** Whether the runtime is one a user's own opentide replaces: the bundled WASI module or the engine. */
export function isBundled(runtime: Runtime | undefined): boolean {
  return runtime !== undefined && (runtime.kind === "engine" || runtime.wasi !== undefined);
}

/** Whether to resolve the runtime again now: only on a bundled tier, and not again too soon. */
export function shouldRecheck(
  runtime: Runtime | undefined,
  lastCheckedAt: number | undefined,
  now: number,
  intervalMs = RECHECK_INTERVAL_MS,
): boolean {
  if (!isBundled(runtime)) return false;
  return lastCheckedAt === undefined || now - lastCheckedAt >= intervalMs;
}
