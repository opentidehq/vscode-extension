// One run per key at a time: a new run for the same key cancels the one it supersedes. vscode-free.
import { type CancellationToken, CancellationTokenSource } from "../../core/util/cancellation";

export class Runs {
  private readonly running = new Map<string, CancellationTokenSource>();

  /**
   * Start a run for `key`, cancelling the previous one; `link` (a caller's token) cancels it too.
   * Call `finish` when it ends.
   */
  start(key: string, link?: CancellationToken): { token: CancellationToken; finish(): void } {
    this.running.get(key)?.cancel();
    const source = new CancellationTokenSource();
    this.running.set(key, source);
    const linked = link?.onCancellationRequested(() => source.cancel());
    return {
      token: source.token,
      finish: () => {
        linked?.dispose();
        if (this.running.get(key) === source) this.running.delete(key);
        source.dispose();
      },
    };
  }

  /** Cancel the run `key` and the runs under it (`key|…`); every run without a key. */
  cancel(key?: string): void {
    for (const [running, source] of this.running) {
      if (key !== undefined && running !== key && !running.startsWith(`${key}|`)) continue;
      source.cancel();
      this.running.delete(running);
    }
  }

  get size(): number {
    return this.running.size;
  }
}

/** The run key of a scope: `validate|<folder>` for the workspace, `validate|<folder>|<file>` for a file. */
export function runKey(source: string, folder: string, file?: string): string {
  return file ? `${source}|${folder}|${file}` : `${source}|${folder}`;
}
