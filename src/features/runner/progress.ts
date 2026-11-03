// Progress events (opentide#756) as `withProgress` reports. vscode-free.
import type { ProgressEvent } from "../../core/backend/types";

export interface ProgressReport {
  readonly message?: string;
  /** Percent to add to the bar (withProgress increments add up). */
  readonly increment?: number;
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Turns a run's events into reports. The bar only moves forward, even when a later step restarts its count. */
export class ProgressModel {
  private percent = 0;

  report(event: ProgressEvent): ProgressReport | undefined {
    if (event.event === "progress") {
      const step = typeof event.step === "string" ? event.step : "";
      const done = num(event.done);
      const total = num(event.total);
      if (done !== undefined && total !== undefined && total > 0) {
        const next = Math.min(100, Math.max(0, (done / total) * 100));
        const increment = next > this.percent ? next - this.percent : undefined;
        if (increment !== undefined) this.percent = next;
        return { message: `${step} ${done}/${total}`, ...(increment !== undefined ? { increment } : {}) };
      }
      return step ? { message: step } : undefined;
    }
    if (event.event === "tenant") {
      const where = `${String(event.platform ?? "")}/${String(event.tenant ?? "")}`;
      if (event.status === "failed") return { message: `${where}: failed` };
      const rows = num(event.rows);
      const elapsed = num(event.elapsed_ms);
      const parts = [
        rows !== undefined ? `${rows} rows` : "ok",
        elapsed !== undefined ? `${elapsed} ms` : "",
      ];
      return { message: `${where}: ${parts.filter(Boolean).join(", ")}` };
    }
    return undefined;
  }
}
