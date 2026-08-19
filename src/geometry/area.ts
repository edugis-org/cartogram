import type { FlatGeometry } from './flat.ts';
import { ringRange } from './flat.ts';

/**
 * Signed area of one ring by the shoelace formula, in the plane.
 * Positive = counter-clockwise. Holes in valid GeoJSON are clockwise, so summing
 * signed ring areas over a polygon subtracts holes automatically.
 */
export function ringSignedArea(g: FlatGeometry, r: number): number {
  const [s, e] = ringRange(g, r);
  const n = e - s;
  if (n < 3) return 0;
  // Shift to the ring's first vertex before summing. Projected coordinates are of
  // order 1e7 metres while a ring's area contributions are far smaller, so the raw
  // shoelace sum loses most of its significant digits to cancellation. Translating
  // to a local origin is exact (subtraction of nearby floats) and recovers them:
  // without it, area errors on world-scale data are ~1e-9 instead of ~1e-16.
  const ox = g.coords[2 * s]!;
  const oy = g.coords[2 * s + 1]!;
  let sum = 0;
  // Sum cross products around the closed ring; the last edge wraps to the first vertex.
  let xPrev = g.coords[2 * (e - 1)]! - ox;
  let yPrev = g.coords[2 * (e - 1) + 1]! - oy;
  for (let v = s; v < e; v++) {
    const x = g.coords[2 * v]! - ox;
    const y = g.coords[2 * v + 1]! - oy;
    sum += xPrev * y - x * yPrev;
    xPrev = x;
    yPrev = y;
  }
  return sum / 2;
}

/**
 * Net area of a feature: outer rings minus holes, summed over all its polygons.
 *
 * Uses |sum of signed ring areas| per polygon rather than relying on winding order,
 * because real-world GeoJSON frequently violates RFC 7946's winding rule. Within a
 * polygon, the ring with the largest |area| is taken as the outer ring and the rest
 * are treated as holes.
 */
export function featureArea(g: FlatGeometry, f: number): number {
  let total = 0;
  for (let p = g.featStart[f]!; p < g.featStart[f + 1]!; p++) {
    const r0 = g.polyStart[p]!;
    const r1 = g.polyStart[p + 1]!;
    let outer = 0;
    let holes = 0;
    let maxAbs = -1;
    let maxIdx = r0;
    for (let r = r0; r < r1; r++) {
      const a = Math.abs(ringSignedArea(g, r));
      if (a > maxAbs) {
        maxAbs = a;
        maxIdx = r;
      }
    }
    for (let r = r0; r < r1; r++) {
      const a = Math.abs(ringSignedArea(g, r));
      if (r === maxIdx) outer += a;
      else holes += a;
    }
    total += Math.max(0, outer - holes);
  }
  return total;
}

/** Net area of a single polygon (outer ring minus its holes). */
export function polygonArea(g: FlatGeometry, p: number): number {
  const r0 = g.polyStart[p]!;
  const r1 = g.polyStart[p + 1]!;
  let maxAbs = -1;
  let maxIdx = r0;
  for (let r = r0; r < r1; r++) {
    const a = Math.abs(ringSignedArea(g, r));
    if (a > maxAbs) {
      maxAbs = a;
      maxIdx = r;
    }
  }
  let outer = 0;
  let holes = 0;
  for (let r = r0; r < r1; r++) {
    const a = Math.abs(ringSignedArea(g, r));
    if (r === maxIdx) outer += a;
    else holes += a;
  }
  return Math.max(0, outer - holes);
}

/** Area-weighted centroid of a single polygon, holes subtracted. */
export function polygonCentroid(g: FlatGeometry, p: number): [number, number] {
  const r0 = g.polyStart[p]!;
  const r1 = g.polyStart[p + 1]!;
  let maxAbs = -1;
  let maxIdx = r0;
  for (let r = r0; r < r1; r++) {
    const a = Math.abs(ringSignedArea(g, r));
    if (a > maxAbs) {
      maxAbs = a;
      maxIdx = r;
    }
  }
  let cx = 0;
  let cy = 0;
  let aSum = 0;
  for (let r = r0; r < r1; r++) {
    const [s, e] = ringRange(g, r);
    const ox = g.coords[2 * s]!;
    const oy = g.coords[2 * s + 1]!;
    let a2 = 0;
    let rx = 0;
    let ry = 0;
    let xPrev = g.coords[2 * (e - 1)]! - ox;
    let yPrev = g.coords[2 * (e - 1) + 1]! - oy;
    for (let v = s; v < e; v++) {
      const x = g.coords[2 * v]! - ox;
      const y = g.coords[2 * v + 1]! - oy;
      const cross = xPrev * y - x * yPrev;
      a2 += cross;
      rx += (xPrev + x) * cross;
      ry += (yPrev + y) * cross;
      xPrev = x;
      yPrev = y;
    }
    if (a2 === 0) continue;
    const w = (r === maxIdx ? 1 : -1) * Math.abs(a2 / 2);
    cx += (rx / (3 * a2) + ox) * w;
    cy += (ry / (3 * a2) + oy) * w;
    aSum += w;
  }
  if (aSum !== 0 && Number.isFinite(cx / aSum) && Number.isFinite(cy / aSum)) {
    return [cx / aSum, cy / aSum];
  }
  const [s, e] = ringRange(g, r0);
  let sx = 0;
  let sy = 0;
  for (let v = s; v < e; v++) {
    sx += g.coords[2 * v]!;
    sy += g.coords[2 * v + 1]!;
  }
  const n = e - s;
  return n > 0 ? [sx / n, sy / n] : [0, 0];
}

export function allFeatureAreas(g: FlatGeometry): Float64Array {
  const out = new Float64Array(g.featCount);
  for (let f = 0; f < g.featCount; f++) out[f] = featureArea(g, f);
  return out;
}

/**
 * Area-weighted centroid of a feature, holes subtracted, over all its polygons.
 * Falls back to the mean of vertices for degenerate (zero-area) features, which do
 * occur in real data and must not produce NaN.
 */
export function featureCentroid(g: FlatGeometry, f: number): [number, number] {
  let cx = 0;
  let cy = 0;
  let aSum = 0;
  for (let p = g.featStart[f]!; p < g.featStart[f + 1]!; p++) {
    const r0 = g.polyStart[p]!;
    const r1 = g.polyStart[p + 1]!;
    let maxAbs = -1;
    let maxIdx = r0;
    for (let r = r0; r < r1; r++) {
      const a = Math.abs(ringSignedArea(g, r));
      if (a > maxAbs) {
        maxAbs = a;
        maxIdx = r;
      }
    }
    for (let r = r0; r < r1; r++) {
      const [s, e] = ringRange(g, r);
      // Same local-origin shift as ringSignedArea, for the same precision reason.
      const ox = g.coords[2 * s]!;
      const oy = g.coords[2 * s + 1]!;
      let a2 = 0;
      let rx = 0;
      let ry = 0;
      let xPrev = g.coords[2 * (e - 1)]! - ox;
      let yPrev = g.coords[2 * (e - 1) + 1]! - oy;
      for (let v = s; v < e; v++) {
        const x = g.coords[2 * v]! - ox;
        const y = g.coords[2 * v + 1]! - oy;
        const cross = xPrev * y - x * yPrev;
        a2 += cross;
        rx += (xPrev + x) * cross;
        ry += (yPrev + y) * cross;
        xPrev = x;
        yPrev = y;
      }
      if (a2 === 0) continue;
      const area = a2 / 2;
      const sign = r === maxIdx ? 1 : -1; // holes pull the centroid the other way
      const w = sign * Math.abs(area);
      cx += (rx / (3 * a2) + ox) * w;
      cy += (ry / (3 * a2) + oy) * w;
      aSum += w;
    }
  }
  if (aSum !== 0 && Number.isFinite(cx / aSum) && Number.isFinite(cy / aSum)) {
    return [cx / aSum, cy / aSum];
  }
  // Degenerate fallback: mean of the feature's vertices.
  let sx = 0;
  let sy = 0;
  let n = 0;
  const p0 = g.featStart[f]!;
  const p1 = g.featStart[f + 1]!;
  for (let p = p0; p < p1; p++) {
    for (let r = g.polyStart[p]!; r < g.polyStart[p + 1]!; r++) {
      const [s, e] = ringRange(g, r);
      for (let v = s; v < e; v++) {
        sx += g.coords[2 * v]!;
        sy += g.coords[2 * v + 1]!;
        n++;
      }
    }
  }
  return n > 0 ? [sx / n, sy / n] : [0, 0];
}

/** Bounding box [minX, minY, maxX, maxY] of the whole collection. */
export function bbox(g: FlatGeometry): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < g.coords.length; i += 2) {
    const x = g.coords[i]!;
    const y = g.coords[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Scale every coordinate about a point, in place.
 *
 * A similarity transform: relative areas, shapes, compactness, adjacency and
 * self-intersections are all unaffected. Only the map's overall size changes.
 */
export function scaleAbout(g: FlatGeometry, cx: number, cy: number, factor: number): void {
  if (factor === 1) return;
  for (let i = 0; i < g.coords.length; i += 2) {
    g.coords[i] = cx + (g.coords[i]! - cx) * factor;
    g.coords[i + 1] = cy + (g.coords[i + 1]! - cy) * factor;
  }
}

/**
 * Uniform scale plus translation, in place. A similarity transform: relative areas,
 * shapes, compactness, adjacency and self-intersections are all unaffected.
 */
export function similarity(g: FlatGeometry, factor: number, tx: number, ty: number): void {
  for (let i = 0; i < g.coords.length; i += 2) {
    g.coords[i] = g.coords[i]! * factor + tx;
    g.coords[i + 1] = g.coords[i + 1]! * factor + ty;
  }
}

/** Area-weighted mean of the feature centroids: the map's centre of mass. */
export function centreOfMass(g: FlatGeometry, weights: Float64Array): [number, number] {
  let sx = 0;
  let sy = 0;
  let w = 0;
  for (let f = 0; f < g.featCount; f++) {
    const [cx, cy] = featureCentroid(g, f);
    const weight = weights[f] ?? 1;
    sx += cx * weight;
    sy += cy * weight;
    w += weight;
  }
  return w > 0 ? [sx / w, sy / w] : [0, 0];
}
