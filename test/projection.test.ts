import { describe, expect, it } from 'vitest';
import { laea, equalEarth, cylindricalEqualArea, chooseProjection } from '../src/io/project.ts';
import { pack } from '../src/geometry/flat.ts';
import { featureArea } from '../src/geometry/area.ts';
import type { AreaFeature } from '../src/types.ts';

const projections = [
  ['laea', laea(5, 52)],
  ['equal-earth', equalEarth(0)],
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

  it('auto picks Equal Earth for global extents and laea for regional ones', () => {
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
    expect(chooseProjection(world, 'auto').name).toBe('equal-earth');
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

/**
 * Equal Earth is the plane a world cartogram is warped in, so two things about it are
 * load-bearing: its areas have to be the sphere's areas, and its inverse has to answer
 * for points the warp pushed past the pole line rather than returning NaN.
 */
describe('Equal Earth', () => {
  const R = 6371008.8;
  const p = equalEarth(0);

  /** True area of a lon/lat box on the sphere, m^2. */
  function sphericalArea(west: number, south: number, east: number, north: number): number {
    const d = Math.PI / 180;
    return R * R * (east - west) * d * (Math.sin(north * d) - Math.sin(south * d));
  }

  /** Area of the same box in the plane, by shoelace on a densified outline. */
  function planarArea(west: number, south: number, east: number, north: number): number {
    const ring: number[][] = [];
    const step = 0.25;
    for (let lon = west; lon < east; lon += step) ring.push(p.forward(lon, south));
    for (let lat = south; lat < north; lat += step) ring.push(p.forward(east, lat));
    for (let lon = east; lon > west; lon -= step) ring.push(p.forward(lon, north));
    for (let lat = north; lat > south; lat -= step) ring.push(p.forward(west, lat));
    ring.push(ring[0]!);
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      sum += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
    }
    return Math.abs(sum / 2);
  }

  it('gives every region its area on the sphere, from the equator to the pole', () => {
    for (const [w, s, e, n] of [
      [-20, -5, 20, 5],
      [-20, 40, 20, 50],
      [-20, 75, 20, 85],
      [-180, -90, 180, 90],
    ]) {
      const want = sphericalArea(w!, s!, e!, n!);
      const got = planarArea(w!, s!, e!, n!);
      expect(Math.abs(got - want) / want).toBeLessThan(1e-3);
    }
  });

  it('spreads the polar stretch instead of concentrating it', () => {
    // The reason it is preferred over cylindrical for world data. A 10-degree band at
    // 80 north is drawn by the cylindrical projection as a slab five times wider than
    // it is tall, which a square grid cell cannot follow; Equal Earth's meridians curve
    // in, so the same band keeps a shape a cell can resolve.
    const aspect = (proj: ReturnType<typeof equalEarth>): number => {
      const a = proj.forward(-20, 75);
      const b = proj.forward(20, 75);
      const c = proj.forward(-20, 85);
      return Math.abs(b[0] - a[0]) / Math.abs(c[1] - a[1]);
    };
    expect(aspect(p)).toBeLessThan(aspect(cylindricalEqualArea(0)) / 1.5);
  });

  it('answers for a point pushed past the pole line rather than returning NaN', () => {
    // What `fitLatitude` relies on: a warp can push a vertex above the top of the plane,
    // and the fit finds its scale by asking the inverse for the latitude there. A NaN
    // would break the search silently; a clamped 90 makes it shrink, which is right.
    const [, top] = p.forward(0, 90);
    for (const beyond of [top * 1.01, top * 1.5, top * 3]) {
      const [lon, lat] = p.inverse(0, beyond);
      expect(Number.isFinite(lon)).toBe(true);
      expect(lat).toBeCloseTo(90, 6);
    }
  });

  it('is centred where it is asked to be', () => {
    const shifted = equalEarth(150);
    expect(shifted.forward(150, 0)[0]).toBeCloseTo(0, 6);
    // And a point across the antimeridian from the centre stays on the near side.
    expect(shifted.forward(-170, 0)[0]).toBeGreaterThan(0);
  });
});
