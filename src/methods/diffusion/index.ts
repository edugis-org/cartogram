import type { FlatGeometry } from '../../geometry/flat.ts';
import { allFeatureAreas } from '../../geometry/area.ts';
import { Dct, dct2Forward, dct2Inverse } from './dct.ts';
import { buildDensityGrid } from './grid.ts';

export interface FlowParams {
  /** Grid resolution per side; must be a power of two. Default 512. */
  grid: number;
  /** Domain size as a multiple of the map's larger dimension. Default 1.5. */
  padding: number;
  /** Stop when the mean cartographic error reaches this. Default 0.01. */
  targetError: number;
  /** Integration steps within one pass. Default 60. */
  stepsPerRun: number;
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
  stepsPerRun: 60,
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
 * Deviation from the paper worth stating: the velocity field is obtained by central
 * differences on the diffused grid rather than from analytic sine/cosine transforms of
 * the gradient. The field is smooth by construction -- it has been diffused and
 * blurred -- so the difference is small, and it halves the number of transforms.
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
    return { targetAreas: target, steps: 0, meanError: 0, converged: true, time: 0, seaFraction: 0 };
  }
  for (let f = 0; f < n; f++) target[f] = (areaSum * values[f]!) / valueSum;

  const size = params.grid;
  const dct = new Dct(size);
  const k2 = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    const kx = (Math.PI * k) / size;
    k2[k] = kx * kx;
  }

  const rho = new Float64Array(size * size);
  const vx = new Float64Array(size * size);
  const vy = new Float64Array(size * size);
  const scratch = new Float64Array(size * size);
  const vertexCount = g.coords.length >>> 1;
  const px = new Float64Array(vertexCount);
  const py = new Float64Array(vertexCount);

  const tRelax = (size / Math.PI) * (size / Math.PI);
  const tMin = 0.05;
  const tMax = 8 * tRelax;
  const ratio = Math.pow(tMax / tMin, 1 / params.stepsPerRun);

  let meanError = errorOf(allFeatureAreas(g), target);
  let converged = meanError <= params.targetError;
  let steps = 0;
  let seaFraction = 0;
  let lastTime = 0;

  // Outer loop over a decreasing blur, each pass re-rasterizing the *current* map.
  //
  // A single pass cannot get there: the density field is built from the map as it is
  // now, so once the map has moved the field it was built from is stale. Re-deriving
  // it and flowing again is what actually converges -- and running the early passes
  // with a wide blur is what keeps them stable. Without the blur schedule the field
  // has near-singular gradients at region boundaries (a 500:1 density jump across one
  // cell in the synthetic grid), the integrator throws vertices across the map, and
  // the result swings wildly with grid size: 72% area error at 256 cells against 5% at
  // 512, which is the signature of an under-resolved field rather than of tuning.
  for (let run = 0; run < params.runs && !converged; run++) {
    if (params.signal?.aborted) break;

    const grid = buildDensityGrid(g, values, size, params.padding);
    seaFraction = grid.seaFraction;
    const coeff = Float64Array.from(grid.rho);
    dct2Forward(coeff, size, size, dct, dct);

    // Blur halves each pass, down to nothing.
    const blur = params.blur * Math.pow(0.5, run);
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

    // Steps are geometric in time: the early sharp flow is finely resolved and the
    // long uniform tail costs few steps. A fixed fraction of t was tried first and is
    // far too coarse, leaving a third of the area error behind.
    let t = tMin;
    for (let step = 0; step < params.stepsPerRun; step++) {
      const dt = t * (ratio - 1);
      // One field evaluation per step, at the interval midpoint: second order in time
      // without a second transform.
      fieldAt(coeff, rho, size, dct, k2, t + dt / 2, scratch);
      velocity(rho, vx, vy, size);

      for (let v = 0; v < vertexCount; v++) {
        const [ux, uy] = sample(vx, vy, size, px[v]!, py[v]!);
        const midX = px[v]! + ux * dt;
        const midY = py[v]! + uy * dt;
        const [wx, wy] = sample(vx, vy, size, midX, midY);
        px[v]! += ((ux + wx) / 2) * dt;
        py[v]! += ((uy + wy) / 2) * dt;
      }
      t += dt;
      steps++;
    }
    lastTime = t;

    applyToGeometry(g, px, py, grid);
    meanError = errorOf(allFeatureAreas(g), target);
    params.onIteration?.(run + 1, meanError);
    if (meanError <= params.targetError) converged = true;
  }

  return {
    targetAreas: target,
    steps,
    meanError,
    converged,
    time: lastTime,
    seaFraction,
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
 * v = -grad(rho) / rho, by central differences.
 *
 * The density is floored well above zero before dividing: rho appears in the
 * denominator, and a diffused field can dip very low over a large empty sea, which
 * would otherwise produce enormous spurious velocities there.
 */
function velocity(rho: Float64Array, vx: Float64Array, vy: Float64Array, size: number): void {
  const floor = 1e-6;
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
