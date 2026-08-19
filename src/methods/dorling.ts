import type { FlatGeometry } from '../geometry/flat.ts';
import { allFeatureAreas, featureCentroid, polygonArea, polygonCentroid } from '../geometry/area.ts';
import { adjacency } from '../metrics/topology.ts';

export interface DorlingParams {
  /** Circles (Dorling 1996) or squares (Demers). Default 'circle'. */
  shape: 'circle' | 'square';
  /** Maximum relaxation iterations. Default 200. */
  iterations: number;
  /** Pull back towards the region's true position, 0..1. Default 0.15. */
  anchor: number;
  /** Pull adjacent regions back into contact, 0..1. Default 0.3. */
  attraction: number;
  /** Overlap resolution strength, 0..1. Default 1 (resolve fully each step). */
  repulsion: number;
  /** Vertices used to draw each circle. Ignored for squares. Default 64. */
  segments: number;
  /**
   * Total symbol area as a fraction of the map's area. Default 0.3.
   *
   * Circles whose areas sum to the whole map area cannot be packed inside it: the
   * densest possible circle packing fills only 90.7% of the plane, and these circles
   * are additionally pinned near their region's true position, so the achievable
   * density is well below that. Without this factor the relaxation cannot converge and
   * always leaves overlaps: 0.55 left ~90 overlapping pairs on NUTS 2 and 0.4 left a
   * handful on NUTS 3, while 0.3 clears every dataset in data/. Scaling every symbol
   * by the same factor leaves relative areas -- the entire point of the method --
   * exactly intact, and cartographic error is normalized, so it stays zero.
   */
  fill: number;
  onIteration?: ((iteration: number, maxMove: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/** Over-relaxation factor for the separation sweeps. 1 = plain Gauss-Seidel. */
const OVER_RELAX = 1.5;

export const DORLING_DEFAULTS: DorlingParams = {
  shape: 'circle',
  iterations: 200,
  anchor: 0.15,
  attraction: 0.3,
  repulsion: 1,
  segments: 64,
  fill: 0.3,
};

export interface DorlingReport {
  geometry: FlatGeometry;
  targetAreas: Float64Array;
  iterations: number;
  /** Pairs still overlapping when relaxation stopped. Should be 0. */
  overlaps: number;
  /** Separation sweeps needed to clear the overlaps. Cost driver; watch it scale. */
  sweeps: number;
  converged: boolean;
}

/**
 * Dorling (1996) circle cartogram, and the Demers square variant.
 *
 * Every region is replaced by a circle (or square) whose area is exactly proportional
 * to its value, placed at the region's centroid, then relaxed so that nothing overlaps
 * while neighbours stay close and everything stays near where it belongs.
 *
 * This method throws shape away completely and is therefore **opt-in only, never a
 * default** (requirement F20a). What it buys is that areas are exactly right and
 * comparable by eye, which the survey's task study found makes it the best type for
 * "summarize the big picture" questions. Its readability rests entirely on relative
 * position surviving, which is what the orientation metric measures.
 *
 * Three forces, applied in this order each iteration:
 *  1. **Repulsion**, resolving every overlap. This one is non-negotiable: an
 *     overlapping Dorling cartogram misrepresents areas visually.
 *  2. **Attraction** between regions that were adjacent on the real map, pulling them
 *     back into contact so the map does not disintegrate into scattered dots.
 *  3. **Anchoring** to the region's true centroid, which is what stops the whole
 *     arrangement from drifting into an arbitrary packing.
 *
 * Neighbour search uses a uniform grid over the circles, so cost per iteration is
 * linear in feature count rather than quadratic (requirement N1).
 */
export function dorling(
  g: FlatGeometry,
  values: Float64Array,
  params: DorlingParams,
): DorlingReport {
  const n = g.featCount;
  const areas = allFeatureAreas(g);

  let areaSum = 0;
  let valueSum = 0;
  for (let f = 0; f < n; f++) {
    areaSum += areas[f]!;
    valueSum += values[f]!;
  }

  const target = new Float64Array(n);
  const radius = new Float64Array(n);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const homeX = new Float64Array(n);
  const homeY = new Float64Array(n);

  for (let f = 0; f < n; f++) {
    // Anchor the symbol on the feature's largest part, not on the centroid of all of
    // them. France is thirteen polygons scattered from the Caribbean to the Indian
    // Ocean, and their combined centroid lies 269 km from mainland France -- so the
    // circle representing France would be drawn out at sea. A reader looks for the
    // symbol where the country is, which means where most of it is.
    let largest = g.featStart[f]!;
    let largestArea = -1;
    for (let p = g.featStart[f]!; p < g.featStart[f + 1]!; p++) {
      const a = polygonArea(g, p);
      if (a > largestArea) {
        largestArea = a;
        largest = p;
      }
    }
    const [cx, cy] = largestArea > 0 ? polygonCentroid(g, largest) : featureCentroid(g, f);
    x[f] = cx;
    y[f] = cy;
    homeX[f] = cx;
    homeY[f] = cy;
    // Squares are separated by their circumcircles, which are pi/2 larger in area
    // than the square itself, so the same `fill` would pack them half again as
    // tightly as circles and never clear.
    const fill = params.shape === 'circle' ? params.fill : (params.fill * 2) / Math.PI;
    target[f] = valueSum > 0 ? (areaSum * fill * values[f]!) / valueSum : 0;
    radius[f] = params.shape === 'circle'
      ? Math.sqrt(target[f]! / Math.PI)
      : Math.sqrt(target[f]!) / 2; // half-width
  }

  // Adjacency of the *original* map: what the attraction force tries to preserve.
  const neighbours: [number, number][] = Array.from(adjacency(g), (k) => {
    const [i, j] = k.split('|');
    return [Number(i), Number(j)] as [number, number];
  });

  // Collision is always circular. A square lies inside its own circumcircle, so
  // separating circumcircles guarantees the squares are disjoint too. The
  // alternative -- axis-aligned separation along the least-penetrated axis -- was
  // tried and diverges: pairs push each other along alternating axes and the
  // arrangement oscillates apart instead of settling (it destroyed the world map
  // outright). Squares therefore sit up to sqrt(2) further apart than strictly
  // necessary, which is a fair price for an arrangement that always converges.
  const collision = Float64Array.from(radius, (r) =>
    params.shape === 'circle' ? r : r * Math.SQRT2,
  );

  let iterations = 0;
  let converged = false;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);

  for (let it = 0; it < params.iterations; it++) {
    if (params.signal?.aborted) break;
    iterations = it + 1;
    dx.fill(0);
    dy.fill(0);

    repel(x, y, collision, dx, dy, params);

    for (const [i, j] of neighbours) {
      const vx = x[j]! - x[i]!;
      const vy = y[j]! - y[i]!;
      const d = Math.hypot(vx, vy);
      const want = collision[i]! + collision[j]!;
      if (d <= want || d === 0) continue;
      // Adjacent on the real map but no longer touching: pull them back together.
      const pull = ((d - want) / d) * params.attraction * 0.5;
      dx[i]! += vx * pull;
      dy[i]! += vy * pull;
      dx[j]! -= vx * pull;
      dy[j]! -= vy * pull;
    }

    // Anneal the anchor to zero. Early on it is what keeps the arrangement
    // geographic; later it is the thing that prevents the last overlaps from being
    // pushed out, because a symbol cannot simultaneously sit on its home position and
    // get out of its neighbour's way.
    const anchor = params.anchor * (1 - it / params.iterations);

    let maxMove = 0;
    for (let f = 0; f < n; f++) {
      dx[f]! += (homeX[f]! - x[f]!) * anchor;
      dy[f]! += (homeY[f]! - y[f]!) * anchor;

      // Clamp the step to the symbol's own size. Repulsion is accumulated over every
      // overlapping neighbour before being applied, so a symbol buried under twenty
      // others receives twenty full corrections at once and is flung far away, which
      // creates new overlaps elsewhere and compounds: measured growth was a factor of
      // ~1.5 per iteration until coordinates reached 1e36 and the map was destroyed.
      // One symbol-width per iteration is plenty and cannot run away.
      const move = Math.hypot(dx[f]!, dy[f]!);
      const cap = collision[f]! > 0 ? collision[f]! : Infinity;
      if (move > cap && move > 0) {
        dx[f]! *= cap / move;
        dy[f]! *= cap / move;
      }
      x[f]! += dx[f]!;
      y[f]! += dy[f]!;
      if (Math.min(move, cap) > maxMove) maxMove = Math.min(move, cap);
    }

    params.onIteration?.(iterations, maxMove);
    // Converged once nothing moves more than a thousandth of a typical radius.
    if (maxMove < median(collision) * 1e-3) {
      converged = true;
      break;
    }
  }

  // Overlap resolution is the one hard guarantee -- an overlapping Dorling cartogram
  // misrepresents the very areas it exists to show -- so finish on repulsion alone,
  // with no anchor to fight it. This phase applies each correction immediately
  // (Gauss-Seidel) rather than accumulating a whole pass first: with hundreds of
  // simultaneous contacts the accumulate-then-apply form converges far too slowly,
  // and left ~1000 overlaps on NUTS 3.
  // Run until the overlap count stops falling rather than for a fixed number of
  // sweeps: dense datasets (NUTS 3 has 1333 symbols) need far more sweeps than sparse
  // ones, and a fixed cap silently leaves hundreds of overlaps on exactly the maps
  // where overlaps are hardest to see.
  // Sweep until nothing meaningfully overlaps. The stopping test is the deepest
  // penetration, not the number of overlapping pairs: the count plateaus while the
  // arrangement is still improving, so stopping on it quits early (it left ~400
  // overlaps on NUTS 3), while running to a zero count never terminates on dense data
  // and burned the full 1000-sweep cap on every dataset larger than a few hundred
  // symbols. Depth falls monotonically and is what actually matters visually.
  // Matched to the epsilon `countOverlaps` uses, so "converged" and "no overlaps"
  // mean the same thing. A looser depth tolerance leaves sub-visible penetrations that
  // still count as overlaps, which turns the method's one hard guarantee into a
  // near-miss.
  const tolerance = median(collision) * 1e-7;
  let sweeps = 0;
  for (let extra = 0; extra < 400; extra++) {
    sweeps++;
    if (separate(x, y, collision) <= tolerance) break;
  }
  const overlaps = countOverlaps(x, y, collision, params);

  return {
    geometry: build(g, x, y, radius, params),
    targetAreas: target,
    iterations,
    overlaps,
    sweeps,
    converged,
  };
}

/** Push every overlapping pair apart, found through a uniform grid. */
function repel(
  x: Float64Array,
  y: Float64Array,
  radius: Float64Array,
  dx: Float64Array,
  dy: Float64Array,
  params: DorlingParams,
): void {
  const n = x.length;
  const cell = Math.max(2 * maxOf(radius), 1e-9);
  const index = new Map<string, number[]>();
  for (let f = 0; f < n; f++) {
    const key = `${Math.floor(x[f]! / cell)},${Math.floor(y[f]! / cell)}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(f);
    else index.set(key, [f]);
  }

  for (let i = 0; i < n; i++) {
    const cx = Math.floor(x[i]! / cell);
    const cy = Math.floor(y[i]! / cell);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = index.get(`${cx + ox},${cy + oy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const vx = x[j]! - x[i]!;
          const vy = y[j]! - y[i]!;

          const d2 = vx * vx + vy * vy;
          const want = radius[i]! + radius[j]!;
          if (d2 >= want * want) continue;
          const d = Math.sqrt(d2);
          if (d === 0) {
            // Coincident centroids (identical geometry, or a degenerate feature):
            // separate them deterministically rather than dividing by zero.
            dx[i]! -= want * 0.25;
            dx[j]! += want * 0.25;
            continue;
          }
          const push = ((want - d) / d) * 0.5 * params.repulsion;
          dx[i]! -= vx * push;
          dy[i]! -= vy * push;
          dx[j]! += vx * push;
          dy[j]! += vy * push;
        }
      }
    }
  }
}

/**
 * Build a uniform grid over the symbols. Counting sort into typed arrays: the
 * string-keyed Map this replaced dominated the runtime once the separation phase ran
 * to convergence (12.5 s on NUTS 3).
 */
interface Grid {
  cols: number;
  rows: number;
  minX: number;
  minY: number;
  cw: number;
  ch: number;
  start: Uint32Array;
  order: Uint32Array;
}

function buildGrid(x: Float64Array, y: Float64Array, cell: number): Grid {
  const n = x.length;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i]! < minX) minX = x[i]!;
    if (x[i]! > maxX) maxX = x[i]!;
    if (y[i]! < minY) minY = y[i]!;
    if (y[i]! > maxY) maxY = y[i]!;
  }
  const cols = Math.max(1, Math.min(1024, Math.ceil((maxX - minX) / cell) + 1));
  const rows = Math.max(1, Math.min(1024, Math.ceil((maxY - minY) / cell) + 1));
  const cw = (maxX - minX) / cols || 1;
  const ch = (maxY - minY) / rows || 1;

  const start = new Uint32Array(cols * rows + 1);
  const cellOf = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const col = Math.min(cols - 1, Math.max(0, Math.floor((x[i]! - minX) / cw)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((y[i]! - minY) / ch)));
    cellOf[i] = row * cols + col;
    start[cellOf[i]! + 1]!++;
  }
  for (let c = 0; c < cols * rows; c++) start[c + 1]! += start[c]!;
  const order = new Uint32Array(n);
  const cursor = start.slice(0, cols * rows);
  for (let i = 0; i < n; i++) order[cursor[cellOf[i]!]!++] = i;

  return { cols, rows, minX, minY, cw, ch, start, order };
}

/**
 * One Gauss-Seidel separation sweep, applying each correction as it is found and
 * returning how many overlapping pairs it saw. Accumulating a whole pass first
 * converges far too slowly here: with hundreds of simultaneous contacts it left
 * ~1000 overlaps on NUTS 3 that never cleared.
 */
function separate(x: Float64Array, y: Float64Array, radius: Float64Array): number {
  const n = x.length;
  // Size cells by the *median* symbol, not the largest. Symbol sizes span orders of
  // magnitude on real data (one metropolitan region dwarfs a rural one), and sizing
  // the grid for the largest collapses it to a handful of cells holding everything,
  // which makes each sweep quadratic.
  const med = median(radius);
  const cell = Math.max(2 * med, 1e-9);
  const g = buildGrid(x, y, cell);
  // Guard the cell size. When the symbols are nearly collinear -- which happens on
  // real input, e.g. two polar regions after an equal-area projection squashes them --
  // one dimension of the extent collapses and the cell size with it. The search radius
  // is measured in cells, so it then explodes and the sweep loops over astronomically
  // many cells, almost all out of range: the run simply never returns.
  const span = Math.max(Math.min(g.cw, g.ch), 1e-12);

  // Symbols far larger than the median are handled separately. Otherwise every symbol
  // has to search a neighbourhood wide enough to reach the biggest one, which makes
  // the sweep cost scale with the largest symbol rather than with local density: the
  // measured effect was 0.43 ms per feature at 100 features against 1.61 at 1600.
  const big: number[] = [];
  const bigCut = Math.max(4 * med, 1e-12);
  for (let i = 0; i < n; i++) if (radius[i]! > bigCut) big.push(i);

  let deepest = 0;
  const push = (i: number, j: number): void => {
    const ri = radius[i]!;
    const rj = radius[j]!;
    // A zero-area symbol is invisible and cannot meaningfully overlap anything.
    // Left in, such symbols are shoved around forever by their neighbours and the
    // sweeps never converge, which is exactly what happened with `missing: 'zero'`.
    if (ri <= 0 || rj <= 0) return;
    const vx = x[j]! - x[i]!;
    const vy = y[j]! - y[i]!;
    const want = ri + rj;
    const d = Math.hypot(vx, vy);
    if (d >= want) return;
    const penetration = want - d;
    if (penetration > deepest) deepest = penetration;
    if (d === 0) {
      // Coincident symbols: separate deterministically rather than dividing by zero.
      x[i]! -= want / 2;
      x[j]! += want / 2;
      return;
    }
    // Over-relaxation: correct by a little more than half the penetration each. Plain
    // Gauss-Seidel converges slowly once symbols are densely packed, because each
    // correction is immediately partly undone by the next contact.
    const shift = (OVER_RELAX * penetration) / d / 2;
    x[i]! -= vx * shift;
    y[i]! -= vy * shift;
    x[j]! += vx * shift;
    y[j]! += vy * shift;
  };

  for (let i = 0; i < n; i++) {
    if (radius[i]! <= 0) continue;
    // Never search beyond the grid: past that, every additional ring is empty.
    const reach = Math.min(
      Math.max(g.cols, g.rows),
      Math.max(1, Math.ceil((radius[i]! + bigCut) / span)),
    );
    const col = Math.min(g.cols - 1, Math.max(0, Math.floor((x[i]! - g.minX) / g.cw)));
    const row = Math.min(g.rows - 1, Math.max(0, Math.floor((y[i]! - g.minY) / g.ch)));
    for (let dr = -reach; dr <= reach; dr++) {
      const r = row + dr;
      if (r < 0 || r >= g.rows) continue;
      for (let dc = -reach; dc <= reach; dc++) {
        const c = col + dc;
        if (c < 0 || c >= g.cols) continue;
        const cellIndex = r * g.cols + c;
        for (let k = g.start[cellIndex]!; k < g.start[cellIndex + 1]!; k++) {
          const j = g.order[k]!;
          if (j <= i) continue;
          push(i, j);
        }
      }
    }
  }

  // Large symbols against everything, directly. There are few of them by definition.
  for (const b of big) {
    for (let i = 0; i < n; i++) if (i !== b) push(Math.min(i, b), Math.max(i, b));
  }

  return deepest;
}

function countOverlaps(
  x: Float64Array,
  y: Float64Array,
  radius: Float64Array,
  params: DorlingParams,
): number {
  const n = x.length;
  const cell = Math.max(2 * maxOf(radius), 1e-9);
  const index = new Map<string, number[]>();
  for (let f = 0; f < n; f++) {
    const key = `${Math.floor(x[f]! / cell)},${Math.floor(y[f]! / cell)}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(f);
    else index.set(key, [f]);
  }
  const tolerance = 1e-6;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(x[i]! / cell);
    const cy = Math.floor(y[i]! / cell);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (const j of index.get(`${cx + ox},${cy + oy}`) ?? []) {
          if (j <= i) continue;
          const want = (radius[i]! + radius[j]!) * (1 - tolerance);
          if (Math.hypot(x[j]! - x[i]!, y[j]! - y[i]!) < want) count++;
        }
      }
    }
  }
  return count;
}

/**
 * Emit one polygon per feature. The radius is solved so the *polygon's* area equals
 * the target exactly: a 64-gon inscribed in a circle of radius r is about 0.16%
 * smaller than the circle, which would otherwise show up as a systematic area error
 * in a method whose whole selling point is exact areas.
 */
function build(
  g: FlatGeometry,
  x: Float64Array,
  y: Float64Array,
  radius: Float64Array,
  params: DorlingParams,
): FlatGeometry {
  const n = g.featCount;
  const k = params.shape === 'circle' ? Math.max(8, params.segments) : 4;
  const coords = new Float64Array(n * k * 2);
  const ringStart = new Uint32Array(n + 1);
  const polyStart = new Uint32Array(n + 1);
  const featStart = new Uint32Array(n + 1);

  for (let f = 0; f < n; f++) {
    ringStart[f] = f * k;
    polyStart[f] = f;
    featStart[f] = f;
    const area = params.shape === 'circle'
      ? Math.PI * radius[f]! * radius[f]!
      : 4 * radius[f]! * radius[f]!;

    if (params.shape === 'square') {
      const h = radius[f]!;
      const pts = [[-h, -h], [h, -h], [h, h], [-h, h]];
      for (let i = 0; i < 4; i++) {
        coords[2 * (f * k + i)] = x[f]! + pts[i]![0]!;
        coords[2 * (f * k + i) + 1] = y[f]! + pts[i]![1]!;
      }
      continue;
    }

    // Area of a regular k-gon with circumradius R is (k/2) R^2 sin(2pi/k).
    const R = area > 0 ? Math.sqrt((2 * area) / (k * Math.sin((2 * Math.PI) / k))) : 0;
    for (let i = 0; i < k; i++) {
      const t = (2 * Math.PI * i) / k;
      coords[2 * (f * k + i)] = x[f]! + R * Math.cos(t);
      coords[2 * (f * k + i) + 1] = y[f]! + R * Math.sin(t);
    }
  }
  ringStart[n] = n * k;
  polyStart[n] = n;
  featStart[n] = n;

  return {
    coords,
    ringStart,
    ringCount: n,
    polyStart,
    polyCount: n,
    featStart,
    featCount: n,
    // Every feature becomes a single simple polygon, whatever it was before.
    featType: new Array(n).fill('Polygon'),
  };
}

function maxOf(v: Float64Array): number {
  let m = 0;
  for (const x of v) if (x > m) m = x;
  return m;
}

function median(v: Float64Array): number {
  if (v.length === 0) return 0;
  const s = Float64Array.from(v).sort();
  return s[s.length >> 1]!;
}
