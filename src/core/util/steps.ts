// Where a stretch of synchronous work went, step by step: the activation test prints it beside `core`, so a slow
// `createCore` says which step held the thread. vscode-free.
import { performance } from "node:perf_hooks";

export interface Step {
  readonly name: string;
  readonly ms: number;
}

export class Steps {
  private last: number;
  private readonly recorded: Step[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {
    this.last = now();
  }

  /** The time since the previous mark (or the start) was spent on `name`. */
  mark(name: string): void {
    const now = this.now();
    this.recorded.push({ name, ms: now - this.last });
    this.last = now;
  }

  get all(): readonly Step[] {
    return this.recorded;
  }
}
