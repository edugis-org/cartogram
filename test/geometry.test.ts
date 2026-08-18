import { describe, expect, it } from 'vitest';
import { pack, unpack, GeometryError } from '../src/geometry/flat.ts';
import { featureArea, featureCentroid, bbox } from '../src/geometry/area.ts';
import { squareFeature, square } from './helpers.ts';
import type { AreaFeature } from '../src/types.ts';

describe('flat geometry', () => {
  it('round-trips a Polygon losslessly', () => {
    const f = squareFeature('a', 0, 0, 2, 1) as AreaFeature;
    const g = pack([f]);
    const out = unpack(g)[0]!;
    expect(out).toEqual(f.geometry);
  });

  it('round-trips a MultiPolygon with a hole losslessly', () => {
    const geom = {
      type: 'MultiPolygon' as const,
      coordinates: [
        [square(0, 0, 10), square(2, 2, 3).slice().reverse()],
        [square(20, 0, 4)],
      ],
    };
    const f = { type: 'Feature' as const, properties: {}, geometry: geom } as AreaFeature;
    const out = unpack(pack([f]))[0]!;
    expect(out).toEqual(geom);
  });

  it('accepts unclosed rings and closes them on output', () => {
    const open = [[0, 0], [4, 0], [4, 4], [0, 4]];
    const f = {
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'Polygon' as const, coordinates: [open] },
    } as AreaFeature;
    const out = unpack(pack([f]))[0]!;
    expect((out as any).coordinates[0]).toEqual([...open, [0, 0]]);
  });

  it('rejects degenerate rings and non-finite coordinates', () => {
    const bad = (coords: number[][]) =>
      pack([
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [coords] },
        } as AreaFeature,
      ]);
    expect(() => bad([[0, 0], [1, 1], [0, 0]])).toThrow(GeometryError);
    expect(() => bad([[0, 0], [1, 0], [NaN, 1], [0, 0]])).toThrow(GeometryError);
  });
});

describe('area and centroid', () => {
  it('computes the area of a square', () => {
    expect(featureArea(pack([squareFeature('a', 0, 0, 3, 1) as AreaFeature]), 0)).toBeCloseTo(9, 12);
  });

  it('subtracts holes', () => {
    const geom = {
      type: 'Polygon' as const,
      coordinates: [square(0, 0, 10), square(2, 2, 3).slice().reverse()],
    };
    const g = pack([{ type: 'Feature', properties: {}, geometry: geom } as AreaFeature]);
    expect(featureArea(g, 0)).toBeCloseTo(100 - 9, 10);
  });

  it('is insensitive to ring winding order', () => {
    const cw = { type: 'Polygon' as const, coordinates: [square(0, 0, 5).slice().reverse()] };
    const g = pack([{ type: 'Feature', properties: {}, geometry: cw } as AreaFeature]);
    expect(featureArea(g, 0)).toBeCloseTo(25, 12);
  });

  it('sums the parts of a MultiPolygon', () => {
    const geom = {
      type: 'MultiPolygon' as const,
      coordinates: [[square(0, 0, 2)], [square(50, 50, 3)]],
    };
    const g = pack([{ type: 'Feature', properties: {}, geometry: geom } as AreaFeature]);
    expect(featureArea(g, 0)).toBeCloseTo(4 + 9, 12);
  });

  it('centres a square centroid', () => {
    const g = pack([squareFeature('a', 10, 20, 4, 1) as AreaFeature]);
    expect(featureCentroid(g, 0)).toEqual([12, 22]);
  });

  it('computes a bounding box', () => {
    const g = pack([squareFeature('a', -1, -2, 4, 1) as AreaFeature]);
    expect(bbox(g)).toEqual([-1, -2, 3, 2]);
  });
});
