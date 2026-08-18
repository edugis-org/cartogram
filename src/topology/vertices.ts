import type { FlatGeometry } from '../geometry/flat.ts';

/**
 * Index of distinct coordinates across the whole collection.
 *
 * Shared borders in real data are bit-identical, not merely close: measured over the
 * datasets in `data/`, 23%-48% of stored vertices are duplicates of another feature's
 * vertex (69% on a synthetic tessellation). So welding shared borders needs no arc
 * extraction and no snapping tolerance -- collapsing exactly equal coordinates to one
 * moving point is enough, and it is exact.
 *
 * Every warp method must move *unique* vertices and then scatter the result back, or
 * neighbouring polygons drift apart along their shared border (requirement F18).
 *
 * Caveat, deliberately not papered over: this is exact equality. A dataset whose
 * boundaries were digitized independently per feature would have near-but-unequal
 * coordinates and would tear. That needs a snapping tolerance, which is only worth
 * adding once a dataset actually demonstrates the need.
 */
export interface VertexIndex {
  /** Number of distinct coordinates. */
  count: number;
  /** Distinct coordinates, interleaved x,y. Length = 2 * count. */
  coords: Float64Array;
  /** ids[v] = index into `coords` of stored vertex v. */
  ids: Uint32Array;
  /** How many stored vertices map to each unique one; > 1 means a shared border. */
  multiplicity: Uint32Array;
}

export function buildVertexIndex(g: FlatGeometry): VertexIndex {
  const n = g.coords.length >>> 1;
  const ids = new Uint32Array(n);
  const seen = new Map<string, number>();
  const xs: number[] = [];
  const ys: number[] = [];
  const mult: number[] = [];

  for (let v = 0; v < n; v++) {
    const x = g.coords[2 * v]!;
    const y = g.coords[2 * v + 1]!;
    const key = `${x},${y}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = xs.length;
      seen.set(key, id);
      xs.push(x);
      ys.push(y);
      mult.push(0);
    }
    ids[v] = id;
    mult[id]!++;
  }

  const coords = new Float64Array(xs.length * 2);
  for (let i = 0; i < xs.length; i++) {
    coords[2 * i] = xs[i]!;
    coords[2 * i + 1] = ys[i]!;
  }

  return { count: xs.length, coords, ids, multiplicity: Uint32Array.from(mult) };
}

/** Write the unique coordinates back onto every stored vertex that references them. */
export function scatter(g: FlatGeometry, vi: VertexIndex): void {
  const n = g.coords.length >>> 1;
  for (let v = 0; v < n; v++) {
    const id = vi.ids[v]!;
    g.coords[2 * v] = vi.coords[2 * id]!;
    g.coords[2 * v + 1] = vi.coords[2 * id + 1]!;
  }
}

/** Fraction of stored vertices that sit on a border shared with another ring. */
export function sharedFraction(vi: VertexIndex): number {
  const n = vi.ids.length;
  if (n === 0) return 0;
  let shared = 0;
  for (let i = 0; i < vi.count; i++) if (vi.multiplicity[i]! > 1) shared += vi.multiplicity[i]!;
  return shared / n;
}
