import type { FlatGeometry } from '../../geometry/flat.ts';
import { ringRange } from '../../geometry/flat.ts';
import { allFeatureAreas, bbox, featureCentroid } from '../../geometry/area.ts';

export interface DensityGrid {
  nx: number;
  ny: number;
  /** World coordinates of the grid's lower-left corner. */
  x0: number;
  y0: number;
  /** Cell size in world units (square cells). */
  h: number;
  /** Row-major density, normalized to mean 1. */
  rho: Float64Array;
  /** Feature index per cell, or -1 for sea. Kept for diagnostics and tests. */
  owner: Int32Array;
  /** Fraction of cells that fell outside every feature. */
  seaFraction: number;
  /**
   * Features smaller than one grid cell, which had to be given a cell so that they
   * appear in the density field at all. Their areas are quantized to the grid, so a
   * large count means the grid is too coarse for this map.
   */
  underResolved: number;
}

/**
 * Rasterize the map onto a regular grid and build the target density field.
 *
 * Density is value per unit area, so a region that must grow starts dense and a region
 * that must shrink starts sparse; diffusing that field to uniform is exactly the
 * transformation that equalizes them (Gastner & Newman 2004).
 *
 * Sea cells take the mean density of the whole map, which is what keeps the ocean
 * neutral: it neither swells nor collapses, it just gets out of the way.
 *
 * Rasterization is a scanline fill per polygon rather than a point-in-polygon test per
 * cell: the latter is O(cells x edges) and hopeless at 512^2 with 10^5 edges.
 */
export function buildDensityGrid(
  g: FlatGeometry,
  values: Float64Array,
  size: number,
  padding: number,
): DensityGrid {
  const [minX, minY, maxX, maxY] = bbox(g);
  const w = maxX - minX;
  const h = maxY - minY;
  // Square cells over a padded square domain: the sea margin gives the flow somewhere
  // to push mass into, and without it regions pile up against the boundary.
  const span = Math.max(w, h) * padding;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const x0 = cx - span / 2;
  const y0 = cy - span / 2;
  const cell = span / size;

  const owner = new Int32Array(size * size).fill(-1);
  rasterize(g, owner, size, x0, y0, cell);
  const underResolved = ensureEveryFeatureHasACell(g, owner, size, x0, y0, cell);

  const areas = allFeatureAreas(g);
  let valueSum = 0;
  let areaSum = 0;
  for (let f = 0; f < g.featCount; f++) {
    valueSum += values[f]!;
    areaSum += areas[f]!;
  }
  const meanDensity = areaSum > 0 ? valueSum / areaSum : 1;

  // Per-feature target density. Using the *rasterized* cell count rather than the
  // exact polygon area matters: the flow equalizes the field it is actually given, so
  // any mismatch between the two shows up directly as area error.
  const cellCount = new Float64Array(g.featCount);
  for (let i = 0; i < owner.length; i++) {
    const f = owner[i]!;
    if (f >= 0) cellCount[f]!++;
  }

  const rho = new Float64Array(size * size);
  let sea = 0;
  for (let i = 0; i < owner.length; i++) {
    const f = owner[i]!;
    if (f < 0) {
      rho[i] = meanDensity;
      sea++;
    } else {
      const cells = cellCount[f]!;
      rho[i] = cells > 0 ? values[f]! / (cells * cell * cell) : meanDensity;
    }
  }

  // Normalize to mean 1 so the diffusion time scale is independent of the data's units.
  let sum = 0;
  for (let i = 0; i < rho.length; i++) sum += rho[i]!;
  const mean = sum / rho.length;
  if (mean > 0) for (let i = 0; i < rho.length; i++) rho[i]! /= mean;

  return {
    nx: size,
    ny: size,
    x0,
    y0,
    h: cell,
    rho,
    owner,
    seaFraction: sea / owner.length,
    underResolved,
  };
}

/**
 * Give every feature at least one cell.
 *
 * A feature smaller than a grid cell can fall entirely between cell centres and own
 * nothing at all. It then contributes *nothing* to the density field: it exerts no
 * pressure, is merely dragged along by its neighbours, and comes out shrunken. That is
 * not a subtlety on real data -- at grid 256, 674 of the 1333 NUTS 3 regions own no
 * cell, including Paris, which is 49 km^2 against a 72 km cell and holds 2.1 million
 * people. It should be one of the largest regions in the cartogram and instead it
 * shrank.
 *
 * Each such feature is given the cell containing its centroid, taking it from whatever
 * held it before (a neighbour losing one cell of area is a far smaller error than a
 * region vanishing from the field). Where two of them want the same cell, the second
 * spirals outwards for a free one, so they do not silently overwrite each other.
 *
 * This makes tiny features visible, but their area is still quantized to whole cells:
 * the honest fix for a map full of them is a finer grid, which is why the count is
 * reported.
 */
function ensureEveryFeatureHasACell(
  g: FlatGeometry,
  owner: Int32Array,
  size: number,
  x0: number,
  y0: number,
  cell: number,
): number {
  const counts = new Int32Array(g.featCount);
  for (let i = 0; i < owner.length; i++) {
    const f = owner[i]!;
    if (f >= 0) counts[f]!++;
  }

  let fixed = 0;
  for (let f = 0; f < g.featCount; f++) {
    if (counts[f]! > 0) continue;
    const [cx, cy] = featureCentroid(g, f);
    const col = Math.min(size - 1, Math.max(0, Math.floor((cx - x0) / cell)));
    const row = Math.min(size - 1, Math.max(0, Math.floor((cy - y0) / cell)));

    // Prefer an empty cell; failing that, borrow from a feature that can spare one.
    // Never take another feature's last cell -- doing so just moves the problem, and
    // measurably so: a first attempt that ignored this still left 361 of 1333 NUTS 3
    // regions with nothing, because tiny neighbours kept stealing from each other.
    let target = -1;
    let fallback = -1;
    for (let ring = 0; ring < size && target < 0; ring++) {
      for (let dr = -ring; dr <= ring && target < 0; dr++) {
        for (let dc = -ring; dc <= ring && target < 0; dc++) {
          if (ring > 0 && Math.abs(dr) !== ring && Math.abs(dc) !== ring) continue;
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const index = r * size + c;
          const held = owner[index]!;
          if (held < 0) target = index;
          else if (fallback < 0 && counts[held]! > 1) fallback = index;
        }
      }
      // Give the search a few rings to find empty space before borrowing.
      if (target < 0 && fallback >= 0 && ring >= 2) target = fallback;
    }
    if (target < 0) continue;
    const previous = owner[target]!;
    if (previous >= 0) counts[previous]!--;
    owner[target] = f;
    counts[f] = 1;
    fixed++;
  }
  return fixed;
}

/**
 * Scanline fill. Each polygon's rings are filled together with the even-odd rule, so
 * holes fall out for free. Cell centres decide ownership, which keeps the rasterized
 * area an unbiased estimate of the true area.
 */
function rasterize(
  g: FlatGeometry,
  owner: Int32Array,
  size: number,
  x0: number,
  y0: number,
  cell: number,
): void {
  const xs: number[] = [];
  for (let f = 0; f < g.featCount; f++) {
    for (let p = g.featStart[f]!; p < g.featStart[f + 1]!; p++) {
      const r0 = g.polyStart[p]!;
      const r1 = g.polyStart[p + 1]!;

      let minY = Infinity;
      let maxY = -Infinity;
      for (let r = r0; r < r1; r++) {
        const [s, e] = ringRange(g, r);
        for (let v = s; v < e; v++) {
          const y = g.coords[2 * v + 1]!;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }

      const rowStart = Math.max(0, Math.ceil((minY - y0) / cell - 0.5));
      const rowEnd = Math.min(size - 1, Math.floor((maxY - y0) / cell - 0.5));

      for (let row = rowStart; row <= rowEnd; row++) {
        const yc = y0 + (row + 0.5) * cell;
        xs.length = 0;
        for (let r = r0; r < r1; r++) {
          const [s, e] = ringRange(g, r);
          let xPrev = g.coords[2 * (e - 1)]!;
          let yPrev = g.coords[2 * (e - 1) + 1]!;
          for (let v = s; v < e; v++) {
            const x = g.coords[2 * v]!;
            const y = g.coords[2 * v + 1]!;
            // Half-open crossing test: a vertex exactly on the scanline is counted
            // once, not twice, which is what stops spurious one-cell holes.
            if (yPrev <= yc !== y <= yc) {
              xs.push(xPrev + ((yc - yPrev) / (y - yPrev)) * (x - xPrev));
            }
            xPrev = x;
            yPrev = y;
          }
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const cStart = Math.max(0, Math.ceil((xs[i]! - x0) / cell - 0.5));
          const cEnd = Math.min(size - 1, Math.floor((xs[i + 1]! - x0) / cell - 0.5));
          const base = row * size;
          for (let col = cStart; col <= cEnd; col++) owner[base + col] = f;
        }
      }
    }
  }
}
