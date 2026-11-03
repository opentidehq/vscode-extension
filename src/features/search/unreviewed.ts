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
  private readonly running = new Map<string, Promise<void>>();
  private generation = 0;

  constructor(private readonly deps: UnreviewedDeps) {}

  /**
   * The paths per folder for `window`, or undefined while a run is under way; `onReady` is called once
   * the answer arrives. A folder whose run failed (or an opentide without the command) lists nothing.
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
    if (!this.running.has(key)) {
      const generation = this.generation;
      const run = Promise.all(
        folders.map(async (folder): Promise<[string, ReadonlySet<string>]> => {
          try {
            return [folder, unreviewedPaths(await this.deps.run(folder, window)) ?? new Set()];
          } catch (error) {
            this.deps.log(`rules unreviewed in ${folder}: ${String(error)}`);
            return [folder, new Set()];
          }
        }),
      ).then((entries) => {
        this.running.delete(key);
        if (generation !== this.generation) return;
        this.answers.set(window, new Map([...(this.answers.get(window) ?? []), ...entries]));
        onReady();
      });
      this.running.set(key, run);
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
