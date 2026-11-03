// Activates features, isolating failures: a feature that throws (or rejects) is logged and skipped.
import type { FeatureContext, Logger } from "./context";
import type { Feature } from "./feature";

export interface FeatureOutcome {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly ms: number;
}

export async function activateFeatures(
  features: readonly Feature[],
  ctx: Pick<FeatureContext, "subscriptions"> & { readonly log: Pick<Logger, "info" | "error"> },
): Promise<FeatureOutcome[]> {
  const seen = new Set<string>();
  const runs = features.map(async (feature): Promise<FeatureOutcome> => {
    const started = Date.now();
    if (seen.has(feature.id)) {
      ctx.log.error(`feature ${feature.id}: a second feature has the same id; skipped`);
      return { id: feature.id, ok: false, error: "duplicate id", ms: 0 };
    }
    seen.add(feature.id);
    try {
      // Call synchronously, so listeners a feature registers in activate() exist before the core starts.
      const result = await feature.activate(ctx as FeatureContext);
      if (result) ctx.subscriptions.push(result);
      return { id: feature.id, ok: true, ms: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      ctx.log.error(`feature ${feature.id} failed to activate: ${message}`);
      return { id: feature.id, ok: false, error: message, ms: Date.now() - started };
    }
  });
  const outcomes = await Promise.all(runs);
  const ok = outcomes.filter((outcome) => outcome.ok).length;
  if (outcomes.length > 0) ctx.log.info(`features: ${ok}/${outcomes.length} activated`);
  return outcomes;
}
