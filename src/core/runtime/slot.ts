// One resolution at a time, the latest wins: starting a new one cancels the one in flight, whose result (now stale)
// is dropped. A restart (a setting or a folder changed) must not wait for a probe of a runtime that no longer matters:
// a `uv` probe may have minutes left. vscode-free.

export interface SlotRun<T> {
  /** The result, or undefined when this run was cancelled before it finished (it is stale: do not apply it). */
  readonly result: Promise<T | undefined>;
  readonly signal: AbortSignal;
}

export class ResolutionSlot<T> {
  private controller: AbortController | undefined;

  /** Cancel what is in flight, if anything. */
  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  /** Cancel the run in flight and start `work` in its place. */
  start(work: (signal: AbortSignal) => Promise<T>): SlotRun<T> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const result = work(controller.signal).then((value) => {
      if (this.controller === controller) this.controller = undefined;
      return controller.signal.aborted ? undefined : value;
    });
    return { result, signal: controller.signal };
  }

  get running(): boolean {
    return this.controller !== undefined;
  }
}
