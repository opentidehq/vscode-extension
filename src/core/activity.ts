// The last 50 runs, for the Activity view and "copy command" (SPEC §9). vscode-free.
import type { RunRecord, RunStatus } from "./backend/backend";
import { Emitter, type Event } from "./util/event";

export interface ActivityEntry {
  readonly id: number;
  readonly argv: readonly string[];
  readonly argvDisplay: string;
  readonly folder: string;
  readonly startedAt: number;
  readonly status: RunStatus;
  readonly via?: "serve" | "spawn";
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly failureCode?: string;
  readonly error?: string;
}

export const ACTIVITY_LIMIT = 50;

export class ActivityLog {
  private readonly entries: ActivityEntry[] = [];
  private readonly emitter = new Emitter<readonly ActivityEntry[]>();

  /** The list changed; newest first. */
  readonly onDidChange: Event<readonly ActivityEntry[]> = this.emitter.event;

  constructor(private readonly limit = ACTIVITY_LIMIT) {}

  /** Newest first. */
  list(): readonly ActivityEntry[] {
    return [...this.entries];
  }

  /** Add a run, or update it when its id is already there (a run that started, now finished). */
  record(run: RunRecord): void {
    const entry: ActivityEntry = {
      id: run.id,
      argv: run.argv,
      argvDisplay: run.argvDisplay,
      folder: run.folder,
      startedAt: run.startedAt,
      status: run.status,
      ...(run.via ? { via: run.via } : {}),
      ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      ...(run.failureCode ? { failureCode: run.failureCode } : {}),
      ...(run.error ? { error: run.error } : {}),
    };
    const index = this.entries.findIndex((existing) => existing.id === run.id);
    if (index >= 0) this.entries[index] = entry;
    else {
      this.entries.unshift(entry);
      if (this.entries.length > this.limit) this.entries.length = this.limit;
    }
    this.emitter.fire(this.list());
  }

  clear(): void {
    this.entries.length = 0;
    this.emitter.fire([]);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
