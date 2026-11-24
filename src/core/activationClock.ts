// Where activation time goes besides our own code, for the activation test (SPEC §14): this thread's CPU time and
// the garbage collector's pauses. Wall time minus CPU is time the thread did not run (blocking I/O, or the OS running
// something else); GC is the collector's work for every extension in the host, which can land in any feature. vscode-free.
import { PerformanceObserver } from "node:perf_hooks";

/** A stretch of the performance timeline (`performance.now()` milliseconds). */
export interface Span {
  readonly at: number;
  readonly ms: number;
}

/**
 * This thread's CPU time in milliseconds, where Node has `process.threadCpuUsage` (Node 22.19 and later; older VS
 * Code ships an older Node): undefined otherwise. `process.cpuUsage` would count every thread of the host. It moves in
 * the OS's ticks (about 15.6 ms on Windows), so it tells a 400 ms spike apart, not a 5 ms feature.
 */
export function threadCpuClock(
  proc: { threadCpuUsage?: () => { user: number; system: number } } = process,
): (() => number) | undefined {
  const usage = proc.threadCpuUsage;
  if (typeof usage !== "function") return undefined;
  return () => {
    const { user, system } = usage.call(proc);
    return (user + system) / 1000;
  };
}

/** How much of `span` the `pauses` cover. */
export function overlapMs(span: Span, pauses: readonly Span[]): number {
  const end = span.at + span.ms;
  let total = 0;
  for (const pause of pauses) {
    const from = Math.max(span.at, pause.at);
    const to = Math.min(end, pause.at + pause.ms);
    if (to > from) total += to - from;
  }
  return total;
}

export interface GcWatch {
  /** The pauses so far. Node delivers them a task later, so read this after activation, not inside it. */
  pauses(): readonly Span[];
  dispose(): void;
}

/** Records GC pauses from now on; undefined where the `gc` entry type is not observable. */
export function watchGc(): GcWatch | undefined {
  const pauses: Span[] = [];
  const keep = (entries: readonly { startTime: number; duration: number }[]): void => {
    for (const entry of entries) pauses.push({ at: entry.startTime, ms: entry.duration });
  };
  const observer = new PerformanceObserver((list) => keep(list.getEntries()));
  try {
    observer.observe({ entryTypes: ["gc"] });
  } catch {
    return undefined;
  }
  return {
    pauses: () => {
      keep(observer.takeRecords());
      return pauses;
    },
    dispose: () => observer.disconnect(),
  };
}
