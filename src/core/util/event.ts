// A vscode-free event emitter whose `event` is structurally a `vscode.Event<T>`, so logic modules can be
// tested in plain node and features can subscribe to them like any VS Code event.

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (
  listener: (e: T) => unknown,
  thisArgs?: unknown,
  disposables?: Disposable[],
) => Disposable;

export class Emitter<T> implements Disposable {
  private listeners = new Set<(e: T) => unknown>();
  private disposed = false;

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const bound = thisArgs === undefined ? listener : listener.bind(thisArgs);
    if (this.disposed) return { dispose: () => {} };
    this.listeners.add(bound);
    const subscription = { dispose: () => this.listeners.delete(bound) };
    disposables?.push(subscription);
    return subscription;
  };

  /** Call every listener; one throwing listener does not stop the others. */
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error("opentide: event listener failed", error);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export function toDisposable(dispose: () => void): Disposable {
  return { dispose };
}

/** Dispose several disposables, collecting nothing on failure. */
export function disposeAll(disposables: Iterable<Disposable>): void {
  for (const disposable of disposables) {
    try {
      disposable.dispose();
    } catch {
      // keep disposing the rest
    }
  }
}
