// A view's data from an opentide command (Platforms: `info`, Health: `doctor`): loaded lazily when the
// view is visible, debounced and single-flight, re-loaded when shown after a change it missed.
// vscode-free.
import { Emitter, type Event } from "../../core/util/event";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface LoadState<T> {
  readonly status: LoadStatus;
  /** The last good value; kept while a reload runs or after one fails. */
  readonly value?: T;
  readonly error?: string;
  readonly loadedAt?: number;
}

export interface LoaderOptions<T> {
  load(): Promise<T>;
  /** Is the view on screen? A hidden view only marks itself stale. */
  isVisible(): boolean;
  readonly debounceMs?: number;
  now?(): number;
}

export class Loader<T> {
  private current: LoadState<T> = { status: "idle" };
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stale = true;
  private disposed = false;
  private readonly emitter = new Emitter<LoadState<T>>();

  readonly onDidChange: Event<LoadState<T>> = this.emitter.event;

  constructor(private readonly options: LoaderOptions<T>) {}

  get state(): LoadState<T> {
    return this.current;
  }

  /** Something it depends on changed: reload (debounced) when visible, else when next shown. */
  request(options: { immediate?: boolean } = {}): void {
    this.stale = true;
    if (!this.options.isVisible() || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.kick();
      },
      options.immediate ? 0 : (this.options.debounceMs ?? 1000),
    );
  }

  /** The view became visible: load when never loaded or stale. */
  shown(): void {
    if (this.stale) this.request({ immediate: true });
  }

  /** Load now and wait for it (a refresh button, a test). */
  async reload(): Promise<LoadState<T>> {
    this.stale = true;
    await this.kick();
    return this.current;
  }

  private kick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.stale = false;
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        void this.kick();
      }
    });
    return this.running;
  }

  private async run(): Promise<void> {
    const now = this.options.now ?? Date.now;
    this.set({ ...this.current, status: "loading" });
    try {
      const value = await this.options.load();
      this.set({ status: "ready", value, loadedAt: now() });
    } catch (error) {
      this.set({
        status: "error",
        ...(this.current.value !== undefined ? { value: this.current.value } : {}),
        error: error instanceof Error ? error.message : String(error),
        loadedAt: now(),
      });
    }
  }

  private set(state: LoadState<T>): void {
    this.current = state;
    if (!this.disposed) this.emitter.fire(state);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.emitter.dispose();
  }
}

/** Collapse bursts of calls into one, `ms` after the last. */
export function debounce(fn: () => void, ms: number): { (): void; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const call = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  };
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return call;
}
