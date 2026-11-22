// A pull that overtook its document's `didOpen`. After a restart vscode-languageclient replays every open document to the new
// server, and a `textDocument/diagnostic` for the document the person just opened can go out in the middle of that replay,
// before the `didOpen` of the document itself. A server that does not know the document answers an empty full report
// (opentide <= 1.0.0rc3 does, in 1-2 ms), and the client does not pull again until the document changes: the file stays
// without diagnostics (Test VSIX run 45027783743: 6 of 16 rounds got none in 30 s; docs/PACKAGING.md, "Rounds with no
// diagnostics"). The guard asks once more, after the `didOpen`, when a pull went out before it and was answered empty.
// One guard per server start, so a new server starts with nothing sent. vscode-free.

/** How long a pull that overtook its `didOpen` waits for the `didOpen` before it gives up and keeps its answer. */
export const FIRST_PULL_WAIT_MS = 5000;

export class FirstPullGuard {
  /** Documents whose `didOpen` was sent to this server and that were not closed since. */
  private readonly sent = new Set<string>();
  private readonly waiting = new Map<string, Set<() => void>>();

  constructor(private readonly waitMs = FIRST_PULL_WAIT_MS) {}

  /** The `didOpen` of `uri` was sent. */
  opened(uri: string): void {
    this.sent.add(uri);
    const waiters = this.waiting.get(uri);
    this.waiting.delete(uri);
    for (const resolve of waiters ?? []) resolve();
  }

  /** The `didClose` of `uri` was sent: its next pull is for a document the server was told about again. */
  closed(uri: string): void {
    this.sent.delete(uri);
  }

  /**
   * Run `pull`; when it went out before the document's `didOpen` and was answered empty, wait for the `didOpen` (at most
   * `waitMs`, or until `cancelled`) and run `pullAgain`, once. Any other answer, and an answer that arrives after a `didOpen`,
   * is returned as it is.
   */
  async provide<T>(
    uri: string,
    pull: () => Promise<T>,
    isEmpty: (answer: T) => boolean,
    pullAgain: () => Promise<T>,
    cancelled: () => boolean = () => false,
  ): Promise<T> {
    const overtook = !this.sent.has(uri);
    const answer = await pull();
    if (!overtook || !isEmpty(answer) || cancelled()) return answer;
    if (!(await this.untilOpened(uri))) return answer;
    return cancelled() ? answer : pullAgain();
  }

  /** Whether the `didOpen` of `uri` was sent, waiting for it up to `waitMs`. */
  private untilOpened(uri: string): Promise<boolean> {
    if (this.sent.has(uri)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiters = this.waiting.get(uri) ?? new Set<() => void>();
      this.waiting.set(uri, waiters);
      const onOpened = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiters.delete(onOpened);
        resolve(false);
      }, this.waitMs);
      waiters.add(onOpened);
    });
  }
}
