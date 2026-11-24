// The crashes of one language server start, and the wait before each restart (restartPolicy.ts). A start the
// core makes on purpose (a restart, a stop) gets a new supervisor, so the count begins again. vscode-free.
import { recentCrashes, type RestartDecision, restartDecision } from "./restartPolicy";

export interface Clock {
  now(): number;
  /** Calls `fire` after `ms`; the returned function cancels it. */
  after(ms: number, fire: () => void): () => void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

export class CrashSupervisor {
  private crashes: number[] = [];
  private cancelled = false;
  private stopWaiting: (() => void) | undefined;

  constructor(private readonly clock: Clock = systemClock) {}

  /** The server was stopped or replaced on purpose: its closed connection is no crash. */
  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** The connection closed on its own: count it, and say what to do. */
  crashed(): RestartDecision & { readonly crashesInWindow: number } {
    const now = this.clock.now();
    this.crashes = [...recentCrashes(this.crashes, now), now];
    return { ...restartDecision(this.crashes, now), crashesInWindow: this.crashes.length };
  }

  /** Wait `ms`; false when `cancel` came first (the server was stopped on purpose meanwhile). */
  wait(ms: number): Promise<boolean> {
    if (this.cancelled) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const cancel = this.clock.after(ms, () => {
        this.stopWaiting = undefined;
        resolve(!this.cancelled);
      });
      this.stopWaiting = () => {
        cancel();
        this.stopWaiting = undefined;
        resolve(false);
      };
    });
  }

  /**
   * The server is being stopped or replaced: a restart that is waiting must not happen. True when one was
   * waiting, so the caller lets the client finish handling its closed connection before it stops it.
   */
  cancel(): boolean {
    this.cancelled = true;
    const waiting = this.stopWaiting !== undefined;
    this.stopWaiting?.();
    return waiting;
  }
}
