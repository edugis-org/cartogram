import type { FlatGeometry } from '../geometry/flat.ts';
import { ringRange } from '../geometry/flat.ts';

/**
 * Self-intersection detection (requirement F19).
 *
 * A warp can fold a boundary over itself, which produces a polygon that is still
 * "valid GeoJSON" syntactically but is nonsense geometrically: renderers fill it with
 * holes and knots, and area is no longer well defined. The force method's fold check
 * only compares ring orientation before and after, which catches a ring turning inside
 * out entirely but not a local fold that leaves the overall winding intact.
 *
 * Segments are bucketed into a uniform grid by bounding box, so only nearby pairs are
 * compared. Consecutive segments share an endpoint by construction and are skipped.
 */
export function selfIntersections(g: FlatGeometry, limit = 1000): number {
  let count = 0;
  for (let r = 0; r < g.ringCount && count < limit; r++) {
    count += ringSelfIntersections(g, r, limit - count);
  }
  return count;
}

function ringSelfIntersections(g: FlatGeometry, ring: number, limit: number): number {
  const [start, end] = ringRange(g, ring);
  const n = end - start;
  if (n < 4) return 0;

  // One bucket per segment on average: fine for boundaries, which are locally sparse.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let v = start; v < end; v++) {
    const x = g.coords[2 * v]!;
    const y = g.coords[2 * v + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cols = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(n))));
  const cw = Math.max((maxX - minX) / cols, 1e-12);
  const ch = Math.max((maxY - minY) / cols, 1e-12);

  const buckets = new Map<number, number[]>();
  const cellOf = (x: number, y: number): number => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cw)));
    const r = Math.min(cols - 1, Math.max(0, Math.floor((y - minY) / ch)));
    return r * cols + c;
  };

  let count = 0;
  for (let i = 0; i < n && count < limit; i++) {
    const a = start + i;
    const b = start + ((i + 1) % n);
    const ax = g.coords[2 * a]!;
    const ay = g.coords[2 * a + 1]!;
    const bx = g.coords[2 * b]!;
    const by = g.coords[2 * b + 1]!;

    // Cells spanned by this segment's bounding box.
    const c0 = Math.min(cols - 1, Math.max(0, Math.floor((Math.min(ax, bx) - minX) / cw)));
    const c1 = Math.min(cols - 1, Math.max(0, Math.floor((Math.max(ax, bx) - minX) / cw)));
    const r0 = Math.min(cols - 1, Math.max(0, Math.floor((Math.min(ay, by) - minY) / ch)));
    const r1 = Math.min(cols - 1, Math.max(0, Math.floor((Math.max(ay, by) - minY) / ch)));

    const seen = new Set<number>();
    for (let r = r0; r <= r1 && count < limit; r++) {
      for (let c = c0; c <= c1 && count < limit; c++) {
        const key = r * cols + c;
        const bucket = buckets.get(key);
        if (bucket) {
          for (const j of bucket) {
            if (seen.has(j)) continue;
            seen.add(j);
            // Adjacent segments legitimately touch at their shared endpoint.
            if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
            const p = start + j;
            const q = start + ((j + 1) % n);
            if (
              segmentsCross(
                ax, ay, bx, by,
                g.coords[2 * p]!, g.coords[2 * p + 1]!,
                g.coords[2 * q]!, g.coords[2 * q + 1]!,
              )
            ) {
              count++;
            }
          }
        }
        let list = buckets.get(key);
        if (!list) {
          list = [];
          buckets.set(key, list);
        }
        list.push(i);
      }
    }
    void cellOf;
  }
  return count;
}

/** Proper crossing test: shared endpoints and collinear touching do not count. */
function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}
