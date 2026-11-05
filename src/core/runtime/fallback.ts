// When the language server of a runtime that answered `--version` does not start (a bundled runtime
// whose engine module fails to load, an opentide whose `lsp start` crashes), the engine (WASM) serves
// the editor features instead, and says why (SPEC §4). The runtime stays what it is for commands.
// vscode-free.
import type { Runtime } from "./types";

export interface ServerStart {
  readonly ok: boolean;
  /** Why it did not start. */
  readonly error?: string;
}

export interface Fallback {
  /** The runtime whose language server did not start. */
  readonly from: Runtime;
  readonly reason: string;
}

export interface Started {
  /** The runtime whose language server runs, or undefined when none does. */
  readonly server: Runtime | undefined;
  readonly fallback?: Fallback;
}

/**
 * Start `runtime`'s language server; when it is a process that fails, start the engine's, which
 * `engine` gives (as restricted as the runtime), if the extension carries one.
 */
export async function startWithFallback(
  runtime: Runtime,
  start: (runtime: Runtime) => Promise<ServerStart>,
  engine: (restricted: boolean) => Runtime | undefined,
): Promise<Started> {
  const first = await start(runtime);
  if (first.ok) return { server: runtime };
  if (runtime.kind === "engine") return { server: undefined };
  const fallback: Fallback = { from: runtime, reason: first.error ?? "the language server did not start" };
  const wasm = engine(runtime.restricted);
  if (!wasm) return { server: undefined, fallback };
  const second = await start(wasm);
  return second.ok ? { server: wasm, fallback } : { server: undefined, fallback };
}

/** The attempts that record a fallback, for the runtime's resolution log and the status tooltip. */
export function fallbackAttempts(fallback: Fallback, engine: Runtime) {
  return [
    {
      tier: fallback.from.tier,
      source: fallback.from.source,
      outcome: "failed" as const,
      path: fallback.from.command,
      version: fallback.from.version,
      detail: `${fallback.from.command}: the language server did not start (${fallback.reason}); the engine (WASM) serves the editor features`,
    },
    {
      tier: engine.tier,
      source: engine.source,
      outcome: "ok" as const,
      path: engine.command,
      version: engine.version,
      detail: `${engine.command} ${engine.version}: the language server, in place of ${fallback.from.source}'s`,
    },
  ];
}
