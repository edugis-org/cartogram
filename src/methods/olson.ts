import type { FlatGeometry } from '../geometry/flat.ts';
import { allFeatureAreas, featureCentroid } from '../geometry/area.ts';

export interface OlsonParams {
  fit: 'total' | 'max';
}

/**
 * Olson (1976), non-contiguous area cartogram.
 *
 * Each feature is scaled about its own area-weighted centroid by
 * sqrt(targetArea / actualArea). Shapes are preserved *exactly* (it is a pure
 * similarity transform per feature: no rounding, no smoothing, no blobbing) and
 * areas come out exact to floating-point precision. What is lost is contiguity:
 * regions shrink away from their neighbours, leaving white space.
 *
 * O(V), single pass, no iteration, no parameters to tune. That makes it both a
 * genuinely useful output mode and the correctness oracle for everything else in
 * this library: if Olson's area error is not ~1e-16, the areas, the projection or
 * the value handling are wrong, and no other method can be trusted.
 *
 * Mutates `g` in place and returns the per-feature target areas.
 */
export function olson(g: FlatGeometry, values: Float64Array, params: OlsonParams): Float64Array {
  const areas = allFeatureAreas(g);
  const n = g.featCount;

  let areaSum = 0;
  let valueSum = 0;
  for (let f = 0; f < n; f++) {
    areaSum += areas[f]!;
    valueSum += values[f]!;
  }

  const target = new Float64Array(n);
  if (valueSum <= 0 || areaSum <= 0) return target;

  for (let f = 0; f < n; f++) target[f] = (areaSum * values[f]!) / valueSum;

  // Global multiplier. 'total' keeps the map's total area; 'max' keeps the largest
  // region at its original size, which is Olson's own practice and avoids any region
  // growing beyond its original footprint.
  let global = 1;
  if (params.fit === 'max') {
    let maxScale = 0;
    for (let f = 0; f < n; f++) {
      if (areas[f]! > 0) maxScale = Math.max(maxScale, Math.sqrt(target[f]! / areas[f]!));
    }
    if (maxScale > 0) global = 1 / maxScale;
  }

  for (let f = 0; f < n; f++) {
    const a = areas[f]!;
    if (a <= 0) continue; // degenerate feature: nothing sensible to scale
    const s = global * Math.sqrt(target[f]! / a);
    target[f] = target[f]! * global * global;
    if (s === 1) continue;

    const [cx, cy] = featureCentroid(g, f);
    const p0 = g.featStart[f]!;
    const p1 = g.featStart[f + 1]!;
    const vStart = g.ringStart[g.polyStart[p0]!]!;
    const vEnd = g.ringStart[g.polyStart[p1]!]!;
    // A feature's polygons, rings and vertices are contiguous in the flat buffers,
    // so the whole feature is one tight loop over a slice of the coordinate array.
    for (let v = vStart; v < vEnd; v++) {
      g.coords[2 * v] = cx + (g.coords[2 * v]! - cx) * s;
      g.coords[2 * v + 1] = cy + (g.coords[2 * v + 1]! - cy) * s;
    }
  }

  return target;
}
