// Values that may arrive before anyone listens (a WASI process starts running at once) are held and replayed to the
// first listener; a later listener hears what comes after it subscribes. A value that is a fact, not a stream (the
// process's exit), is latched: a listener that comes after it still hears it. vscode-free.

export class Buffered<T> {
  private readonly held: T[] = [];
  private readonly listeners = new Set<(value: T) => void>();
  private latched: { readonly value: T } | undefined;

  /** `latch`: remember the last value, for a listener that subscribes after it (an exit code). */
  constructor(private readonly latch = false) {}

  push(value: T): void {
    if (this.latch) this.latched = { value };
    if (this.listeners.size === 0) {
      if (!this.latch) this.held.push(value);
      return;
    }
    for (const listener of [...this.listeners]) listener(value);
  }

  /** Subscribe. The first listener also gets everything held so far (the last value, when latched). */
  listen(listener: (value: T) => void): void {
    const first = this.listeners.size === 0;
    this.listeners.add(listener);
    if (this.latch) {
      if (this.latched) listener(this.latched.value);
      return;
    }
    if (first) for (const value of this.held.splice(0)) listener(value);
  }
}
