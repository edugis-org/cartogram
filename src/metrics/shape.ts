import type { FlatGeometry } from '../geometry/flat.ts';
import { ringRange } from '../geometry/flat.ts';
import { featureArea } from '../geometry/area.ts';

/** Total perimeter of a feature, all rings including holes. */
export function featurePerimeter(g: FlatGeometry, f: number): number {
  let p = 0;
  for (let poly = g.featStart[f]!; poly < g.featStart[f + 1]!; poly++) {
    for (let r = g.polyStart[poly]!; r < g.polyStart[poly + 1]!; r++) {
      const [s, e] = ringRange(g, r);
      let xPrev = g.coords[2 * (e - 1)]!;
      let yPrev = g.coords[2 * (e - 1) + 1]!;
      for (let v = s; v < e; v++) {
        const x = g.coords[2 * v]!;
        const y = g.coords[2 * v + 1]!;
        p += Math.hypot(x - xPrev, y - yPrev);
        xPrev = x;
        yPrev = y;
      }
    }
  }
  return p;
}

/**
 * Polsby-Popper compactness: 4*pi*A / P^2. Exactly 1 for a circle, lower the more
 * ragged the outline. Scale-invariant, so it can be compared before and after a
 * cartogram transform.
 */
export function compactness(g: FlatGeometry, f: number): number {
  const a = featureArea(g, f);
  const p = featurePerimeter(g, f);
  if (p <= 0) return 0;
  return (4 * Math.PI * a) / (p * p);
}

export interface ShapePreservation {
  /** compactness_out - compactness_in, per feature. Positive = rounder = blobbier. */
  compactnessDrift: Float64Array;
  meanCompactnessDrift: number;
  maxCompactnessDrift: number;
  /** Fraction of features that got rounder. ~0.5 is neutral; near 1.0 is blobbing. */
  fractionRounder: number;
  /**
   * Boundary-detail retention: P_out / (P_in * sqrt(A_out / A_in)), per feature.
   * 1 = detail fully retained; well below 1 = the outline has been smoothed away.
   */
  detailRetention: Float64Array;
  meanDetailRetention: number;
}

/**
 * The anti-blob guard (requirement F20a/F20b).
 *
 * Force-based cartogram methods push every vertex along the radius from its region's
 * centroid, which relaxes regions towards circles: areas come out right while the map
 * turns into a field of rounded blobs. Area error alone cannot detect that. These two
 * measures can, and they are cheap enough to run on every result.
 */
export function shapePreservation(before: FlatGeometry, after: FlatGeometry): ShapePreservation {
  const n = before.featCount;
  const drift = new Float64Array(n);
  const retention = new Float64Array(n);
  let driftSum = 0;
  let driftMax = -Infinity;
  let rounder = 0;
  let retSum = 0;
  let retCount = 0;

  for (let f = 0; f < n; f++) {
    const cIn = compactness(before, f);
    const cOut = compactness(after, f);
    const d = cOut - cIn;
    drift[f] = d;
    driftSum += d;
    if (d > driftMax) driftMax = d;
    if (d > 0) rounder++;

    const aIn = featureArea(before, f);
    const aOut = featureArea(after, f);
    const pIn = featurePerimeter(before, f);
    const pOut = featurePerimeter(after, f);
    if (aIn > 0 && pIn > 0 && aOut > 0) {
      const expected = pIn * Math.sqrt(aOut / aIn); // perimeter of a pure rescale
      retention[f] = pOut / expected;
      retSum += retention[f]!;
      retCount++;
    } else {
      retention[f] = 1;
    }
  }

  return {
    compactnessDrift: drift,
    meanCompactnessDrift: n > 0 ? driftSum / n : 0,
    maxCompactnessDrift: n > 0 ? driftMax : 0,
    fractionRounder: n > 0 ? rounder / n : 0,
    detailRetention: retention,
    meanDetailRetention: retCount > 0 ? retSum / retCount : 1,
  };
}
