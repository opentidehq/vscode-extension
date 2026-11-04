// `unreviewed:` answers come from `opentide rules unreviewed --older-than <window>` (SPEC §10.3), one
// run per folder and window, cached until the catalogue changes. vscode-free.
import { unreviewedPaths } from "./present";

export interface UnreviewedDeps {
  /** Whether the active opentide has `rules unreviewed`. */
  hasCommand(): boolean;
  /** `opentide --json rules unreviewed --older-than <window>` in the folder; the document it printed. */
  run(folder: string, window: string): Promise<unknown>;
  log(message: string): void;
}

export class UnreviewedCache {
  private readonly answers = new Map<string, Map<string, ReadonlySet<string>>>();
  /** Per running folder set and window, everyone waiting for it: each pick window that asked. */
  private readonly running = new Map<string, Set<() => void>>();
  private generation = 0;

  constructor(private readonly deps: UnreviewedDeps) {}

  /**
   * The paths per folder for `window`, or undefined while a run is under way; `onReady` is called once
   * the answer arrives, also when the run was started by an earlier ask (another Find Detection window).
   * A folder whose run failed (or an opentide without the command) lists nothing.
   */
  get(
    window: string,
    folders: readonly string[],
    onReady: () => void,
  ): ReadonlyMap<string, ReadonlySet<string>> | undefined {
    const known = this.answers.get(window);
    if (known && folders.every((folder) => known.has(folder))) return known;
    if (!this.deps.hasCommand()) {
      const empty = new Map(folders.map((folder) => [folder, new Set<string>()]));
      this.answers.set(window, empty);
      return empty;
    }
    const key = `${window}\n${folders.join("\n")}`;
    const waiting = this.running.get(key);
    if (waiting) waiting.add(onReady);
    else {
      const callbacks = new Set([onReady]);
      this.running.set(key, callbacks);
      const generation = this.generation;
      void Promise.all(
        folders.map(async (folder): Promise<[string, ReadonlySet<string>]> => {
          try {
            return [folder, unreviewedPaths(await this.deps.run(folder, window)) ?? new Set()];
          } catch (error) {
            this.deps.log(`rules unreviewed in ${folder}: ${String(error)}`);
            return [folder, new Set()];
          }
        }),
      ).then((entries) => {
        if (generation !== this.generation) return;
        this.running.delete(key);
        this.answers.set(window, new Map([...(this.answers.get(window) ?? []), ...entries]));
        for (const callback of callbacks) callback();
      });
    }
    return undefined;
  }

  /** Forget every answer (the catalogue changed, or the runtime did). */
  clear(): void {
    this.generation += 1;
    this.answers.clear();
    this.running.clear();
  }
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const NODE_TIMERS: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Lets a `rules unreviewed` run start only for a window left alone for `delayMs`: typed key by key,
 * `unreviewed:>180d` would otherwise run for 1d, 18d and 180d. `onSettle` asks again once it settles.
 */
export class SettledWindow {
  private pending: { window: string; handle: unknown } | undefined;

  constructor(
    private settled: string | undefined,
    private readonly delayMs: number,
    private readonly onSettle: () => void,
    private readonly timers: Timers = NODE_TIMERS,
  ) {}

  /** Whether a run for `window` may start now; if not, it may once `window` stays for `delayMs`. */
  ready(window: string): boolean {
    if (window === this.settled) return true;
    if (this.pending?.window !== window) {
      if (this.pending) this.timers.clear(this.pending.handle);
      const handle = this.timers.set(() => {
        this.pending = undefined;
        this.settled = window;
        this.onSettle();
      }, this.delayMs);
      this.pending = { window, handle };
    }
    return false;
  }

  dispose(): void {
    if (this.pending) this.timers.clear(this.pending.handle);
    this.pending = undefined;
  }
}
