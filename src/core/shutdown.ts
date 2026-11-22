// The extension's shutdown: every async disposal awaited, one after another, inside the window VS Code gives
// `deactivate` (it waits for the promise it returns, then disposes `context.subscriptions` without waiting for them).
// vscode-free.

export interface ShutdownStep {
  readonly name: string;
  run(): Promise<unknown> | undefined;
}

export interface ShutdownResult {
  /** Steps that finished, in order. */
  readonly done: readonly string[];
  /** Steps that threw, with why: the others still ran. */
  readonly failed: readonly { readonly name: string; readonly error: string }[];
  /** The step that was running when the deadline passed; the steps after it did not run. */
  readonly timedOut?: string;
  readonly notRun: readonly string[];
}

/**
 * Run the steps in order, awaiting each. A step that throws is recorded and the rest still run. After `deadlineMs`
 * the shutdown gives up waiting (`timedOut` names the step it was in) and `onTimeout` runs, to force what is left: the
 * host must not exit with a promise it is still waiting on, and must not wait forever on a process that will not go.
 */
export async function runShutdown(
  steps: readonly ShutdownStep[],
  options: { readonly deadlineMs: number; readonly onTimeout?: (stuck: string) => void },
): Promise<ShutdownResult> {
  const done: string[] = [];
  const failed: { name: string; error: string }[] = [];
  let current: string | undefined;
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve("deadline");
    }, options.deadlineMs);
  });
  const sequence = (async () => {
    for (const step of steps) {
      if (expired) return;
      current = step.name;
      try {
        await step.run();
        done.push(step.name);
      } catch (error) {
        failed.push({ name: step.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    current = undefined;
  })();
  const outcome = await Promise.race([sequence.then(() => "finished" as const), deadline]);
  if (timer) clearTimeout(timer);
  if (outcome === "deadline" && current !== undefined) {
    options.onTimeout?.(current);
    const reached = new Set([...done, ...failed.map((f) => f.name), current]);
    return {
      done,
      failed,
      timedOut: current,
      notRun: steps.map((s) => s.name).filter((name) => !reached.has(name)),
    };
  }
  return { done, failed, notRun: [] };
}
