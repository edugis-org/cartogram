import { describe, expect, it } from 'vitest';
import { laea, cylindricalEqualArea, chooseProjection } from '../src/io/project.ts';
import { pack } from '../src/geometry/flat.ts';
import { featureArea } from '../src/geometry/area.ts';
import type { AreaFeature } from '../src/types.ts';

const projections = [
  ['laea', laea(5, 52)],
  ['cylindrical-equal-area', cylindricalEqualArea(0)],
] as const;

describe('projections', () => {
  for (const [name, p] of projections) {
    it(`${name} inverts its own forward transform`, () => {
      for (const [lon, lat] of [[5, 52], [0, 0], [-120, -35], [179, 60], [10, -80]]) {
        const [x, y] = p.forward(lon!, lat!);
        const [lon2, lat2] = p.inverse(x, y);
        expect(lon2).toBeCloseTo(lon!, 8);
        expect(lat2).toBeCloseTo(lat!, 8);
      }
    });
  }

  it('preserves relative area: two equal-area spherical caps project to equal areas', () => {
    // Two 1-degree-tall bands of equal spherical area, at different latitudes.
    // An equal-area projection must give them the same planar area; a conformal
    // one would not. This is the property the whole library depends on.
    const band = (lat0: number, dLat: number) => {
      const ring = [
        [-2, lat0],
        [2, lat0],
        [2, lat0 + dLat],
        [-2, lat0 + dLat],
        [-2, lat0],
      ];
      return {
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'Polygon' as const, coordinates: [ring] },
      } as AreaFeature;
    };
    // Equal spherical area bands: area ~ sin(lat1) - sin(lat0).
    const d0 = 1;
    const lat1 = 50;
    const target = Math.sin((0 + d0) * (Math.PI / 180)) - Math.sin(0);
    const dLat1 =
      (Math.asin(Math.sin((lat1 * Math.PI) / 180) + target) * 180) / Math.PI - lat1;

    const p = cylindricalEqualArea(0);
    const g = pack([band(0, d0), band(lat1, dLat1)]);
    for (let i = 0; i < g.coords.length; i += 2) {
      const [x, y] = p.forward(g.coords[i]!, g.coords[i + 1]!);
      g.coords[i] = x;
      g.coords[i + 1] = y;
    }
    const a0 = featureArea(g, 0);
    const a1 = featureArea(g, 1);
    expect(a1 / a0).toBeCloseTo(1, 3);
  });

  it('auto picks cylindrical equal-area for global extents and laea for regional ones', () => {
    const world = pack([
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[-170, -60], [170, -60], [170, 70], [-170, 70], [-170, -60]]],
        },
      } as AreaFeature,
    ]);
    const region = pack([
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[3, 50], [7, 50], [7, 54], [3, 54], [3, 50]]],
        },
      } as AreaFeature,
    ]);
    expect(chooseProjection(world, 'auto').name).toBe('cylindrical-equal-area');
    expect(chooseProjection(region, 'auto').name).toBe('laea');
  });

  it('auto leaves already-projected coordinates alone', () => {
    const planar = pack([
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [1e6, 0], [1e6, 1e6], [0, 1e6], [0, 0]]],
        },
      } as AreaFeature,
    ]);
    expect(chooseProjection(planar, 'auto').name).toBe('none');
    expect(() => chooseProjection(planar, 'laea')).toThrow(/requires lon\/lat/);
  });
});
