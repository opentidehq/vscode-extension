// Where the graph panel goes and where it opens files (SPEC §10.1 "Beside the object"): beside the editor
// it was asked from, without taking the focus, and files in the editor's group, never over the graph.
// Also the debounce of "Follow editor". vscode-free: columns are vscode.ViewColumn numbers.

/** vscode.ViewColumn.Active and .Beside. */
export const ACTIVE = -1;
export const BESIDE = -2;

export interface ShowContext {
  /** The active text editor's column, if there is one. */
  readonly editorColumn?: number;
  /** The open panel's column, if the panel is open. */
  readonly panelColumn?: number;
}

export interface ShowPlan {
  /** Create the panel in this column, or reveal the open one there (undefined: where it is). */
  readonly column: number | undefined;
  /** Leave the focus in the editor. */
  readonly preserveFocus: boolean;
}

/**
 * Asked from an editor (its title, context menu, a CodeLens, the sidebar or Find Detection with an
 * editor open): beside it, the focus left in the editor. With no editor: in the active group, focused.
 * An open panel stays in its group unless that is the editor's, where it would cover the YAML.
 */
export function showPlan(context: ShowContext): ShowPlan {
  const fromEditor = context.editorColumn !== undefined;
  if (context.panelColumn === undefined)
    return { column: fromEditor ? BESIDE : ACTIVE, preserveFocus: fromEditor };
  const covers = fromEditor && context.panelColumn === context.editorColumn;
  return { column: covers ? BESIDE : undefined, preserveFocus: true };
}

/**
 * The column a file opened from the graph goes to: the group of the editor last used that is not the
 * graph's, else beside the graph.
 */
export function openColumn(panelColumn: number | undefined, editorColumns: readonly number[]): number {
  return editorColumns.find((column) => column !== panelColumn) ?? BESIDE;
}

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Runs `run` with the last value pushed, `delay` ms after the pushes stop. */
export class Debounced<T> {
  private handle: unknown;
  private pending = false;

  constructor(
    private readonly delay: number,
    private readonly run: (value: T) => void,
    private readonly timers: Timers = realTimers,
  ) {}

  push(value: T): void {
    this.cancel();
    this.pending = true;
    this.handle = this.timers.set(() => {
      this.pending = false;
      this.handle = undefined;
      this.run(value);
    }, this.delay);
  }

  get isPending(): boolean {
    return this.pending;
  }

  cancel(): void {
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = undefined;
    this.pending = false;
  }
}

/** The editor-follow delay: an editor switch storm (Ctrl+Tab held) posts once. */
export const FOLLOW_DELAY_MS = 150;

/** A file whose object the graph goes to once the catalogue arrives (asked for before it loaded). */
export interface AwaitedFile {
  readonly path: string;
  /** Asked for explicitly (Show in Graph), not by following the editor. */
  readonly explicit: boolean;
}

/**
 * "Follow editor" and the pin, without vscode: which editor to follow and when (debounced), the last
 * text editor seen (a webview with the focus makes the active editor undefined), and the file awaited
 * before the catalogue loads, which a pin drops unless it was asked for explicitly.
 */
export class EditorFollow<E> {
  private on = true;
  private last: E | undefined;
  private awaited: AwaitedFile | undefined;
  private readonly debounced: Debounced<E>;

  constructor(delay: number, run: (editor: E) => void, timers?: Timers) {
    this.debounced = new Debounced<E>(delay, run, timers);
  }

  get following(): boolean {
    return this.on;
  }

  /** The text editor last active (it may have closed since). */
  get lastEditor(): E | undefined {
    return this.last;
  }

  get awaiting(): AwaitedFile | undefined {
    return this.awaited;
  }

  /** The active editor changed; undefined when a webview (the graph itself) or nothing has the focus. */
  editorChanged(editor: E | undefined, panelOpen: boolean): void {
    if (editor === undefined) return;
    this.last = editor;
    if (panelOpen && this.on) this.debounced.push(editor);
  }

  /**
   * Pin (false) or unpin (true). A pin cancels a pending follow and drops a followed file still awaited;
   * an unpin returns the editor to catch up with.
   */
  setFollowing(following: boolean): E | undefined {
    this.on = following;
    if (following) return this.last;
    this.debounced.cancel();
    if (this.awaited && !this.awaited.explicit) this.awaited = undefined;
    return undefined;
  }

  /** An explicit request (Show in Graph, a reveal) wins over a follow still waiting for its delay. */
  explicitRequest(): void {
    this.debounced.cancel();
  }

  awaitFile(file: AwaitedFile | undefined): void {
    this.awaited = file;
  }

  /** The awaited file, once: the catalogue has arrived. */
  takeAwaited(): AwaitedFile | undefined {
    const file = this.awaited;
    this.awaited = undefined;
    return file;
  }

  /** The panel closed: following again, nothing pending. */
  reset(): void {
    this.on = true;
    this.awaited = undefined;
    this.debounced.cancel();
  }

  dispose(): void {
    this.debounced.cancel();
  }
}
