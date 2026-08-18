import type { AreaErrorMetrics } from '../types.ts';

/**
 * Cartographic error per Nusrat & Kobourov (2016), "The State of the Art in Cartograms".
 *
 *   err(v) = |o(v) - w(v)| / max(o(v), w(v))
 *
 * with o = achieved area and w = desired value, both normalized to sum to 1.
 * The max() denominator (not w) bounds every term in [0, 1] and is what makes our
 * numbers comparable with the literature. Dividing by w instead lets one tiny region
 * dominate the mean, which is the most common cross-paper inconsistency.
 */
export function cartographicError(outputAreas: ArrayLike<number>, values: ArrayLike<number>): {
  perFeature: Float64Array;
  summary: AreaErrorMetrics;
} {
  const n = outputAreas.length;
  let areaSum = 0;
  let valueSum = 0;
  for (let i = 0; i < n; i++) {
    areaSum += outputAreas[i]!;
    valueSum += values[i]!;
  }

  const perFeature = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = areaSum > 0 ? outputAreas[i]! / areaSum : 0;
    const w = valueSum > 0 ? values[i]! / valueSum : 0;
    const d = Math.max(o, w);
    perFeature[i] = d === 0 ? 0 : Math.abs(o - w) / d;
  }

  return { perFeature, summary: summarize(perFeature) };
}

export function summarize(errors: Float64Array): AreaErrorMetrics {
  if (errors.length === 0) return { mean: 0, max: 0, median: 0, p90: 0 };
  let sum = 0;
  let max = 0;
  for (const e of errors) {
    sum += e;
    if (e > max) max = e;
  }
  const sorted = Float64Array.from(errors).sort();
  return {
    mean: sum / errors.length,
    max,
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
  };
}

function quantile(sorted: Float64Array, q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
