// One run at a time, for restarts: vscode-free.

/**
 * `task` wrapped to run one call at a time. A call made while a run is going waits for it, then one
 * more run follows with the latest reason; every call made meanwhile shares that run. Each call resolves
 * once a run that started after it was made has finished, so a caller sees its own request done.
 */
export function serialized(task: (reason: string) => Promise<void>): (reason: string) => Promise<void> {
  let running: Promise<void> | undefined;
  let queued: { reason: string; done: Promise<void> } | undefined;
  const run = (reason: string): Promise<void> => {
    const current = task(reason).finally(() => {
      if (running === current) running = undefined;
    });
    running = current;
    return current;
  };
  return (reason) => {
    if (queued) {
      queued.reason = reason;
      return queued.done;
    }
    if (!running) return run(reason);
    const next: { reason: string; done: Promise<void> } = { reason, done: Promise.resolve() };
    const after = (): Promise<void> => {
      queued = undefined;
      return run(next.reason);
    };
    next.done = running.then(after, after);
    queued = next;
    return next.done;
  };
}

/** Tasks run one after another, in the order they were queued; one that fails does not stop the rest. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
