import { describe, expect, it } from 'vitest';
import { cartogram } from '../src/index.ts';
import { fc, squareFeature, load, has } from './helpers.ts';
import type { CartogramResult } from '../src/types.ts';

/** A contiguous n x n grid of unit cells with the given values. */
function grid(values: number[][]) {
  const features = [];
  for (let j = 0; j < values.length; j++) {
    for (let i = 0; i < values[j]!.length; i++) {
      features.push(squareFeature(`c${i}-${j}`, i, j, 1, values[j]![i]!));
    }
  }
  return fc(features);
}

const run = (input: ReturnType<typeof fc>, opts: Record<string, unknown> = {}): CartogramResult =>
  cartogram(input, { method: 'dcn', value: 'value', projection: 'none', ...opts } as never);

describe('DCN contiguous cartogram', () => {
  it('moves areas towards their targets', () => {
    const before = run(grid([[1, 1], [1, 8]]), { iterations: 0 });
    const after = run(grid([[1, 1], [1, 8]]));
    expect(after.metrics.areaError.mean).toBeLessThan(before.metrics.areaError.mean / 2);
  });

  it('keeps every shared border welded (F18)', () => {
    // The whole point of a contiguous cartogram. Adjacency must survive exactly:
    // not "mostly", since one torn border is a visible hole in the map.
    const r = run(grid([[1, 4, 1], [6, 1, 3], [1, 2, 9]]));
    expect(r.metrics.topology!.error).toBe(0);
    expect(r.metrics.topology!.sharedEdges).toBe(r.metrics.topology!.inputEdges);
  });

  it('does not round regions into blobs (F20a)', () => {
    const r = run(grid([[1, 4, 1], [6, 1, 3], [1, 2, 9]]));
    const shape = r.metrics.shape!;
    expect(shape.meanCompactnessDrift).toBeLessThan(0.05);
    expect(shape.fractionRounder).toBeLessThan(0.7);
  });

  it('densifies before warping, and reports it', () => {
    const r = run(grid([[1, 8], [8, 1]]));
    expect(r.metrics.densification!.inserted).toBeGreaterThan(0);
    // Baseline is the densified input, so it aligns with the output vertex for vertex.
    expect(r.baseline).toBeUndefined();
    const withBaseline = run(grid([[1, 8], [8, 1]]), { includeBaseline: true });
    expect(withBaseline.baseline!.features).toHaveLength(4);
  });

  it('can be told not to densify', () => {
    const r = run(grid([[1, 8], [8, 1]]), { densify: false });
    expect(r.metrics.densification).toBeUndefined();
  });

  it('reports convergence and stops at the error target', () => {
    const r = run(grid([[1, 2], [2, 1]]), { targetError: 0.25 });
    expect(r.iteration!.converged).toBe(true);
    expect(r.iteration!.meanError).toBeLessThanOrEqual(0.25);
    expect(r.iteration!.iterations).toBeLessThan(60);
  });

  it('never folds a ring inside out (F19)', () => {
    // Extreme ratio: the neighbours of a 500x region are the ones that fold.
    const r = run(grid([[500, 1, 1], [1, 1, 1], [1, 1, 1]]));
    for (const f of r.featureCollection.features) {
      const ring = (f.geometry as { coordinates: number[][][] }).coordinates[0]!;
      let sum = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        sum += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
      }
      expect(sum).toBeGreaterThan(0); // all rings keep their original orientation
    }
  });

  it('reports progress and honours cancellation (F17)', () => {
    const seen: number[] = [];
    run(grid([[1, 9], [9, 1]]), { onIteration: (i: number, e: number) => seen.push(e) });
    expect(seen.length).toBeGreaterThan(1);
    // Error decreases monotonically in the common case; assert the overall direction.
    expect(seen[seen.length - 1]!).toBeLessThan(seen[0]!);

    const controller = new AbortController();
    controller.abort();
    const stopped = run(grid([[1, 9], [9, 1]]), { signal: controller.signal });
    expect(stopped.iteration!.iterations).toBe(0);
  });

  it('is deterministic', () => {
    const input = grid([[1, 4], [7, 2]]);
    const a = run(input);
    const b = run(input);
    expect(JSON.stringify(a.featureCollection)).toBe(JSON.stringify(b.featureCollection));
  });

  it('survives zero values without destroying the map', () => {
    // A region worth nothing cannot literally vanish from a contiguous map; it is
    // floored to a minimum area, and its neighbours must stay intact.
    const r = run(grid([[0, 5], [5, 5]]));
    expect(r.metrics.topology!.error).toBe(0);
    expect(r.diagnostics[0]!.outputArea).toBeGreaterThan(0);
  });

  it('handles holes and multipolygons', () => {
    const input = fc([
      {
        type: 'Feature',
        properties: { value: 3 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
            [[3, 3], [3, 6], [6, 6], [6, 3], [3, 3]],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { value: 1 },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[[[10, 0], [14, 0], [14, 10], [10, 10], [10, 0]]], [[[20, 0], [22, 0], [22, 2], [20, 2], [20, 0]]]],
        },
      },
    ]);
    const r = run(input);
    expect(r.featureCollection.features[1]!.geometry!.type).toBe('MultiPolygon');
    expect(Number.isFinite(r.metrics.areaError.mean)).toBe(true);
  });
});

describe('DCN on real data', () => {
  const cases: [string, string, number][] = [
    // path, attribute, area-error ceiling this method is expected to reach
    ['data/real/nl-provinces.geojson', 'POP_2021', 0.03],
    ['data/real/nuts2-20m.geojson', 'POP_2021', 0.2],
    ['data/real/nl-municipalities.geojson', 'POP', 0.15],
  ];

  for (const [path, attr, ceiling] of cases) {
    it.skipIf(!has(path))(`${path} stays contiguous and reduces area error`, () => {
      const r = cartogram(load(path), {
        method: 'dcn',
        value: attr,
        missing: 'drop',
        negative: 'clamp',
      });
      // Contiguity is non-negotiable; area error is method-dependent and bounded here
      // at the level this method actually achieves, so a regression is visible.
      expect(r.metrics.topology!.error).toBeLessThan(0.01);
      expect(r.metrics.areaError.mean).toBeLessThan(ceiling);
      // Anti-blob guard: no systematic rounding.
      expect(r.metrics.shape!.meanCompactnessDrift).toBeLessThan(0.05);
    });
  }
});
