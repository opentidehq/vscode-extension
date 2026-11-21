// The line the log carries when the runtime ended on the engine: why no opentide, WASI module included, is
// running. vscode-free.
import type { ResolveAttempt } from "./types";

/**
 * Why the engine is the runtime. Restricted Mode runs no opentide by design (the bundled module included), so
 * it says that and what to do, not "install opentide"; a module switched off by `opentide.wasi.enabled` says so;
 * otherwise the module is missing from this build, and installing opentide is the way to commands.
 */
export function engineNotice(
  label: string,
  version: string,
  trusted: boolean,
  attempts: readonly Pick<ResolveAttempt, "tier" | "outcome" | "detail">[],
): string {
  const head = `runtime: ${label} ${version}: editor features only.`;
  if (!trusted) {
    return (
      `${head} The folder is not trusted (Restricted Mode): no opentide runs, the bundled WASI module ` +
      "included. Trust the folder for commands, validate, deploy and query."
    );
  }
  const wasi = attempts.find((attempt) => attempt.tier === 4);
  if (wasi?.outcome === "skipped") {
    return `${head} The bundled WASI module is off (${wasi.detail}); install opentide, or turn it on, for commands, validate, deploy and query.`;
  }
  return (
    `${head} No opentide answered (opentide.path, the workspace's environment, python -m opentide) and the ` +
    `bundled WASI module is not available${wasi ? ` (${wasi.detail})` : ""}: install opentide for commands, ` +
    "validate, deploy and query."
  );
}
