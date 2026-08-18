import type { FlatGeometry } from '../geometry/flat.ts';
import { featureCentroid } from '../geometry/area.ts';

export interface OrientationMetrics {
  /** Spearman rank correlation of feature centroid x before and after. 1 = order kept. */
  x: number;
  y: number;
  /** Mean of the two, as a single "is the geography still there" number. */
  mean: number;
}

/**
 * Relative-position preservation, one of the standard cartogram measures
 * (Nusrat & Kobourov 2016).
 *
 * A cartogram may legitimately move every region a long way, so comparing absolute
 * positions is meaningless. What must survive is the *ordering*: if Groningen was
 * north of Limburg it had better still be. Spearman rank correlation of the centroid
 * coordinates captures exactly that and is invariant to the overall scaling and
 * translation the transform applies.
 *
 * This matters most for the methods that discard shape entirely -- a Dorling cartogram
 * is only readable because the circles stay roughly where the regions were.
 */
export function orientationPreservation(
  before: FlatGeometry,
  after: FlatGeometry,
): OrientationMetrics {
  const n = Math.min(before.featCount, after.featCount);
  if (n < 2) return { x: 1, y: 1, mean: 1 };

  const bx = new Float64Array(n);
  const by = new Float64Array(n);
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const [x0, y0] = featureCentroid(before, f);
    const [x1, y1] = featureCentroid(after, f);
    bx[f] = x0;
    by[f] = y0;
    ax[f] = x1;
    ay[f] = y1;
  }

  const x = spearman(bx, ax);
  const y = spearman(by, ay);
  return { x, y, mean: (x + y) / 2 };
}

function spearman(a: Float64Array, b: Float64Array): number {
  return pearson(ranks(a), ranks(b));
}

/** Average ranks, so ties do not bias the correlation. */
function ranks(v: Float64Array): Float64Array {
  const n = v.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => v[i]! - v[j]!);
  const r = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && v[idx[j + 1]!]! === v[idx[i]!]!) j++;
    const shared = (i + j) / 2;
    for (let k = i; k <= j; k++) r[idx[k]!] = shared;
    i = j + 1;
  }
  return r;
}

function pearson(a: Float64Array, b: Float64Array): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 1 : num / den;
}
