import { describe, expect, it } from 'vitest';
import { cartogram } from '../src/index.ts';
import { orientationPreservation } from '../src/metrics/orientation.ts';
import { pack } from '../src/geometry/flat.ts';
import { fc, squareFeature, load, has } from './helpers.ts';
import type { AreaFeature, CartogramResult } from '../src/types.ts';

function row(values: number[]) {
  return fc(values.map((v, i) => squareFeature(`c${i}`, i, 0, 1, v)));
}

const run = (input: ReturnType<typeof fc>, opts: Record<string, unknown> = {}): CartogramResult =>
  cartogram(input, { method: 'dorling', value: 'value', projection: 'none', ...opts } as never);

describe('Dorling / Demers', () => {
  it('makes symbol areas exactly proportional to the values', () => {
    const r = run(row([1, 2, 5, 9]));
    expect(r.metrics.areaError.max).toBeLessThan(1e-9);
    const areas = r.diagnostics.map((d) => d.outputArea);
    expect(areas[3]! / areas[0]!).toBeCloseTo(9, 6);
  });

  it('solves the polygon radius so the drawn shape has the exact area', () => {
    // A 64-gon inscribed in a circle is ~0.16% smaller than the circle. Using the
    // circle radius directly would show up as a systematic area error in the one
    // method whose selling point is exact areas.
    const coarse = run(row([1, 3]), { segments: 8 });
    expect(coarse.metrics.areaError.max).toBeLessThan(1e-9);
  });

  it('leaves no overlapping symbols', () => {
    const r = run(row([1, 5, 1, 8, 2, 9, 3]));
    expect(r.iteration!.overlaps).toBe(0);
  });

  it('preserves relative position (the only thing that makes it readable)', () => {
    const r = run(row([1, 4, 2, 8, 3]));
    expect(r.metrics.orientation!.mean).toBeGreaterThan(0.9);
  });

  it('replaces geometry with simple polygons', () => {
    const input = fc([
      {
        type: 'Feature',
        properties: { value: 2 },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]], [[[9, 9], [10, 9], [10, 10], [9, 10], [9, 9]]]],
        },
      },
      squareFeature('b', 3, 0, 1, 1),
    ]);
    const r = run(input);
    // A multipolygon collapses to one symbol: that is the method, not a bug.
    expect(r.featureCollection.features[0]!.geometry!.type).toBe('Polygon');
    expect(r.featureCollection.features).toHaveLength(2);
  });

  it('demers emits four-cornered squares', () => {
    const r = run(row([1, 4]), { method: 'demers' });
    const ring = (r.featureCollection.features[0]!.geometry as { coordinates: number[][][] }).coordinates[0]!;
    expect(ring).toHaveLength(5); // 4 corners + closing vertex
    expect(r.metrics.areaError.max).toBeLessThan(1e-9);
  });

  it('is expected to fail the anti-blob guard, by design', () => {
    // F20a makes these methods opt-in precisely because they discard shape. The
    // metric must still report it honestly rather than being suppressed for them.
    const r = run(row([1, 4, 9]));
    expect(r.metrics.shape!.fractionRounder).toBe(1);
    expect(r.metrics.shape!.meanCompactnessDrift).toBeGreaterThan(0.2);
  });

  it('separates coincident symbols instead of dividing by zero', () => {
    const geom = { type: 'Polygon' as const, coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
    const r = run(fc([
      { type: 'Feature', properties: { value: 1 }, geometry: geom },
      { type: 'Feature', properties: { value: 1 }, geometry: geom },
    ]));
    for (const f of r.featureCollection.features) {
      for (const p of (f.geometry as { coordinates: number[][][] }).coordinates[0]!) {
        expect(Number.isFinite(p[0]!)).toBe(true);
        expect(Number.isFinite(p[1]!)).toBe(true);
      }
    }
    expect(r.iteration!.overlaps).toBe(0);
  });

  it('does not run away when many symbols overlap at the start', () => {
    // Regression: repulsion is accumulated over every neighbour before being applied,
    // so a densely overlapped symbol used to receive dozens of corrections at once and
    // be flung away, compounding by ~1.5x per iteration until coordinates hit 1e36.
    const many = fc(
      Array.from({ length: 60 }, (_, i) =>
        squareFeature(`c${i}`, (i % 8) * 1.01, Math.floor(i / 8) * 1.01, 1, 1 + (i % 7) * 20),
      ),
    );
    const r = run(many, { fill: 0.5 });
    let maxCoord = 0;
    for (const f of r.featureCollection.features) {
      for (const p of (f.geometry as { coordinates: number[][][] }).coordinates[0]!) {
        maxCoord = Math.max(maxCoord, Math.abs(p[0]!), Math.abs(p[1]!));
      }
    }
    expect(maxCoord).toBeLessThan(1000); // the input spans ~8 units
    expect(r.iteration!.overlaps).toBe(0);
  });

  it('is deterministic', () => {
    const input = row([1, 4, 2, 7]);
    expect(JSON.stringify(run(input).featureCollection)).toBe(
      JSON.stringify(run(input).featureCollection),
    );
  });
});

describe('orientation metric', () => {
  it('is 1 for an unchanged map and survives uniform scaling', () => {
    const g = pack([squareFeature('a', 0, 0, 1, 1), squareFeature('b', 5, 5, 1, 1)] as AreaFeature[]);
    expect(orientationPreservation(g, g).mean).toBe(1);

    const scaled = pack([squareFeature('a', 0, 0, 2, 1), squareFeature('b', 10, 10, 2, 1)] as AreaFeature[]);
    expect(orientationPreservation(g, scaled).mean).toBeCloseTo(1, 12);
  });

  it('falls when the ordering is reversed', () => {
    const before = pack([
      squareFeature('a', 0, 0, 1, 1),
      squareFeature('b', 5, 0, 1, 1),
      squareFeature('c', 10, 0, 1, 1),
    ] as AreaFeature[]);
    const after = pack([
      squareFeature('a', 10, 0, 1, 1),
      squareFeature('b', 5, 0, 1, 1),
      squareFeature('c', 0, 0, 1, 1),
    ] as AreaFeature[]);
    expect(orientationPreservation(before, after).x).toBe(-1);
  });
});

describe('Dorling on real data', () => {
  const cases: [string, string][] = [
    ['data/real/nl-provinces.geojson', 'POP_2021'],
    ['data/real/nuts2-20m.geojson', 'POP_2021'],
    ['data/real/world-110m.geojson', 'POP_EST'],
  ];
  for (const [path, attr] of cases) {
    it.skipIf(!has(path))(`${path}: exact areas, no overlaps, geography intact`, () => {
      for (const method of ['dorling', 'demers'] as const) {
        const r = cartogram(load(path), { method, value: attr, missing: 'drop', negative: 'clamp' });
        expect(r.metrics.areaError.max, `${path} ${method} area`).toBeLessThan(1e-9);
        expect(r.iteration!.overlaps, `${path} ${method} overlaps`).toBe(0);
        expect(r.metrics.orientation!.mean, `${path} ${method} orientation`).toBeGreaterThan(0.9);
      }
    });
  }
});
