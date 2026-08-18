import type { FlatGeometry } from '../geometry/flat.ts';
import { ringRange } from '../geometry/flat.ts';
import type { TopologyMetrics } from '../types.ts';

/**
 * Adjacency by shared undirected edges: two features are neighbours if some edge
 * (pair of consecutive vertices) appears in both, in either direction.
 *
 * This is exact for topologically clean data (NUTS, a tessellation) and is the same
 * notion the cartogram literature uses. It deliberately does not do geometric
 * intersection: features that merely touch at a rounding-error distance are not
 * neighbours, and no cartogram method should make them one.
 */
export function adjacency(g: FlatGeometry): Set<string> {
  const edgeOwner = new Map<string, number>();
  const pairs = new Set<string>();

  for (let f = 0; f < g.featCount; f++) {
    for (let p = g.featStart[f]!; p < g.featStart[f + 1]!; p++) {
      for (let r = g.polyStart[p]!; r < g.polyStart[p + 1]!; r++) {
        const [s, e] = ringRange(g, r);
        let xPrev = g.coords[2 * (e - 1)]!;
        let yPrev = g.coords[2 * (e - 1) + 1]!;
        for (let v = s; v < e; v++) {
          const x = g.coords[2 * v]!;
          const y = g.coords[2 * v + 1]!;
          const key = edgeKey(xPrev, yPrev, x, y);
          const owner = edgeOwner.get(key);
          if (owner === undefined) edgeOwner.set(key, f);
          else if (owner !== f) pairs.add(owner < f ? `${owner}|${f}` : `${f}|${owner}`);
          xPrev = x;
          yPrev = y;
        }
      }
    }
  }
  return pairs;
}

/** Direction-independent key for an edge. */
function edgeKey(x1: number, y1: number, x2: number, y2: number): string {
  return x1 < x2 || (x1 === x2 && y1 <= y2)
    ? `${x1},${y1},${x2},${y2}`
    : `${x2},${y2},${x1},${y1}`;
}

/**
 * Topological error per Nusrat & Kobourov (2016): 1 - |Ec n Em| / |Ec u Em|,
 * the Jaccard distance between the adjacency graphs of map and cartogram.
 */
export function topologyError(before: FlatGeometry, after: FlatGeometry): TopologyMetrics {
  const em = adjacency(before);
  const ec = adjacency(after);
  let shared = 0;
  for (const e of ec) if (em.has(e)) shared++;
  const union = em.size + ec.size - shared;
  return {
    error: union === 0 ? 0 : 1 - shared / union,
    inputEdges: em.size,
    outputEdges: ec.size,
    sharedEdges: shared,
  };
}
