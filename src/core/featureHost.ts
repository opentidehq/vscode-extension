// Activates features, isolating failures: a feature that throws (or rejects) is logged and skipped.
import { performance } from "node:perf_hooks";

import type { FeatureContext, Logger } from "./context";
import type { Feature } from "./feature";

export interface FeatureOutcome {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
  /**
   * How long the feature's own `activate` ran before it returned: the synchronous part, which holds up the features
   * after it and the host. (Measured after the await, every feature's time included the ones that ran after it.)
   */
  readonly ms: number;
}

export async function activateFeatures(
  features: readonly Feature[],
  ctx: Pick<FeatureContext, "subscriptions"> & {
    readonly log: Pick<Logger, "info" | "error"> & Partial<Pick<Logger, "debug">>;
  },
): Promise<FeatureOutcome[]> {
  const began = performance.now();
  const seen = new Set<string>();
  const runs = features.map(async (feature): Promise<FeatureOutcome> => {
    const started = performance.now();
    if (seen.has(feature.id)) {
      ctx.log.error(`feature ${feature.id}: a second feature has the same id; skipped`);
      return { id: feature.id, ok: false, error: "duplicate id", ms: 0 };
    }
    seen.add(feature.id);
    try {
      // Call synchronously, so listeners a feature registers in activate() exist before the core starts.
      const pending = feature.activate(ctx as FeatureContext);
      const ms = performance.now() - started;
      const result = await pending;
      if (result) ctx.subscriptions.push(result);
      return { id: feature.id, ok: true, ms };
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      ctx.log.error(`feature ${feature.id} failed to activate: ${message}`);
      return { id: feature.id, ok: false, error: message, ms: performance.now() - started };
    }
  });
  const outcomes = await Promise.all(runs);
  const ok = outcomes.filter((outcome) => outcome.ok).length;
  if (outcomes.length > 0) ctx.log.info(`features: ${ok}/${outcomes.length} activated`);
  ctx.log.debug?.(activationSummary(outcomes, performance.now() - began));
  return outcomes;
}

/**
 * "features: 12 activated in 83 ms (slowest: sidebar 40 ms, graph 22 ms, matrix 9 ms)": the features run side by
 * side, so the total is the wall time, not the sum. Failed ones are counted apart.
 */
export function activationSummary(outcomes: readonly FeatureOutcome[], totalMs: number, slowest = 3): string {
  const activated = outcomes.filter((outcome) => outcome.ok);
  const failed = outcomes.length - activated.length;
  const slow = [...activated]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, slowest)
    .map((outcome) => `${outcome.id} ${Math.round(outcome.ms)} ms`);
  return (
    `features: ${activated.length} activated in ${Math.round(totalMs)} ms` +
    (slow.length > 0 ? ` (slowest: ${slow.join(", ")})` : "") +
    (failed > 0 ? `; ${failed} failed` : "")
  );
}
