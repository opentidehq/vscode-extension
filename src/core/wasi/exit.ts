// When a WASI process under @vscode/wasm-wasi has ended. `WasmProcess.run()` settles only when the module calls
// `proc_exit`, and `terminate()` kills the worker without settling it (ms-vscode.wasm-wasi-core 1.0.4,
// common/process.ts and desktop/process.ts): a process the extension ended itself never reported an exit, so whoever
// waited for it (a restart stopping `opentide serve`, a language client reading the server's pipe) waited for ever.
// The exit is reported once, from whichever comes first: `run()` settling, or `terminate()` having settled. vscode-free.

/** How a process ended. */
export type ProcessExit =
  | { readonly kind: "exited"; readonly code: number }
  /** `run()` rejected. */
  | { readonly kind: "failed"; readonly error: unknown }
  /** The extension ended it (`terminate`), and `run()` had not settled. */
  | { readonly kind: "terminated" };

/** What of a `WasmProcess` the exit needs. */
export interface TerminableRun {
  run(): Promise<number>;
  terminate(): Promise<unknown>;
}

/**
 * Call `onExit` exactly once, when `run()` settles or when a `terminate()` made through the returned handle has
 * settled (whichever is first; the other is dropped). `terminate()` never rejects.
 */
export function watchExit(
  proc: TerminableRun,
  onExit: (exit: ProcessExit) => void,
): { terminate(): Promise<void> } {
  let ended = false;
  const end = (exit: ProcessExit): void => {
    if (ended) return;
    ended = true;
    onExit(exit);
  };
  void proc.run().then(
    (code) => end({ kind: "exited", code }),
    (error: unknown) => end({ kind: "failed", error }),
  );
  return {
    terminate: async () => {
      await Promise.resolve()
        .then(() => proc.terminate())
        .catch(() => undefined);
      end({ kind: "terminated" });
    },
  };
}
