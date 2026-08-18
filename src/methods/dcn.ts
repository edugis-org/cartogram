import type { FlatGeometry } from '../geometry/flat.ts';
import { ringRange } from '../geometry/flat.ts';
import { allFeatureAreas, featureCentroid, ringSignedArea } from '../geometry/area.ts';
import { buildVertexIndex, scatter, type VertexIndex } from '../topology/vertices.ts';

export interface DcnParams {
  /** Maximum iterations. Default 60. */
  iterations: number;
  /** Stop once the mean cartographic error drops to this. Default 0.02. */
  targetError: number;
  /**
   * Influence radius as a multiple of a region's radius. Smaller is faster and more
   * local; larger is smoother and slower. Default 5.
   */
  cutoff: number;
  /** Step size multiplier applied to every displacement. Default 1. */
  damping: number;
  /**
   * Smoothing passes over the displacement field, along boundaries. Default 2.
   *
   * Each region pushes vertices radially away from its own centroid, so a growing
   * region's boundary relaxes into circular arcs: a coastline that ran straight comes
   * out bowed, and pinches where two growing regions meet. Smoothing the *displacement*
   * (not the geometry) makes neighbouring vertices move together, so a boundary is
   * carried along roughly rigidly and keeps its straights and its corners. Smoothing
   * the geometry instead would erase detail, which is the opposite of what is wanted.
   */
  smoothing: number;
  /**
   * Anti-blob strength, 0..1 (requirement F20a). Default 0.25.
   *
   * The force field is smooth, so it flattens boundary detail: repeated iterations
   * relax every region towards a circle. This term measures the high-frequency part
   * of the outline that the force field removed and puts it back, at the region's new
   * scale. 0 disables it and reproduces textbook DCN behaviour, blobbing included.
   */
  shapeAnchor: number;
  onIteration?: ((iteration: number, meanError: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export const DCN_DEFAULTS: DcnParams = {
  iterations: 60,
  targetError: 0.02,
  cutoff: 5,
  damping: 1,
  smoothing: 2,
  // 0.25 measured best across the datasets in data/: it removes the fold retries on
  // NUTS 2 entirely and halves the area error there. Higher values fight the force
  // field and fold; 0 leaves boundaries noticeably rougher.
  shapeAnchor: 0.25,
};

export interface DcnReport {
  iterations: number;
  meanError: number;
  targetAreas: Float64Array;
  /** Times a step was halved because it would have folded a ring. */
  foldRetries: number;
  converged: boolean;
}

/**
 * Dougenik, Chrisman & Niemeyer (1985) contiguous cartogram, hardened along the lines
 * of Sun (2020): local support, fold detection, and an explicit anti-blob term.
 *
 * Each region is a disc that wants to grow or shrink. Every boundary vertex is pushed
 * radially away from (or towards) each nearby region's centroid, by an amount that
 * depends on how wrong that region's area currently is. Iterate; areas converge.
 *
 * Three deliberate departures from the 1985 paper:
 *
 * 1. **Local support with a tapered kernel.** The original sums over *every* region
 *    and normalizes by the total weight, which is O(n) per vertex -- quadratic overall,
 *    and incompatible with our near-linear requirement. Here each region only reaches
 *    vertices within `cutoff` radii, found through a uniform grid, and its influence
 *    is multiplied by a taper that reaches exactly zero at that distance. The taper is
 *    not cosmetic: with a hard cutoff, a vertex just inside a region's range and its
 *    neighbour just outside get very different displacements, and the boundary tears.
 * 2. **Weight normalization kept, but over the local neighbourhood only.** Dougenik
 *    averages each region's force with weight 1/(1+d); dropping that in favour of plain
 *    superposition was tried and converges far worse, because the displacement then
 *    scales with how many regions happen to overlap a vertex rather than with how wrong
 *    that vertex's own region is. The taper keeps the average continuous as a region
 *    passes out of range, and a vertex no region reaches simply does not move.
 * 3. **Fold detection.** After each step, any ring that reversed orientation means the
 *    step overshot and turned the polygon inside out. The step is halved and retried
 *    rather than emitting self-intersecting garbage (requirement F19).
 *
 * Mutates `g` in place. Returns the per-feature target areas and a convergence report.
 */
export function dcn(g: FlatGeometry, values: Float64Array, params: DcnParams): DcnReport {
  const n = g.featCount;
  const areas0 = allFeatureAreas(g);

  let areaSum = 0;
  let valueSum = 0;
  for (let f = 0; f < n; f++) {
    areaSum += areas0[f]!;
    valueSum += values[f]!;
  }

  const target = new Float64Array(n);
  if (valueSum <= 0 || areaSum <= 0) {
    return { iterations: 0, meanError: 0, targetAreas: target, foldRetries: 0, converged: true };
  }
  for (let f = 0; f < n; f++) target[f] = (areaSum * values[f]!) / valueSum;

  // A contiguous cartogram cannot make a region literally vanish: a zero target drives
  // an unbounded inward force that folds the polygon inside out and takes its
  // neighbours with it. Zero- and near-zero-valued regions are floored to a small
  // share of the mean region area instead. This is a real, deliberate area error on
  // those features, and it is the only way the rest of the map stays intact.
  const floorArea = (areaSum / n) * 1e-3;
  for (let f = 0; f < n; f++) if (target[f]! < floorArea) target[f] = floorArea;

  // Shared borders move as one point, or neighbouring polygons drift apart (F18).
  const vi = buildVertexIndex(g);
  const anchor = params.shapeAnchor > 0 ? captureDetail(g, vi) : null;

  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const radius = new Float64Array(n);
  const desired = new Float64Array(n);
  const dx = new Float64Array(vi.count);
  const dy = new Float64Array(vi.count);
  const limit = new Float64Array(vi.count);
  const wsum = new Float64Array(vi.count);
  const best = new Float64Array(vi.count);
  const backup = new Float64Array(vi.coords.length);
  const guard = ringGuard(g);

  let meanError = errorOf(allFeatureAreas(g), target);
  let foldRetries = 0;
  let iterations = 0;
  let converged = meanError <= params.targetError;
  // Step size adapts across iterations: shrink when a step folds a ring, recover
  // slowly when steps succeed. Carrying it between iterations matters -- a single
  // fold early on otherwise costs the same six halvings on every later iteration.
  let step = params.damping;

  for (let it = 0; it < params.iterations && !converged; it++) {
    if (params.signal?.aborted) break;
    iterations = it + 1;

    const areas = allFeatureAreas(g);
    for (let f = 0; f < n; f++) {
      const [x, y] = featureCentroid(g, f);
      cx[f] = x;
      cy[f] = y;
      radius[f] = Math.sqrt(Math.max(areas[f]!, 0) / Math.PI);
      desired[f] = Math.sqrt(target[f]! / Math.PI);
    }

    dx.fill(0);
    dy.fill(0);
    wsum.fill(0);
    best.fill(0);
    limit.fill(Infinity);
    accumulateForces(vi, params, cx, cy, radius, desired, dx, dy, limit, wsum, best);
    for (let i = 0; i < vi.count; i++) {
      const w = wsum[i]!;
      if (w > 0) {
        dx[i]! /= w;
        dy[i]! /= w;
      }
    }

    // Cap every displacement at a fraction of the smallest feature acting on that
    // vertex. Folding is what happens when a vertex travels further than the local
    // feature is wide, so this prevents folds at the source instead of detecting them
    // afterwards and throwing the whole step away -- which is what stalled convergence
    // on datasets with small regions next to large ones (NUTS 2, world countries).
    for (let i = 0; i < vi.count; i++) {
      const cap = limit[i]!;
      if (!Number.isFinite(cap)) continue;
      const mag = Math.hypot(dx[i]!, dy[i]!);
      if (mag > cap && mag > 0) {
        dx[i]! *= cap / mag;
        dy[i]! *= cap / mag;
      }
    }

    // Locally rigid motion: neighbouring boundary vertices should travel together,
    // otherwise the radial force field bows every straight edge into an arc.
    for (let pass = 0; pass < params.smoothing; pass++) {
      smoothDisplacement(g, vi, dx, dy);
    }

    // Dougenik's force reduction factor: while the map is still badly wrong, the
    // linearized force overestimates how far vertices should travel, so damp by how
    // wrong it currently is. Without this the first iterations wildly overshoot and
    // most of the run is spent undoing them.
    const reduction = 1 / (1 + meanError);
    for (let i = 0; i < vi.count; i++) {
      dx[i]! *= reduction;
      dy[i]! *= reduction;
    }

    // Try the step; halve it while it would fold a ring.
    backup.set(vi.coords);
    let applied = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      for (let i = 0; i < vi.count; i++) {
        vi.coords[2 * i] = backup[2 * i]! + dx[i]! * step;
        vi.coords[2 * i + 1] = backup[2 * i + 1]! + dy[i]! * step;
      }
      scatter(g, vi);
      if (anchor) restoreDetail(g, vi, anchor, areas0, allFeatureAreas(g), params.shapeAnchor);
      if (!folded(g, guard)) {
        applied = true;
        break;
      }
      foldRetries++;
      step /= 2;
    }
    if (!applied) {
      // Every step size folded something. Undo, shrink for next time, and keep going:
      // the geometry moves on later iterations once the force field has relaxed.
      vi.coords.set(backup);
      scatter(g, vi);
      step = Math.max(step / 4, params.damping / 1024);
      continue;
    }
    // Recover the step gradually so one awkward iteration does not cripple the rest.
    step = Math.min(params.damping, step * 1.3);

    meanError = errorOf(allFeatureAreas(g), target);
    params.onIteration?.(iterations, meanError);
    if (meanError <= params.targetError) converged = true;
  }

  return { iterations, meanError, targetAreas: target, foldRetries, converged };
}

/**
 * Scatter each region's force onto the vertices it reaches, using a uniform grid over
 * the vertices. Cost is O(V + sum over regions of the vertices within reach), which is
 * linear in vertex count for a fixed cutoff -- the property requirement N1 asks for.
 */
function accumulateForces(
  vi: VertexIndex,
  params: DcnParams,
  cx: Float64Array,
  cy: Float64Array,
  radius: Float64Array,
  desired: Float64Array,
  dx: Float64Array,
  dy: Float64Array,
  limit: Float64Array,
  wsum: Float64Array,
  best: Float64Array,
): void {
  const n = cx.length;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < vi.count; i++) {
    const x = vi.coords[2 * i]!;
    const y = vi.coords[2 * i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // Cell size ~ the median influence radius keeps the per-region cell sweep small.
  const radii = Float64Array.from(radius, (r, f) => params.cutoff * Math.max(r, desired[f]!));
  const cell = Math.max(median(radii), 1e-9);
  const cols = Math.max(1, Math.min(2048, Math.ceil((maxX - minX) / cell) + 1));
  const rows = Math.max(1, Math.min(2048, Math.ceil((maxY - minY) / cell) + 1));
  const cw = (maxX - minX) / cols || 1;
  const ch = (maxY - minY) / rows || 1;

  // Counting sort of vertices into cells: two passes, no per-cell arrays.
  const counts = new Uint32Array(cols * rows + 1);
  const cellOf = new Uint32Array(vi.count);
  for (let i = 0; i < vi.count; i++) {
    const col = Math.min(cols - 1, Math.max(0, Math.floor((vi.coords[2 * i]! - minX) / cw)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((vi.coords[2 * i + 1]! - minY) / ch)));
    const c = row * cols + col;
    cellOf[i] = c;
    counts[c + 1]!++;
  }
  for (let c = 0; c < cols * rows; c++) counts[c + 1]! += counts[c]!;
  const order = new Uint32Array(vi.count);
  const cursor = counts.slice(0, cols * rows);
  for (let i = 0; i < vi.count; i++) order[cursor[cellOf[i]!]!++] = i;

  for (let f = 0; f < n; f++) {
    const r = radius[f]!;
    const mass = desired[f]! - r;
    if (mass === 0 || r <= 0) continue;
    const reach = radii[f]!;
    const c0 = Math.max(0, Math.floor((cx[f]! - reach - minX) / cw));
    const c1 = Math.min(cols - 1, Math.floor((cx[f]! + reach - minX) / cw));
    const r0 = Math.max(0, Math.floor((cy[f]! - reach - minY) / ch));
    const r1 = Math.min(rows - 1, Math.floor((cy[f]! + reach - minY) / ch));
    const reach2 = reach * reach;

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const c = row * cols + col;
        for (let k = counts[c]!; k < counts[c + 1]!; k++) {
          const i = order[k]!;
          const vx = vi.coords[2 * i]! - cx[f]!;
          const vy = vi.coords[2 * i + 1]! - cy[f]!;
          const d2 = vx * vx + vy * vy;
          if (d2 >= reach2 || d2 === 0) continue;
          const d = Math.sqrt(d2);

          // Dougenik's radial force: full effect inside the disc, 1/d outside.
          const force =
            d > r ? (mass * r) / d : mass * (d2 / (r * r)) * (4 - (3 * d) / r);

          // Taper smoothly to zero at the cutoff so locality does not tear borders.
          const u = d / reach;
          const taper = (1 - u * u) * (1 - u * u);

          // Dougenik's distance weighting, multiplied by the taper so a region
          // leaving the neighbourhood does so continuously.
          const w = taper / (1 + d);
          const s = (force * w) / d;
          dx[i]! += vx * s;
          dy[i]! += vy * s;
          wsum[i]! += w;
          // Step cap reference: the *dominant* region at this vertex, i.e. the one with
          // the largest weight, which is essentially the polygon the vertex belongs to.
          // Taking the minimum over every influencing region instead was tried and
          // throttles the whole map to the size of the smallest region in range, which
          // stalls convergence badly on data with mixed region sizes.
          if (w > best[i]!) {
            best[i] = w;
            limit[i] = 0.5 * Math.min(r, desired[f]!);
          }
        }
      }
    }
  }
}

/**
 * One Laplacian pass over the displacement field, following the boundary polylines.
 *
 * Averaging is done per *unique* vertex over every ring that uses it, so a shared
 * border smooths consistently from both sides and stays welded.
 */
function smoothDisplacement(
  g: FlatGeometry,
  vi: VertexIndex,
  dx: Float64Array,
  dy: Float64Array,
): void {
  const accX = new Float64Array(vi.count);
  const accY = new Float64Array(vi.count);
  const hits = new Uint32Array(vi.count);

  for (let r = 0; r < g.ringCount; r++) {
    const [s, e] = ringRange(g, r);
    for (let v = s; v < e; v++) {
      const prev = v === s ? e - 1 : v - 1;
      const next = v + 1 < e ? v + 1 : s;
      const id = vi.ids[v]!;
      accX[id]! += (dx[vi.ids[prev]!]! + dx[vi.ids[next]!]!) / 2;
      accY[id]! += (dy[vi.ids[prev]!]! + dy[vi.ids[next]!]!) / 2;
      hits[id]!++;
    }
  }

  for (let i = 0; i < vi.count; i++) {
    if (hits[i]! === 0) continue;
    dx[i] = 0.5 * dx[i]! + 0.5 * (accX[i]! / hits[i]!);
    dy[i] = 0.5 * dy[i]! + 0.5 * (accY[i]! / hits[i]!);
  }
}

/** Per-ring high-frequency detail: offset of each vertex from its neighbours' midpoint. */
interface Detail {
  ox: Float64Array;
  oy: Float64Array;
  /** Feature each stored vertex belongs to, for rescaling the detail. */
  feature: Uint32Array;
}

function captureDetail(g: FlatGeometry, vi: VertexIndex): Detail {
  const n = g.coords.length >>> 1;
  const ox = new Float64Array(n);
  const oy = new Float64Array(n);
  const feature = new Uint32Array(n);

  for (let f = 0; f < g.featCount; f++) {
    for (let p = g.featStart[f]!; p < g.featStart[f + 1]!; p++) {
      for (let r = g.polyStart[p]!; r < g.polyStart[p + 1]!; r++) {
        const [s, e] = ringRange(g, r);
        for (let v = s; v < e; v++) {
          const prev = v === s ? e - 1 : v - 1;
          const next = v + 1 < e ? v + 1 : s;
          ox[v] = g.coords[2 * v]! - (g.coords[2 * prev]! + g.coords[2 * next]!) / 2;
          oy[v] = g.coords[2 * v + 1]! - (g.coords[2 * prev + 1]! + g.coords[2 * next + 1]!) / 2;
          feature[v] = f;
        }
      }
    }
  }
  void vi;
  return { ox, oy, feature };
}

/**
 * Put back the boundary detail the smooth force field flattened (F20a/F20b).
 *
 * The force field varies slowly in space, so neighbouring vertices receive nearly the
 * same displacement and the *difference* between a vertex and its neighbours -- which
 * is exactly what makes a coastline a coastline -- decays a little every iteration.
 * Over 30 iterations that is what turns regions into blobs. Here the original offset
 * from the neighbours' midpoint is rescaled by the region's linear size change and
 * blended back in.
 */
function restoreDetail(
  g: FlatGeometry,
  vi: VertexIndex,
  detail: Detail,
  areas0: Float64Array,
  areasNow: Float64Array,
  alpha: number,
): void {
  const n = g.coords.length >>> 1;
  const accX = new Float64Array(vi.count);
  const accY = new Float64Array(vi.count);
  const hits = new Uint32Array(vi.count);
  const scale = new Float64Array(g.featCount);
  for (let f = 0; f < g.featCount; f++) {
    scale[f] = areas0[f]! > 0 ? Math.sqrt(Math.max(areasNow[f]!, 0) / areas0[f]!) : 1;
  }

  for (let r = 0; r < g.ringCount; r++) {
    const [s, e] = ringRange(g, r);
    for (let v = s; v < e; v++) {
      const prev = v === s ? e - 1 : v - 1;
      const next = v + 1 < e ? v + 1 : s;
      const mx = (g.coords[2 * prev]! + g.coords[2 * next]!) / 2;
      const my = (g.coords[2 * prev + 1]! + g.coords[2 * next + 1]!) / 2;
      const k = scale[detail.feature[v]!]!;
      const wantX = mx + detail.ox[v]! * k;
      const wantY = my + detail.oy[v]! * k;
      const id = vi.ids[v]!;
      accX[id]! += wantX - g.coords[2 * v]!;
      accY[id]! += wantY - g.coords[2 * v + 1]!;
      hits[id]!++;
    }
  }

  for (let i = 0; i < vi.count; i++) {
    if (hits[i]! === 0) continue;
    vi.coords[2 * i]! += (alpha * accX[i]!) / hits[i]!;
    vi.coords[2 * i + 1]! += (alpha * accY[i]!) / hits[i]!;
  }
  scatter(g, vi);
  void n;
}

interface RingGuard {
  orientation: Int8Array;
  /** Rings too small to judge: a sliver flipping sign is numerical noise, not a fold. */
  ignore: Uint8Array;
}

function ringGuard(g: FlatGeometry): RingGuard {
  const orientation = new Int8Array(g.ringCount);
  const areas = new Float64Array(g.ringCount);
  let total = 0;
  for (let r = 0; r < g.ringCount; r++) {
    const a = ringSignedArea(g, r);
    orientation[r] = Math.sign(a);
    areas[r] = Math.abs(a);
    total += areas[r]!;
  }
  const epsilon = (total / Math.max(1, g.ringCount)) * 1e-6;
  const ignore = new Uint8Array(g.ringCount);
  for (let r = 0; r < g.ringCount; r++) ignore[r] = areas[r]! <= epsilon ? 1 : 0;
  return { orientation, ignore };
}

/** Has any ring turned inside out? That is a self-intersecting polygon (F19). */
function folded(g: FlatGeometry, guard: RingGuard): boolean {
  for (let r = 0; r < g.ringCount; r++) {
    if (guard.ignore[r]) continue;
    const s = Math.sign(ringSignedArea(g, r));
    if (s !== 0 && guard.orientation[r] !== 0 && s !== guard.orientation[r]) return true;
  }
  return false;
}

function errorOf(areas: Float64Array, target: Float64Array): number {
  let areaSum = 0;
  let targetSum = 0;
  for (let f = 0; f < areas.length; f++) {
    areaSum += areas[f]!;
    targetSum += target[f]!;
  }
  let sum = 0;
  for (let f = 0; f < areas.length; f++) {
    const o = areaSum > 0 ? areas[f]! / areaSum : 0;
    const w = targetSum > 0 ? target[f]! / targetSum : 0;
    const d = Math.max(o, w);
    sum += d === 0 ? 0 : Math.abs(o - w) / d;
  }
  return areas.length > 0 ? sum / areas.length : 0;
}

function median(xs: Float64Array): number {
  if (xs.length === 0) return 0;
  const sorted = Float64Array.from(xs).sort();
  return sorted[sorted.length >> 1]!;
}
