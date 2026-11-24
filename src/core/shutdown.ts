// The extension's shutdown: every async disposal awaited inside the window VS Code gives `deactivate` (it waits for
// the promise it returns, then disposes `context.subscriptions` without waiting for them). The steps run one after
// another; the steps of a group run together, for disposals that do not wait on each other. vscode-free.

export interface ShutdownStep {
  readonly name: string;
  run(): Promise<unknown> | undefined;
}

/** What `runShutdown` runs: a step, or a group of steps that run at the same time and are all awaited. */
export type ShutdownPhase = ShutdownStep | readonly ShutdownStep[];

export interface ShutdownResult {
  /** Steps that finished, in the order they finished. */
  readonly done: readonly string[];
  /** Steps that threw, with why: the others still ran. */
  readonly failed: readonly { readonly name: string; readonly error: string }[];
  /**
   * The step that was running when the deadline passed (the unfinished steps of a group, joined with ", "); the
   * phases after it did not run.
   */
  readonly timedOut?: string;
  readonly notRun: readonly string[];
}

/**
 * Run the phases in order, awaiting each; the steps of a group run in parallel (`Promise.allSettled`), and the group is
 * over when the last of them is. A step that throws is recorded and the rest still run, in its group and after it.
 * After `deadlineMs` the shutdown gives up waiting (`timedOut` names the steps it was in) and `onTimeout` runs, to
 * force what is left: the host must not exit with a promise it is still waiting on, and must not wait forever on a
 * process that will not go.
 */
export async function runShutdown(
  phases: readonly ShutdownPhase[],
  options: { readonly deadlineMs: number; readonly onTimeout?: (stuck: string) => void },
): Promise<ShutdownResult> {
  const done: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const running = new Set<string>();
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve("deadline");
    }, options.deadlineMs);
  });
  const runStep = async (step: ShutdownStep): Promise<void> => {
    running.add(step.name);
    try {
      await step.run();
      done.push(step.name);
    } catch (error) {
      failed.push({ name: step.name, error: error instanceof Error ? error.message : String(error) });
    } finally {
      running.delete(step.name);
    }
  };
  const sequence = (async () => {
    for (const phase of phases) {
      if (expired) return;
      await Promise.allSettled(("name" in phase ? [phase] : phase).map(runStep));
    }
  })();
  const outcome = await Promise.race([sequence.then(() => "finished" as const), deadline]);
  if (timer) clearTimeout(timer);
  if (outcome === "deadline" && running.size > 0) {
    const stuck = [...running];
    options.onTimeout?.(stuck.join(", "));
    const reached = new Set([...done, ...failed.map((f) => f.name), ...stuck]);
    return {
      done,
      failed,
      timedOut: stuck.join(", "),
      notRun: phases
        .flatMap((phase) => ("name" in phase ? [phase] : phase))
        .map((step) => step.name)
        .filter((name) => !reached.has(name)),
    };
  }
  return { done, failed, notRun: [] };
}
