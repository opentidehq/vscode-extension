// Batches saves into one background run per folder (Save All gives one run), and tells `opentide serve`
// about each saved file at once. vscode-free.
//
// serve answers read-only runs from snapshots of the files it read before; the file watcher's
// `invalidate` comes only after the watcher event and its own 300 ms debounce, so a validate sent on
// save would check the file as it was before the save. Invalidating on save keeps the order right.

export interface SaveBatch<F> {
  readonly folder: F;
  readonly files: Set<string>;
  configuration: boolean;
}

export interface SaveBatcherOptions<F> {
  /** `backend.invalidate`: called with the saved file before any run for it is sent. */
  invalidate(paths: readonly string[]): void;
  /** The batches, once no save came for `delayMs`. */
  flush(batches: SaveBatch<F>[]): unknown;
  readonly delayMs?: number;
}

export class SaveBatcher<F> {
  private readonly pending = new Map<string, SaveBatch<F>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: SaveBatcherOptions<F>) {}

  /** A saved object file (`object`) or configuration file of the folder keyed `key`. */
  add(key: string, folder: F, file: string, kind: "object" | "configuration"): void {
    this.options.invalidate([file]);
    let batch = this.pending.get(key);
    if (!batch) {
      batch = { folder, files: new Set(), configuration: false };
      this.pending.set(key, batch);
    }
    if (kind === "object") batch.files.add(file);
    else batch.configuration = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.options.delayMs ?? 300);
  }

  private flush(): void {
    this.timer = undefined;
    const batches = [...this.pending.values()];
    this.pending.clear();
    if (batches.length > 0) this.options.flush(batches);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }
}
