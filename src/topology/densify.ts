import type { FlatGeometry } from '../geometry/flat.ts';
import { ringRange } from '../geometry/flat.ts';
import { bbox } from '../geometry/area.ts';

/**
 * Topology-preserving line densification (Duncan & Gastner, 2025, arXiv:2511.08121).
 *
 * A boundary is a polyline with finitely many vertices. A warp that only moves the
 * existing vertices therefore replaces each edge with a straight chord of the curve
 * the warp actually describes: a long straight edge, moved at its endpoints only,
 * cuts through whatever is beside it. The result is overlapping or disconnected
 * regions -- a topology break that no amount of parameter tuning fixes, because the
 * information simply is not in the geometry.
 *
 * The fix is to insert vertices before warping, so every edge is short relative to
 * the scale on which the warp varies.
 *
 * The part that has to be right: an edge shared by two features must be subdivided
 * into *bit-identical* points from both sides, or the shared border comes apart at
 * the new vertices -- exactly the failure densification is meant to prevent. Both
 * sides traverse the edge in opposite directions, and `a + (b - a) * t` does not
 * equal `b + (a - b) * (1 - t)` in floating point. So each edge is canonicalized to a
 * fixed endpoint order before its points are computed, and the result is reversed if
 * the ring runs the other way.
 */
export interface DensifyResult {
  geometry: FlatGeometry;
  /** Vertices inserted. Zero means every edge was already short enough. */
  inserted: number;
  /** The spacing actually used. */
  spacing: number;
}

/** Order two endpoints deterministically, independent of traversal direction. */
function canonical(ax: number, ay: number, bx: number, by: number): boolean {
  return ax < bx || (ax === bx && ay <= by);
}

/**
 * Choose a spacing from the geometry itself: fine enough that the smallest regions
 * keep their shape, coarse enough not to explode the vertex count. The cap is what
 * stops a dataset with one sliver region from densifying the whole map to death.
 */
export function autoSpacing(g: FlatGeometry): number {
  const [minX, minY, maxX, maxY] = bbox(g);
  const diagonal = Math.hypot(maxX - minX, maxY - minY);
  // A few hundred steps across the map is the scale on which a cartogram warp varies.
  return diagonal / 400;
}

export function densify(g: FlatGeometry, spacing: number, maxGrowth = 6): DensifyResult {
  if (!(spacing > 0)) return { geometry: g, inserted: 0, spacing };

  const originalVertices = g.coords.length >>> 1;
  // Floor the budget: a small input (a handful of long edges) must still be allowed
  // to densify properly, and a growth factor alone would coarsen it back out.
  const budget = Math.max(originalVertices * maxGrowth, 4096);

  // Pass 1: count, so the output buffers are allocated once.
  let total = 0;
  for (let r = 0; r < g.ringCount; r++) {
    const [s, e] = ringRange(g, r);
    for (let v = s; v < e; v++) {
      const w = v + 1 < e ? v + 1 : s;
      total += 1 + subdivisions(g, v, w, spacing);
    }
  }
  if (total === originalVertices) return { geometry: g, inserted: 0, spacing };
  if (total > budget) {
    // Coarsen rather than refuse: a usable approximation beats an out-of-memory error.
    return densify(g, spacing * (total / budget), maxGrowth);
  }

  const coords = new Float64Array(total * 2);
  const ringStart = new Uint32Array(g.ringCount + 1);
  let out = 0;

  for (let r = 0; r < g.ringCount; r++) {
    ringStart[r] = out;
    const [s, e] = ringRange(g, r);
    for (let v = s; v < e; v++) {
      const w = v + 1 < e ? v + 1 : s;
      const ax = g.coords[2 * v]!;
      const ay = g.coords[2 * v + 1]!;
      const bx = g.coords[2 * w]!;
      const by = g.coords[2 * w + 1]!;

      coords[2 * out] = ax;
      coords[2 * out + 1] = ay;
      out++;

      const k = subdivisions(g, v, w, spacing);
      if (k === 0) continue;

      // Compute the inserted points from the canonical endpoint order, then emit
      // them in traversal order. Both sides of a shared edge produce identical bits.
      const forward = canonical(ax, ay, bx, by);
      const px = forward ? ax : bx;
      const py = forward ? ay : by;
      const qx = forward ? bx : ax;
      const qy = forward ? by : ay;
      // Always evaluate at t = i/(k+1) from the canonical start, and walk i backwards
      // when the ring runs the other way. Using t and 1-t on the two sides would give
      // mathematically equal but bit-different points, which is precisely how a shared
      // border comes apart at the vertices densification just inserted.
      for (let j = 1; j <= k; j++) {
        const i = forward ? j : k + 1 - j;
        const t = i / (k + 1);
        coords[2 * out] = px + (qx - px) * t;
        coords[2 * out + 1] = py + (qy - py) * t;
        out++;
      }
    }
  }
  ringStart[g.ringCount] = out;

  return {
    geometry: { ...g, coords, ringStart },
    inserted: out - originalVertices,
    spacing,
  };
}

function subdivisions(g: FlatGeometry, v: number, w: number, spacing: number): number {
  const dx = g.coords[2 * w]! - g.coords[2 * v]!;
  const dy = g.coords[2 * w + 1]! - g.coords[2 * v + 1]!;
  const len = Math.hypot(dx, dy);
  return len <= spacing ? 0 : Math.ceil(len / spacing) - 1;
}
