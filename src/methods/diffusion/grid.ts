import type { FlatGeometry } from '../../geometry/flat.ts';
import { ringRange } from '../../geometry/flat.ts';
import { allFeatureAreas, bbox } from '../../geometry/area.ts';

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

  return { nx: size, ny: size, x0, y0, h: cell, rho, owner, seaFraction: sea / owner.length };
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
