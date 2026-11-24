// Time limits for a language client's start and stop. A start that never gets its `initialize` answered (a WASI process
// that never answers, an engine that never loads), or a stop that waits for a server that cannot reply, would otherwise
// hold the one start-and-stop queue for ever, and every restart behind it. vscode-free.

/** How long a start may take before it is given up on: the first start of a large workspace is seconds, not half a minute. */
export const START_TIMEOUT_MS = 30_000;
/** How long `client.stop` may take: it waits up to 5 s for the server's `shutdown` answer itself. */
export const STOP_TIMEOUT_MS = 8_000;
/** How long `client.dispose` may take once the stop is over. */
export const DISPOSE_TIMEOUT_MS = 4_000;

/** What of a language client the limits need. */
export interface BoundedClient {
  start(): Promise<void>;
  stop(timeout?: number): Promise<void>;
  dispose(timeout?: number): Promise<void>;
}

/** How a piece of work that is given a time limit ended. */
export type Outcome<T> =
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "abandoned" };

/**
 * Wait for `work` for at most `ms`, or until `abandoned` settles: whichever comes first. The work itself is not
 * stopped (a promise cannot be); its later result or failure is dropped.
 */
export function bounded<T>(work: Promise<T>, ms: number, abandoned?: Promise<unknown>): Promise<Outcome<T>> {
  return new Promise<Outcome<T>>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
    const end = (outcome: Outcome<T>): void => {
      clearTimeout(timer);
      resolve(outcome);
    };
    work.then(
      (value) => end({ kind: "done", value }),
      (error: unknown) =>
        end({ kind: "failed", error: error instanceof Error ? error.message : String(error) }),
    );
    void abandoned?.then(() => end({ kind: "abandoned" }));
  });
}

export type StartOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: string;
      /** A stop or a new start was asked for while this one was still going: not a failure of the server. */
      readonly abandoned?: true;
    };

/** `client.start()`, given up on after `timeoutMs` or when `abandoned` settles. The caller disposes a client that did not start. */
export async function startBounded(
  client: Pick<BoundedClient, "start">,
  options: { readonly timeoutMs?: number; readonly abandoned?: Promise<unknown> } = {},
): Promise<StartOutcome> {
  const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS;
  const outcome = await bounded(client.start(), timeoutMs, options.abandoned);
  switch (outcome.kind) {
    case "done":
      return { ok: true };
    case "failed":
      return { ok: false, error: outcome.error };
    case "abandoned":
      return {
        ok: false,
        error: "a stop or a new start was asked for while it was starting",
        abandoned: true,
      };
    case "timeout":
      return {
        ok: false,
        error: `the language server did not answer \`initialize\` in ${timeoutMs / 1000} s`,
      };
  }
}

/** `client.dispose()` within `disposeMs`; what went wrong, if anything, for the log. */
export async function disposeBounded(
  client: Pick<BoundedClient, "dispose">,
  disposeMs = DISPOSE_TIMEOUT_MS,
): Promise<readonly string[]> {
  const disposed = await bounded(client.dispose(), disposeMs);
  return disposed.kind === "timeout" ? [`did not dispose in ${disposeMs / 1000} s`] : [];
}

/**
 * Stop and dispose a client, each within its limit. Returns what went wrong, if anything, for the log: whatever
 * happened, the caller then ends the process or the worker behind the client, which is what makes the limits final.
 */
export async function stopBounded(
  client: Pick<BoundedClient, "stop" | "dispose">,
  options: { readonly stopMs?: number; readonly disposeMs?: number; readonly shutdownMs?: number } = {},
): Promise<readonly string[]> {
  const problems: string[] = [];
  const stopMs = options.stopMs ?? STOP_TIMEOUT_MS;
  const stopped = await bounded(client.stop(options.shutdownMs ?? 5000), stopMs);
  if (stopped.kind === "failed") problems.push(`did not stop cleanly: ${stopped.error}`);
  else if (stopped.kind === "timeout") problems.push(`did not stop in ${stopMs / 1000} s`);
  problems.push(...(await disposeBounded(client, options.disposeMs)));
  return problems;
}
