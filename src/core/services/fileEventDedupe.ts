// A file event reported twice: the same URI and type within a short window. vscode-languageclient sends the events of
// every watcher it has to the server and never merges them, so a file that two watchers cover (the client's static
// `synchronize.fileEvents` and a watch the server registers itself) reaches the server twice, and a server re-analyses
// per event. vscode-free.

export class RecentFileEvents {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs = 500,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the same event was reported within the window; either way it is remembered from now. */
  isDuplicate(uri: string, type: number): boolean {
    const at = this.now();
    const key = `${type} ${uri}`;
    const before = this.seen.get(key);
    this.seen.set(key, at);
    if (this.seen.size > 2000) {
      for (const [other, when] of this.seen) if (at - when > this.windowMs) this.seen.delete(other);
    }
    return before !== undefined && at - before <= this.windowMs;
  }
}
