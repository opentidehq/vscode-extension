// "Use the pinned version": turn on opentide.uv.usePin and say why uv did not take over. vscode-free.
import type { ResolveAttempt, Runtime } from "./types";

export interface PinnedRuntime {
  readonly current: Runtime | undefined;
  readonly attempts: readonly ResolveAttempt[];
  restart(reason?: string): Promise<void>;
}

/**
 * Turn on `opentide.uv.usePin` (`enable`), resolve again with it, and return the warning to show when the
 * runtime is still not uv's, else undefined. The attempts read are the new resolution's, not the one from
 * before the setting changed (which always says "opentide.uv.usePin is off").
 */
export async function usePinnedVersion(
  runtime: PinnedRuntime,
  enable: () => PromiseLike<void>,
): Promise<string | undefined> {
  await enable();
  await runtime.restart("opentide.uv.usePin turned on");
  if (runtime.current?.source === "uv") return undefined;
  const uv = runtime.attempts.find((attempt) => attempt.source === "uv");
  return uv ? `Could not use the pinned version with uv: ${uv.detail}` : undefined;
}
