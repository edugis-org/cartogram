import type { FlatGeometry } from '../../geometry/flat.ts';
import { allFeatureAreas, bbox } from '../../geometry/area.ts';
import { Dct, dct2Forward, dct2Inverse, dct2InverseMixed } from './dct.ts';
import { buildDensityGrid } from './grid.ts';

export interface FlowParams {
  /** Grid resolution per side; must be a power of two. Default 512. */
  grid: number;
  /** Domain size as a multiple of the map's larger dimension. Default 1.5. */
  padding: number;
  /** Stop when the mean cartographic error reaches this. Default 0.01. */
  targetError: number;
  /**
   * Minimum target area for a region, as a fraction of a grid cell. Default 0.05.
   *
   * Exists only to stop a region collapsing to numerical nothing over successive
   * passes. It must be *small*: at a full cell it does not merely protect the tiny
   * regions, it raises every region sparser than average up to mean density, which
   * inflates the total land area and squeezes the surrounding ocean.
   */
  floorCells: number;
  /** Cap on integration steps within one pass. Default 200. */
  stepsPerRun: number;
  /**
   * How the velocity field is obtained. Default `differences`.
   *
   * - `differences` — central differences on the reconstructed density. One inverse
   *   transform per step.
   * - `analytic` — differentiate the cosine series in the spectrum and evaluate the
   *   resulting sine series, which is exact for the field being represented.
   *
   * How much `analytic` buys depends on the map, and this option was once documented as
   * buying nothing on the strength of a measurement taken on one dataset -- a caution
   * worth keeping in mind for every other number in this file. On the Dutch provinces it
   * moves the median area error from 0.146% to 0.141%, which really is nothing: twelve
   * regions of similar density, a field the differences resolve perfectly well. On NUTS
   * 2 the same switch moves it from 1.334% to 0.412%, and on world countries from 0.685%
   * to 0.501%.
   *
   * The pattern is that the two agree wherever the density field is smooth at the scale
   * of a cell, and diverge wherever it is not -- which is to say on maps with many
   * regions and sharp density contrasts, the maps this method exists for.
   *
   * `differences` remains the default because it costs about a third of the runtime and
   * because the accuracy it gives up is invisible on a small map. On world countries
   * `analytic` also takes the self-intersection count from 17 to 48, so it is not a free
   * improvement even where it improves the areas.
   */
  gradient: 'analytic' | 'differences';
  /**
   * Local error tolerance for the adaptive step, in grid cells. Default 0.2.
   *
   * The integrator estimates how far a step is wrong by comparing its second-order
   * result against the first-order one it contains, and shrinks or grows the step to
   * hold that estimate near this value.
   *
   * Tightening it makes the result *worse*, which is worth understanding before
   * touching it. Swept over the seven datasets in `data/` at grid 512, 0.2 beat 0.02 on
   * the median area error of six of them and tied on the seventh, at half the runtime:
   * NUTS 2 went 1.334% -> 1.034%, world countries 0.685% -> 0.600%, the Dutch provinces
   * 0.146% -> 0.097%. 0.3 is past the edge -- it regresses on the municipalities and on
   * world countries -- so 0.2 is where the default sits.
   *
   * The reason is the pass's own stopping rule a few lines below: a run ends when the
   * largest vertex movement *in one step* falls below a threshold, and that movement
   * scales with the step size. A tight tolerance keeps the steps small, so the rule
   * fires while the flow still has somewhere to go, and the pass ends early. The
   * accuracy a tight tolerance buys inside a pass is worth less than the flow it costs.
   *
   * That is an interaction rather than a design, and the honest fix is to make the
   * stopping rule independent of the step size. An attempt at it -- comparing a speed
   * rather than a displacement -- made every dataset several times worse, because `h`
   * grows well past 1 and dividing by it tightened the rule instead of loosening it. It
   * needs its own calibration sweep, and until then the default is set where the
   * measurements put it.
   */
  tolerance: number;
  /** Passes over the whole flow, each with half the blur of the last. Default 10. */
  runs: number;
  /** Blur of the first pass, in cells; halves each pass. Default 4. */
  blur: number;
  onIteration?: ((step: number, meanError: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export const FLOW_DEFAULTS: FlowParams = {
  grid: 512,
  padding: 1.5,
  targetError: 0.01,
  stepsPerRun: 200,
  tolerance: 0.2,
  floorCells: 0.05,
  gradient: 'differences',
  runs: 10,
  blur: 4,
};

export interface FlowReport {
  targetAreas: Float64Array;
  steps: number;
  meanError: number;
  converged: boolean;
  /** Diffusion time reached in the final pass. Diagnostic only. */
  time: number;
  seaFraction: number;
  /** Features smaller than one grid cell in the final pass. */
  underResolved: number;
}

/**
 * Flow-based cartogram, after Gastner, Seguy & More (2018), PNAS 115:E2156.
 *
 * The map is rasterized to a density field (value per unit area), which is then
 * allowed to diffuse until uniform. Every point of the plane is carried along by the
 * induced flow, v = -grad(rho)/rho, and where the points end up *is* the cartogram:
 * regions that were too dense expand, regions that were too sparse contract, and by
 * construction the whole plane deforms continuously.
 *
 * Two properties follow from that construction rather than from any effort on our
 * part, and they are exactly what the force-based method could not deliver:
 *
 *  - **Shared borders cannot tear.** A single displacement field is applied to every
 *    point, so identical coordinates map to identical images whatever the field does.
 *  - **Regions do not round off into discs.** Nothing pushes a boundary radially away
 *    from a centroid; boundaries are carried by a smooth global flow, so a straight
 *    coast stays much straighter than it does under the force method.
 *
 * Diffusion is solved in the cosine basis, where the heat equation is diagonal: each
 * coefficient simply decays as exp(-k^2 t). Advancing to any time t is one
 * multiplication per coefficient plus an inverse transform, with no PDE time stepping.
 *
 * Lineage and honest scope. The physics is Gastner & Newman (2004): rasterize the
 * density, diffuse it with a cosine transform, advect the map's points. The velocity
 * formulation v = -grad(rho)/rho and the emphasis on integrating the flow come from
 * Gastner, Seguy & More (2018). What this is *not* is a faithful reimplementation of
 * the 2018 paper: their adaptive Runge-Kutta with step-size control is replaced here
 * by a midpoint rule on a geometric time schedule, and their blur handling by the
 * outer pass structure below. So: the same physics and the same flow formulation,
 * with the integration engineered independently, and measured rather than assumed.
 *
 * A second deviation: the velocity field comes by default from central differences on
 * the diffused grid rather than analytic sine/cosine transforms of the gradient, which
 * cuts the transforms per step from three to one. How much accuracy that gives up is a
 * property of the map rather than of the method -- nothing on a dozen similar regions,
 * a factor of three on NUTS 2. See `gradient`.
 */
export function flow(g: FlatGeometry, values: Float64Array, params: FlowParams): FlowReport {
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
    return {
      targetAreas: target,
      steps: 0,
      meanError: 0,
      converged: true,
      time: 0,
      seaFraction: 0,
      underResolved: 0,
    };
  }
  // Floor the values once, here, rather than flooring the rasterized density each
  // pass. A region worth nothing must shrink hard, but it cannot be allowed to become
  // a singularity: the velocity is -grad(rho)/rho, so density near zero divides by
  // near zero. With `missing: 'zero'` on NUTS 3 that sent the Western Isles up by a
  // factor of 296765 and flattened the rest of the map into a line.
  //
  // Flooring the density per pass instead is not enough, and worse, it compounds: the
  // floor is re-applied to an already shrunken region every pass, so the 181 UK
  // regions with no Eurostat population collapsed by 13 orders of magnitude rather
  // than the intended thousandfold. Flooring the value once gives every region a fixed
  // target that successive passes converge to instead of chasing.
  //
  // The floor is one grid cell's worth of area -- below that the grid cannot represent
  // the region at all, and it compounds away to nothing over successive passes -- but
  // **capped at the region's own current area**, so that flooring can only ever stop a
  // region shrinking, never make it grow.
  //
  // Without that cap the floor is a disaster on fine-grained data: a region smaller
  // than a grid cell is *inflated* to a full cell. On NUTS 3 at grid 256 that took
  // Tower Hamlets, which has no Eurostat population and so a value of zero, from 12
  // km2 to 21887 km2, and did the same to 180 other British regions, burying the map
  // under a mass of identical blobs.
  const [minX, minY, maxX, maxY] = bbox(g);
  const cellArea = Math.pow((Math.max(maxX - minX, maxY - minY) * params.padding) / params.grid, 2);
  const effective = new Float64Array(n);
  let effectiveSum = 0;
  for (let f = 0; f < n; f++) {
    const floorArea = Math.min(cellArea * params.floorCells, areas0[f]!);
    const floorValue = areaSum > 0 ? (valueSum * floorArea) / areaSum : 0;
    effective[f] = Math.max(values[f]!, floorValue);
    effectiveSum += effective[f]!;
  }
  for (let f = 0; f < n; f++) target[f] = (areaSum * effective[f]!) / effectiveSum;

  // Progressive resolution. The early passes run with a wide blur, which throws away
  // the fine detail of the field anyway, so resolving it is wasted work: a pass at 128
  // costs about a twentieth of one at 512, since the transforms go as N^2 log N. The
  // grid doubles each pass up to the requested one, and the blur halves alongside it,
  // so the two stay in step.
  const sizes: number[] = [];
  for (let run = 0, size = Math.min(128, params.grid); run < params.runs; run++) {
    sizes.push(size);
    size = Math.min(params.grid, size * 2);
  }

  const dcts = new Map<number, Dct>();
  const wavenumbers = new Map<number, { k2: Float64Array; kx: Float64Array }>();
  const buffers = new Map<number, {
    rho: Float64Array; vxA: Float64Array; vyA: Float64Array;
    vxB: Float64Array; vyB: Float64Array; scratch: Float64Array; gradScratch: Float64Array;
  }>();
  const forSize = (size: number) => {
    let dct = dcts.get(size);
    if (!dct) {
      dct = new Dct(size);
      dcts.set(size, dct);
      const k2 = new Float64Array(size);
      const kx = new Float64Array(size);
      for (let k = 0; k < size; k++) {
        kx[k] = (Math.PI * k) / size;
        k2[k] = kx[k]! * kx[k]!;
      }
      wavenumbers.set(size, { k2, kx });
      buffers.set(size, {
        rho: new Float64Array(size * size),
        vxA: new Float64Array(size * size),
        vyA: new Float64Array(size * size),
        vxB: new Float64Array(size * size),
        vyB: new Float64Array(size * size),
        scratch: new Float64Array(size * size),
        gradScratch: new Float64Array(size * size),
      });
    }
    return { dct, ...wavenumbers.get(size)!, ...buffers.get(size)! };
  };

  // Two velocity fields per resolution: the one at the current time, and the one at
  // the end of the trial step. Heun needs both, and after an accepted step the second
  // becomes the first, so a step costs exactly one new field evaluation.
  const vertexCount = g.coords.length >>> 1;
  const px = new Float64Array(vertexCount);
  const py = new Float64Array(vertexCount);
  const trialX = new Float64Array(vertexCount);
  const trialY = new Float64Array(vertexCount);


  let meanError = errorOf(allFeatureAreas(g), target);
  let converged = meanError <= params.targetError;
  let steps = 0;
  let stalled = 0;
  let seaFraction = 0;
  let underResolved = 0;
  let lastTime = 0;

  for (let run = 0; run < params.runs && !converged; run++) {
    if (params.signal?.aborted) break;

    const size = sizes[run]!;
    const { dct, k2, kx, rho, vxA, vyA, vxB, vyB, scratch, gradScratch } = forSize(size);
    const tRelax = (size / Math.PI) * (size / Math.PI);
    const tMax = 8 * tRelax;

    const grid = buildDensityGrid(g, effective, size, params.padding);
    seaFraction = grid.seaFraction;
    underResolved = grid.underResolved;
    const coeff = Float64Array.from(grid.rho);
    dct2Forward(coeff, size, size, dct, dct);

    // Blur is in cells, so it must not shrink faster than the cells do: while the grid
    // is still doubling, a constant number of cells is already a halving in map units.
    // Blur is measured in cells, so while the grid is still doubling a constant cell
    // count already halves the blur in map units. Once the grid stops growing, the
    // cell count itself has to halve to keep annealing. Indexing from where this
    // resolution *starts* is what makes the two schedules line up.
    const blur = params.blur * Math.pow(0.5, Math.max(0, run - sizes.indexOf(size)));
    if (blur > 0.05) {
      const sigmaT = (blur * blur) / 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) coeff[y * size + x]! *= Math.exp(-(k2[x]! + k2[y]!) * sigmaT);
      }
    }

    for (let v = 0; v < vertexCount; v++) {
      px[v] = (g.coords[2 * v]! - grid.x0) / grid.h;
      py[v] = (g.coords[2 * v + 1]! - grid.y0) / grid.h;
    }

    // Adaptive Heun (the explicit trapezoid) with the Euler result it contains used as
    // the error estimate -- the classic embedded pair. Their difference is the local
    // error, and the step is scaled to hold it near `tolerance`.
    //
    // This replaces a fixed geometric schedule, which had to be conservative
    // everywhere to survive the violent early flow, and so wasted most of its steps on
    // the long uniform tail where nothing moves. Since every step costs an inverse
    // cosine transform, spending them where the flow actually varies is the whole game.
    let t = 0;
    let h = 0.05;
    velocityAt(coeff, size, dct, k2, kx, t, params.gradient, rho, vxA, vyA, scratch, gradScratch);

    let stepsThisRun = 0;
    while (t < tMax && stepsThisRun < params.stepsPerRun) {
      if (params.signal?.aborted) break;

      velocityAt(coeff, size, dct, k2, kx, t + h, params.gradient, rho, vxB, vyB, scratch, gradScratch);
      steps++;
      stepsThisRun++;

      let worst = 0;
      let moved = 0;
      for (let v = 0; v < vertexCount; v++) {
        const [ux, uy] = sample(vxA, vyA, size, px[v]!, py[v]!);
        const ex = px[v]! + ux * h;
        const ey = py[v]! + uy * h;
        const [wx, wy] = sample(vxB, vyB, size, ex, ey);
        const hx = px[v]! + ((ux + wx) / 2) * h;
        const hy = py[v]! + ((uy + wy) / 2) * h;
        trialX[v] = hx;
        trialY[v] = hy;
        // Heun minus Euler: the second-order correction, which is the local error.
        const err = Math.abs(hx - ex) + Math.abs(hy - ey);
        if (err > worst) worst = err;
        const move = Math.abs(hx - px[v]!) + Math.abs(hy - py[v]!);
        if (move > moved) moved = move;
      }

      if (worst > params.tolerance && h > 1e-6) {
        // Reject and retry smaller. The field at t is still valid, so only the trial
        // field is recomputed.
        h *= Math.max(0.2, 0.9 * Math.sqrt(params.tolerance / worst));
        continue;
      }

      px.set(trialX);
      py.set(trialY);
      t += h;
      vxA.set(vxB);
      vyA.set(vyB);

      // Grow towards the tolerance, but never by more than a factor of four at once.
      const growth = worst > 0 ? 0.9 * Math.sqrt(params.tolerance / worst) : 4;
      h *= Math.min(4, Math.max(1, growth));

      // Once nothing moves, the remaining time carries no information.
      if (moved < 1e-3) break;
    }
    lastTime = t;

    applyToGeometry(g, px, py, grid);
    const previous = meanError;
    meanError = errorOf(allFeatureAreas(g), target);
    params.onIteration?.(run + 1, meanError);
    if (meanError <= params.targetError) converged = true;

    if (previous > 0 && meanError > previous * 0.999) {
      stalled++;
      if (stalled >= 3) break;
    } else {
      stalled = 0;
    }
  }

  return {
    targetAreas: target,
    steps,
    meanError,
    converged,
    time: lastTime,
    seaFraction,
    underResolved,
  };
}

/** Density field at time t, with an optional Gaussian blur, into `out`. */
function fieldAt(
  coeff: Float64Array,
  out: Float64Array,
  size: number,
  dct: Dct,
  k2: Float64Array,
  t: number,
  scratch: Float64Array,
): void {
  for (let y = 0; y < size; y++) {
    const ky2 = k2[y]!;
    for (let x = 0; x < size; x++) {
      const decay = Math.exp(-(k2[x]! + ky2) * t);
      scratch[y * size + x] = coeff[y * size + x]! * decay;
    }
  }
  dct2Inverse(scratch, size, size, dct, dct);
  out.set(scratch);
}

/**
 * The velocity field v = -grad(rho)/rho at time t.
 *
 * The analytic path differentiates the cosine series in the spectrum -- multiplying
 * each coefficient by the wavenumber turns the cosine series into a sine series -- and
 * evaluates that directly. It is exact for the field being represented, where central
 * differences carry an O(h^2) error that no amount of finer time stepping can remove.
 * The price is three inverse transforms per step (density and both derivatives) rather
 * than one, and transforms are what this method spends its time on.
 */
function velocityAt(
  coeff: Float64Array,
  size: number,
  dct: Dct,
  k2: Float64Array,
  kx: Float64Array,
  t: number,
  mode: 'analytic' | 'differences',
  rho: Float64Array,
  vx: Float64Array,
  vy: Float64Array,
  scratch: Float64Array,
  gradScratch: Float64Array,
): void {
  fieldAt(coeff, rho, size, dct, k2, t, scratch);
  if (mode === 'differences') {
    velocity(rho, vx, vy, size);
    return;
  }

  const floor = 1e-3;
  for (const axis of ['x', 'y'] as const) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        // d/dx of cos(kx x) is -kx sin(kx x); the sine transform evaluates the result.
        gradScratch[i] = coeff[i]! * Math.exp(-(k2[x]! + k2[y]!) * t) * -(axis === 'x' ? kx[x]! : kx[y]!);
      }
    }
    dct2InverseMixed(gradScratch, size, size, dct, dct, axis);
    const out = axis === 'x' ? vx : vy;
    for (let i = 0; i < size * size; i++) out[i] = -gradScratch[i]! / Math.max(rho[i]!, floor);
  }
}

/**
 * v = -grad(rho) / rho, by central differences.
 *
 * The density is floored before dividing, relative to the mean (which normalization
 * fixes at 1). rho is in the denominator, so wherever the field dips towards zero the
 * velocity diverges and vertices are flung across the map. A floor of 1e-6 was far too
 * permissive: it still allowed velocities a million times the typical one.
 */
function velocity(rho: Float64Array, vx: Float64Array, vy: Float64Array, size: number): void {
  // Mean density is 1 after normalization, so this is a thousandth of typical.
  const floor = 1e-3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const xm = x > 0 ? i - 1 : i;
      const xp = x < size - 1 ? i + 1 : i;
      const ym = y > 0 ? i - size : i;
      const yp = y < size - 1 ? i + size : i;
      const d = Math.max(rho[i]!, floor);
      vx[i] = -((rho[xp]! - rho[xm]!) / (xp === xm ? 1 : x > 0 && x < size - 1 ? 2 : 1)) / d;
      vy[i] = -((rho[yp]! - rho[ym]!) / (yp === ym ? 1 : y > 0 && y < size - 1 ? 2 : 1)) / d;
    }
  }
}

/** Bilinear sample of the velocity field at a point in grid coordinates. */
function sample(
  vx: Float64Array,
  vy: Float64Array,
  size: number,
  x: number,
  y: number,
): [number, number] {
  // Cell centres sit at integer + 0.5, so shift before flooring.
  const fx = Math.min(size - 1.001, Math.max(0, x - 0.5));
  const fy = Math.min(size - 1.001, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);

  const i00 = y0 * size + x0;
  const i10 = y0 * size + x1;
  const i01 = y1 * size + x0;
  const i11 = y1 * size + x1;

  const lerp = (a: number, b: number, c: number, d: number) =>
    (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;

  return [
    lerp(vx[i00]!, vx[i10]!, vx[i01]!, vx[i11]!),
    lerp(vy[i00]!, vy[i10]!, vy[i01]!, vy[i11]!),
  ];
}

/** Write the advected points back into the geometry and return the resulting areas. */
function applyToGeometry(
  g: FlatGeometry,
  px: Float64Array,
  py: Float64Array,
  grid: { x0: number; y0: number; h: number },
): Float64Array {
  const n = px.length;
  for (let v = 0; v < n; v++) {
    g.coords[2 * v] = grid.x0 + px[v]! * grid.h;
    g.coords[2 * v + 1] = grid.y0 + py[v]! * grid.h;
  }
  return allFeatureAreas(g);
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
