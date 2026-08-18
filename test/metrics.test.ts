import { describe, expect, it } from 'vitest';
import { pack } from '../src/geometry/flat.ts';
import { featureArea } from '../src/geometry/area.ts';
import { cartographicError } from '../src/metrics/area.ts';
import { topologyError, adjacency } from '../src/metrics/topology.ts';
import { compactness, shapePreservation } from '../src/metrics/shape.ts';
import { cartogram } from '../src/index.ts';
import { fc, squareFeature } from './helpers.ts';
import type { AreaFeature } from '../src/types.ts';

describe('cartographic error (Nusrat & Kobourov 2016)', () => {
  it('is zero when areas are exactly proportional', () => {
    const { summary } = cartographicError([1, 2, 3], [10, 20, 30]);
    expect(summary.mean).toBe(0);
    expect(summary.max).toBe(0);
  });

  it('uses max(o, w) as the denominator, so every term is bounded by 1', () => {
    // One region has all the value but almost none of the area: error -> 1, not 1e6.
    const { perFeature } = cartographicError([1e-6, 1], [1, 1e-6]);
    for (const e of perFeature) expect(e).toBeLessThanOrEqual(1);
    expect(perFeature[0]).toBeCloseTo(1, 5);
  });

  it('is symmetric in over- and under-representation', () => {
    const a = cartographicError([2, 1], [1, 2]).perFeature;
    const b = cartographicError([1, 2], [2, 1]).perFeature;
    expect(a[0]).toBeCloseTo(b[1]!, 12);
  });
});

describe('adjacency and topology error', () => {
  const grid = () =>
    pack([
      squareFeature('a', 0, 0, 1, 1),
      squareFeature('b', 1, 0, 1, 1),
      squareFeature('c', 0, 1, 1, 1),
    ] as AreaFeature[]);

  it('finds neighbours that share an edge', () => {
    const pairs = adjacency(grid());
    expect(pairs.has('0|1')).toBe(true); // a-b share x=1
    expect(pairs.has('0|2')).toBe(true); // a-c share y=1
    expect(pairs.has('1|2')).toBe(false); // b and c only touch at a corner
  });

  it('is zero for an unchanged map and one for a fully torn one', () => {
    const g = grid();
    expect(topologyError(g, g).error).toBe(0);

    const input = fc([squareFeature('a', 0, 0, 1, 1), squareFeature('b', 1, 0, 1, 3)]);
    const out = cartogram(input, { method: 'olson', value: 'value', projection: 'none' });
    // Olson is non-contiguous by design: every shared border is broken.
    expect(out.metrics.topology!.error).toBe(1);
  });
});

describe('shape preservation (anti-blob guard, F20a/F20b)', () => {
  it('gives compactness 1 for a circle and less for a ragged shape', () => {
    const circle = (n: number, r: number) => {
      const ring = Array.from({ length: n }, (_, i) => {
        const t = (2 * Math.PI * i) / n;
        return [r * Math.cos(t), r * Math.sin(t)];
      });
      return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] } } as AreaFeature;
    };
    expect(compactness(pack([circle(512, 1)]), 0)).toBeCloseTo(1, 4);
    expect(compactness(pack([squareFeature('s', 0, 0, 1, 1) as AreaFeature]), 0)).toBeCloseTo(Math.PI / 4, 6);
  });

  it('reports zero drift for a pure rescale, however large', () => {
    const before = pack([squareFeature('a', 0, 0, 1, 1) as AreaFeature]);
    const after = pack([squareFeature('a', 0, 0, 37, 1) as AreaFeature]);
    const s = shapePreservation(before, after);
    expect(s.meanCompactnessDrift).toBeCloseTo(0, 12);
    expect(s.meanDetailRetention).toBeCloseTo(1, 12);
  });

  it('detects a square being rounded into a circle', () => {
    // The exact failure mode requirement F20a exists to catch: same area, same
    // position, outline relaxed towards a circle.
    const sq = squareFeature('a', 0, 0, 2, 1) as AreaFeature;
    const n = 64;
    const r = 2 / Math.sqrt(Math.PI); // equal area
    const ring = Array.from({ length: n }, (_, i) => {
      const t = (2 * Math.PI * i) / n;
      return [1 + r * Math.cos(t), 1 + r * Math.sin(t)];
    });
    const blob = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] } } as AreaFeature;

    const s = shapePreservation(pack([sq]), pack([blob]));
    expect(s.meanCompactnessDrift).toBeGreaterThan(0.2); // clearly rounder
    expect(s.fractionRounder).toBe(1);
    expect(s.meanDetailRetention).toBeLessThan(1); // perimeter lost = detail lost
  });
});

describe('numerical precision', () => {
  it('computes areas accurately at projected world-map magnitudes', () => {
    // Regression test. Coordinates of order 1e7 m with a ring only ~1e4 m across:
    // a raw shoelace sum cancels away ~9 significant digits. The local-origin shift
    // in ringSignedArea is what keeps this exact.
    const ox = 1.2345e7;
    const oy = -8.7654e6;
    const size = 1e4;
    const g = pack([squareFeature('a', ox, oy, size, 1) as AreaFeature]);
    expect(featureArea(g, 0)).toBeCloseTo(size * size, 6);
    expect(Math.abs(featureArea(g, 0) / (size * size) - 1)).toBeLessThan(1e-12);
  });
});
