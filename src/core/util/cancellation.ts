// A vscode-free cancellation token, structurally compatible with `vscode.CancellationToken`.
import { type Disposable, Emitter, type Event } from "./event";

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<unknown>;
}

export class CancellationTokenSource implements Disposable {
  private readonly emitter = new Emitter<unknown>();
  private cancelled = false;
  readonly token: CancellationToken;

  constructor() {
    const isCancelled = (): boolean => this.cancelled;
    const emitter = this.emitter;
    this.token = {
      get isCancellationRequested(): boolean {
        return isCancelled();
      },
      onCancellationRequested: (listener, thisArgs, disposables) => {
        if (isCancelled()) {
          queueMicrotask(() => listener(undefined));
          return { dispose: () => {} };
        }
        return emitter.event(listener, thisArgs, disposables);
      },
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
