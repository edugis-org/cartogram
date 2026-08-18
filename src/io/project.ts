import type { ProjectionName } from '../types.ts';
import type { FlatGeometry } from '../geometry/flat.ts';
import { bbox } from '../geometry/area.ts';
import { looksLikeLonLat } from './validate.ts';

/** Mean Earth radius, metres. Only sets the unit of the working plane. */
const R = 6371008.8;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface Projection {
  name: ProjectionName;
  forward(lon: number, lat: number): [number, number];
  inverse(x: number, y: number): [number, number];
}

/** Identity: the input is already in a planar CRS. */
function identity(): Projection {
  return {
    name: 'none',
    forward: (x, y) => [x, y],
    inverse: (x, y) => [x, y],
  };
}

/**
 * Lambert azimuthal equal-area, spherical. Exact areas, low distortion near the
 * centre, so it is the right default for a regional map (a country, the EU).
 * Degenerates at the antipode of the centre, which is why it is not used for
 * near-global extents.
 */
export function laea(lon0: number, lat0: number): Projection {
  const l0 = lon0 * D2R;
  const p0 = lat0 * D2R;
  const sinP0 = Math.sin(p0);
  const cosP0 = Math.cos(p0);
  return {
    name: 'laea',
    forward(lon, lat) {
      const l = lon * D2R - l0;
      const p = lat * D2R;
      const sinP = Math.sin(p);
      const cosP = Math.cos(p);
      const cosL = Math.cos(l);
      let denom = 1 + sinP0 * sinP + cosP0 * cosP * cosL;
      // Guard the antipode: clamp instead of producing Infinity.
      if (denom <= 1e-12) denom = 1e-12;
      const k = R * Math.sqrt(2 / denom);
      return [k * cosP * Math.sin(l), k * (cosP0 * sinP - sinP0 * cosP * cosL)];
    },
    inverse(x, y) {
      const rho = Math.hypot(x, y);
      if (rho < 1e-12) return [lon0, lat0];
      const arg = Math.min(1, Math.max(-1, rho / (2 * R)));
      const c = 2 * Math.asin(arg);
      const sinC = Math.sin(c);
      const cosC = Math.cos(c);
      const lat = Math.asin(Math.min(1, Math.max(-1, cosC * sinP0 + (y * sinC * cosP0) / rho)));
      const lon = l0 + Math.atan2(x * sinC, rho * cosP0 * cosC - y * sinP0 * sinC);
      return [lon * R2D, lat * R2D];
    },
  };
}

/**
 * Lambert cylindrical equal-area with a chosen standard parallel. Exact areas
 * everywhere and no singularity, at the cost of severe shape distortion near the
 * poles. Used for world maps. Standard parallel 30 degrees (Behrmann) is a
 * reasonable shape compromise for populated latitudes.
 */
export function cylindricalEqualArea(lon0: number, standardParallel = 30): Projection {
  const l0 = lon0 * D2R;
  const cosS = Math.cos(standardParallel * D2R);
  return {
    name: 'cylindrical-equal-area',
    forward(lon, lat) {
      // Keep longitudes in [-180, 180) relative to the centre so the map does not
      // wrap; features crossing the antimeridian still split visually, as they do
      // in the source data.
      let l = lon * D2R - l0;
      while (l > Math.PI) l -= 2 * Math.PI;
      while (l < -Math.PI) l += 2 * Math.PI;
      return [R * l * cosS, (R * Math.sin(lat * D2R)) / cosS];
    },
    inverse(x, y) {
      const lon = (x / (R * cosS) + l0) * R2D;
      const s = Math.min(1, Math.max(-1, (y * cosS) / R));
      return [lon, Math.asin(s) * R2D];
    },
  };
}

/**
 * Pick a projection for this data. `auto` refuses to project data that is already
 * planar, and refuses LAEA for near-global extents where it degenerates.
 */
export function chooseProjection(g: FlatGeometry, requested: ProjectionName): Projection {
  if (requested === 'none') return identity();

  const [minX, minY, maxX, maxY] = bbox(g);
  const lonLat = looksLikeLonLat([minX, minY, maxX, maxY]);

  if (requested === 'auto' && !lonLat) return identity();
  if (!lonLat) {
    // Explicitly requested a geographic projection on non-geographic coordinates.
    throw new Error(
      `projection '${requested}' requires lon/lat input, but coordinates span ` +
        `[${minX}, ${minY}] .. [${maxX}, ${maxY}]`,
    );
  }

  const lon0 = (minX + maxX) / 2;
  const lat0 = (minY + maxY) / 2;
  const lonSpan = maxX - minX;

  if (requested === 'cylindrical-equal-area') return cylindricalEqualArea(lon0);
  if (requested === 'laea') return laea(lon0, lat0);
  return lonSpan > 180 ? cylindricalEqualArea(lon0) : laea(lon0, lat0);
}

/** Project every coordinate in place. */
export function projectInPlace(g: FlatGeometry, p: Projection): void {
  if (p.name === 'none') return;
  const c = g.coords;
  for (let i = 0; i < c.length; i += 2) {
    const [x, y] = p.forward(c[i]!, c[i + 1]!);
    c[i] = x;
    c[i + 1] = y;
  }
}

/** Unproject every coordinate in place. */
export function unprojectInPlace(g: FlatGeometry, p: Projection): void {
  if (p.name === 'none') return;
  const c = g.coords;
  for (let i = 0; i < c.length; i += 2) {
    const [x, y] = p.inverse(c[i]!, c[i + 1]!);
    c[i] = x;
    c[i + 1] = y;
  }
}
