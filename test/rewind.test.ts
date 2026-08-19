import { describe, expect, it } from 'vitest';
import { rewind, isClockwise, ringSignedArea } from '../src/prepare/rewind.ts';
import { fc, squareFeature } from './helpers.ts';
import type { FeatureCollection, Position } from 'geojson';

const ringsOf = (out: FeatureCollection, i = 0): Position[][] =>
  (out.features[i]!.geometry as { coordinates: Position[][] }).coordinates;

describe('rewind', () => {
  const withHole = fc([
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], // counter-clockwise
          [[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]], // clockwise
        ],
      },
    },
  ]);

  it('rfc7946: outer counter-clockwise, holes clockwise', () => {
    const rings = ringsOf(rewind(withHole, 'rfc7946'));
    expect(isClockwise(rings[0]!)).toBe(false);
    expect(isClockwise(rings[1]!)).toBe(true);
  });

  it('clockwise: the reverse, which is what go_cart needs', () => {
    const rings = ringsOf(rewind(withHole, 'clockwise'));
    expect(isClockwise(rings[0]!)).toBe(true);
    expect(isClockwise(rings[1]!)).toBe(false);
  });

  it('preserves area and vertex count, only the order changes', () => {
    const before = ringsOf(withHole);
    const after = ringsOf(rewind(withHole, 'clockwise'));
    for (let i = 0; i < before.length; i++) {
      expect(after[i]!.length).toBe(before[i]!.length);
      expect(Math.abs(ringSignedArea(after[i]!))).toBeCloseTo(Math.abs(ringSignedArea(before[i]!)), 9);
    }
  });

  it('is idempotent', () => {
    const once = rewind(withHole, 'clockwise');
    expect(JSON.stringify(rewind(once, 'clockwise'))).toBe(JSON.stringify(once));
  });

  it('handles multipolygons, each part independently', () => {
    const mp = fc([
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
            [[[5, 5], [5, 6], [6, 6], [6, 5], [5, 5]]],
          ],
        },
      },
    ]);
    const out = (rewind(mp, 'clockwise').features[0]!.geometry as { coordinates: Position[][][] }).coordinates;
    for (const poly of out) expect(isClockwise(poly[0]!)).toBe(true);
  });

  it('leaves non-areal geometry and null geometry alone', () => {
    const mixed = fc([
      squareFeature('a', 0, 0, 1, 1),
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } },
      { type: 'Feature', properties: {}, geometry: null },
    ]);
    const out = rewind(mixed, 'clockwise');
    expect(out.features[1]!.geometry).toEqual(mixed.features[1]!.geometry);
    expect(out.features[2]!.geometry).toBeNull();
  });
});
