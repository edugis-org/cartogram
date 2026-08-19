import type { Feature, FeatureCollection, Position } from 'geojson';

export type Winding = 'rfc7946' | 'clockwise';

/**
 * Rewind polygon rings to a chosen convention.
 *
 * - `rfc7946` — outer rings counter-clockwise, holes clockwise. What the GeoJSON
 *   specification requires, and what most modern tools expect.
 * - `clockwise` — outer rings clockwise, holes counter-clockwise. The older
 *   shapefile-era convention, and what `go_cart` and its WebAssembly build require.
 *
 * This matters more than it should. Fed the wrong winding, `go_cart` computes a
 * perfectly good cartogram and then emits **empty geometry**, reporting that every
 * polygon in a region is a hole — a silent failure that looks like a data problem.
 * Natural Earth ships clockwise outer rings; the Dutch CBS data does not.
 *
 * This library's own methods do not need any of this: they take the ring with the
 * largest absolute area as the outer ring, so winding never affects a result.
 */
export function rewind(fc: FeatureCollection, winding: Winding = 'rfc7946'): FeatureCollection {
  const outerShouldBeClockwise = winding === 'clockwise';

  const fixPolygon = (poly: Position[][]): Position[][] =>
    poly.map((ring, index) => {
      const isOuter = index === 0;
      const wantClockwise = isOuter === outerShouldBeClockwise;
      return isClockwise(ring) === wantClockwise ? ring : [...ring].reverse();
    });

  return {
    ...fc,
    features: fc.features.map((f: Feature): Feature => {
      const g = f.geometry;
      if (!g) return f;
      if (g.type === 'Polygon') {
        return { ...f, geometry: { ...g, coordinates: fixPolygon(g.coordinates) } };
      }
      if (g.type === 'MultiPolygon') {
        return { ...f, geometry: { ...g, coordinates: g.coordinates.map(fixPolygon) } };
      }
      return f;
    }),
  };
}

/** Signed area by the shoelace formula; negative means clockwise. */
export function ringSignedArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    sum += a[0]! * b[1]! - b[0]! * a[1]!;
  }
  return sum / 2;
}

export function isClockwise(ring: Position[]): boolean {
  return ringSignedArea(ring) < 0;
}
