// Whether `activate` met its budget (SPEC §14), from its wall time and, where Node has a per-thread clock, this thread's
// CPU time. vscode-free: the activation test asks it, and test/unit/activationBudget.test.ts tests it.

export interface ActivationBudget {
  /** Our own code's budget: this thread's CPU time, or wall time where there is no CPU clock. */
  readonly budgetMs: number;
  /**
   * The wall-time ceiling where CPU time is known. Wall time includes time the thread did not run, so it is judged
   * loosely; but a blocking synchronous read is off-CPU too, so it is still judged: the ceiling sits above the worst
   * healthy wall time CI has shown and below what such a regression (a process start, a synchronous read of the
   * workspace) costs.
   */
  readonly wallCeilingMs: number;
}

export interface ActivationVerdict {
  readonly ok: boolean;
  /** What was judged and against what, for the assertion message. */
  readonly reason: string;
}

const ms = (value: number): string => `${Math.round(value)} ms`;

export function activationVerdict(
  times: { readonly wallMs: number; readonly cpuMs?: number },
  budget: ActivationBudget,
): ActivationVerdict {
  if (times.cpuMs === undefined) {
    // No per-thread clock (Node before 22.19, e.g. VS Code 1.91): wall time against the budget, as before.
    return times.wallMs < budget.budgetMs
      ? { ok: true, reason: `activate took ${ms(times.wallMs)} (no CPU clock), under ${ms(budget.budgetMs)}` }
      : {
          ok: false,
          reason: `activate took ${ms(times.wallMs)} (no CPU clock to tell our code from the runner), the budget is ${ms(budget.budgetMs)}`,
        };
  }
  if (times.cpuMs >= budget.budgetMs) {
    return {
      ok: false,
      reason: `activate used ${ms(times.cpuMs)} of CPU (${ms(times.wallMs)} wall), the budget is ${ms(budget.budgetMs)}`,
    };
  }
  if (times.wallMs >= budget.wallCeilingMs) {
    return {
      ok: false,
      reason:
        `activate took ${ms(times.wallMs)} wall (${ms(times.cpuMs)} CPU), over the ${ms(budget.wallCeilingMs)} ceiling: ` +
        "time off the CPU this long is a blocking call (a process start, a synchronous read), not the runner",
    };
  }
  return {
    ok: true,
    reason: `activate used ${ms(times.cpuMs)} of CPU (budget ${ms(budget.budgetMs)}), ${ms(times.wallMs)} wall (ceiling ${ms(budget.wallCeilingMs)})`,
  };
}
