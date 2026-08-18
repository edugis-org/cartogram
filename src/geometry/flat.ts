import type { Position } from 'geojson';
import type { AreaFeature, AreaGeometry } from '../types.ts';

/**
 * Flat, allocation-friendly geometry representation.
 *
 * All coordinates of the whole collection live in one interleaved Float64Array
 * (`coords` = [x0, y0, x1, y1, ...]). Rings, polygons and features are described by
 * index ranges into that array. This is what makes the transform loops fast, makes
 * the buffer transferable to a Web Worker, and lets every method treat "warp the map"
 * as a single pass over one array.
 *
 * Ring closure: the input's duplicated final vertex is NOT stored. A ring of n stored
 * vertices is implicitly closed. GeoJSON closure is restored on the way out.
 */
export interface FlatGeometry {
  /** Interleaved x,y pairs. Length = 2 * vertexCount. */
  coords: Float64Array;
  /** ringStart[r] = index of ring r's first *vertex* (not its first coordinate). */
  ringStart: Uint32Array;
  /** ringStart has ringCount + 1 entries; the last is the total vertex count. */
  ringCount: number;
  /** polyStart[p] = first ring of polygon p. Ring 0 of a polygon is its outer ring. */
  polyStart: Uint32Array;
  polyCount: number;
  /** featStart[f] = first polygon of feature f. */
  featStart: Uint32Array;
  featCount: number;
  /** Original geometry type per feature, so the output keeps the input's type. */
  featType: ('Polygon' | 'MultiPolygon')[];
}

export function vertexCount(g: FlatGeometry): number {
  return g.coords.length >>> 1;
}

/** Vertex index range [start, end) of ring r. */
export function ringRange(g: FlatGeometry, r: number): [number, number] {
  return [g.ringStart[r]!, g.ringStart[r + 1]!];
}

/**
 * Is a ring "closed" in GeoJSON terms, i.e. does its last position repeat the first?
 * Tolerant of the exact-equality convention only, as RFC 7946 requires.
 */
function isClosed(ring: Position[]): boolean {
  if (ring.length < 2) return false;
  const a = ring[0]!;
  const b = ring[ring.length - 1]!;
  return a[0] === b[0] && a[1] === b[1];
}

export class GeometryError extends Error {}

/**
 * Pack an array of Polygon/MultiPolygon features into flat buffers.
 * Throws GeometryError on structurally invalid input; does not attempt repair.
 */
export function pack(features: AreaFeature[]): FlatGeometry {
  const ringStarts: number[] = [];
  const polyStarts: number[] = [];
  const featStarts: number[] = [];
  const featType: ('Polygon' | 'MultiPolygon')[] = [];
  const xs: number[] = [];

  let nVerts = 0;
  let nRings = 0;
  let nPolys = 0;

  for (const f of features) {
    const geom = f.geometry as AreaGeometry;
    featStarts.push(nPolys);
    featType.push(geom.type);
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) {
      polyStarts.push(nRings);
      nPolys++;
      if (poly.length === 0) throw new GeometryError('polygon with no rings');
      for (const ring of poly) {
        // Drop the repeated closing vertex; keep everything else verbatim.
        const n = isClosed(ring) ? ring.length - 1 : ring.length;
        if (n < 3) throw new GeometryError(`ring with ${n} distinct vertices (need >= 3)`);
        ringStarts.push(nVerts);
        nRings++;
        for (let i = 0; i < n; i++) {
          const p = ring[i]!;
          const x = p[0] as number;
          const y = p[1] as number;
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new GeometryError(`non-finite coordinate [${x}, ${y}]`);
          }
          xs.push(x, y);
          nVerts++;
        }
      }
    }
  }
  ringStarts.push(nVerts);
  polyStarts.push(nRings);
  featStarts.push(nPolys);

  return {
    coords: Float64Array.from(xs),
    ringStart: Uint32Array.from(ringStarts),
    ringCount: nRings,
    polyStart: Uint32Array.from(polyStarts),
    polyCount: nPolys,
    featStart: Uint32Array.from(featStarts),
    featCount: features.length,
    featType,
  };
}

/** Rebuild GeoJSON geometries from flat buffers, restoring ring closure. */
export function unpack(g: FlatGeometry): AreaGeometry[] {
  const out: AreaGeometry[] = [];
  for (let f = 0; f < g.featCount; f++) {
    const polys: Position[][][] = [];
    for (let p = g.featStart[f]!; p < g.featStart[f + 1]!; p++) {
      const rings: Position[][] = [];
      for (let r = g.polyStart[p]!; r < g.polyStart[p + 1]!; r++) {
        const [s, e] = ringRange(g, r);
        const ring: Position[] = new Array(e - s + 1);
        for (let v = s; v < e; v++) ring[v - s] = [g.coords[2 * v]!, g.coords[2 * v + 1]!];
        ring[e - s] = ring[0]!.slice() as Position; // close
        rings.push(ring);
      }
      polys.push(rings);
    }
    out.push(
      g.featType[f] === 'Polygon'
        ? { type: 'Polygon', coordinates: polys[0]! }
        : { type: 'MultiPolygon', coordinates: polys },
    );
  }
  return out;
}

/** Deep-ish copy sharing nothing mutable with the source. */
export function cloneCoords(g: FlatGeometry): FlatGeometry {
  return { ...g, coords: g.coords.slice() };
}
