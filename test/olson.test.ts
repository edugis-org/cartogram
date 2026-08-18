import { describe, expect, it } from 'vitest';
import { cartogram } from '../src/index.ts';
import { fc, squareFeature, load, has } from './helpers.ts';

describe('Olson non-contiguous cartogram', () => {
  it('makes areas exactly proportional to the values', () => {
    const input = fc([
      squareFeature('a', 0, 0, 10, 1),
      squareFeature('b', 20, 0, 10, 3),
      squareFeature('c', 40, 0, 10, 6),
    ]);
    const { diagnostics, metrics } = cartogram(input, { method: 'olson', value: 'value', projection: 'none' });
    const areas = diagnostics.map((d) => d.outputArea);
    expect(areas[1]! / areas[0]!).toBeCloseTo(3, 12);
    expect(areas[2]! / areas[0]!).toBeCloseTo(6, 12);
    expect(metrics.areaError.max).toBeLessThan(1e-12);
  });

  it('preserves total area with fit: total', () => {
    const input = fc([squareFeature('a', 0, 0, 10, 1), squareFeature('b', 20, 0, 10, 9)]);
    const { diagnostics } = cartogram(input, { method: 'olson', value: 'value', fit: 'total', projection: 'none' });
    const total = diagnostics.reduce((s, d) => s + d.outputArea, 0);
    expect(total).toBeCloseTo(200, 8);
  });

  it('never enlarges a region beyond its original size with fit: max', () => {
    const input = fc([squareFeature('a', 0, 0, 10, 1), squareFeature('b', 20, 0, 10, 9)]);
    const { diagnostics } = cartogram(input, { method: 'olson', value: 'value', fit: 'max', projection: 'none' });
    for (const d of diagnostics) expect(d.outputArea).toBeLessThanOrEqual(d.inputArea + 1e-9);
  });

  it('preserves shape exactly: it is a per-feature similarity transform', () => {
    const input = fc([squareFeature('a', 0, 0, 10, 1), squareFeature('b', 20, 0, 10, 4)]);
    const { metrics } = cartogram(input, { method: 'olson', value: 'value', projection: 'none' });
    // Anti-blob guard (F20a/F20b): no rounding, no smoothing, at all.
    expect(Math.abs(metrics.shape!.meanCompactnessDrift)).toBeLessThan(1e-12);
    expect(metrics.shape!.meanDetailRetention).toBeCloseTo(1, 12);
  });

  it('keeps the feature centroid fixed', () => {
    const input = fc([squareFeature('a', 0, 0, 10, 1), squareFeature('b', 20, 0, 10, 4)]);
    const out = cartogram(input, { method: 'olson', value: 'value', projection: 'none' });
    const ring = (out.featureCollection.features[0]!.geometry as any).coordinates[0] as number[][];
    const cx = ring.slice(0, 4).reduce((s, p) => s + p[0]!, 0) / 4;
    expect(cx).toBeCloseTo(5, 9);
  });

  it('handles holes: the hole scales with the feature', () => {
    const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const hole = [[3, 3], [3, 6], [6, 6], [6, 3], [3, 3]];
    const input = fc([
      { type: 'Feature', properties: { value: 1 }, geometry: { type: 'Polygon', coordinates: [outer, hole] } },
      squareFeature('b', 20, 0, 10, 2),
    ]);
    const { diagnostics, metrics } = cartogram(input, { method: 'olson', value: 'value', projection: 'none' });
    expect(metrics.areaError.max).toBeLessThan(1e-12);
    expect(diagnostics[1]!.outputArea / diagnostics[0]!.outputArea).toBeCloseTo(2, 10);
  });

  it('handles MultiPolygons as a single unit', () => {
    const input = fc([
      {
        type: 'Feature',
        properties: { value: 1 },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
            [[[50, 50], [52, 50], [52, 52], [50, 52], [50, 50]]],
          ],
        },
      },
      squareFeature('b', 100, 0, 10, 5),
    ]);
    const { metrics, featureCollection } = cartogram(input, { method: 'olson', value: 'value', projection: 'none' });
    expect(metrics.areaError.max).toBeLessThan(1e-12);
    expect(featureCollection.features[0]!.geometry!.type).toBe('MultiPolygon');
  });

  it('identity method returns the geometry unchanged', () => {
    const input = fc([squareFeature('a', 0, 0, 10, 1), squareFeature('b', 20, 0, 10, 9)]);
    const out = cartogram(input, { method: 'identity', value: 'value', projection: 'none' });
    expect(out.featureCollection.features[0]!.geometry).toEqual(input.features[0]!.geometry);
  });

  it('passes non-areal features through untouched and in place', () => {
    const point = { type: 'Feature', properties: { value: 1 }, geometry: { type: 'Point', coordinates: [1, 1] } };
    const input = fc([squareFeature('a', 0, 0, 10, 1), point, squareFeature('b', 20, 0, 10, 4)]);
    const out = cartogram(input, { method: 'olson', value: 'value', projection: 'none' });
    expect(out.featureCollection.features).toHaveLength(3);
    expect(out.featureCollection.features[1]!.geometry).toEqual(point.geometry);
    expect(out.warnings.join()).toMatch(/non-areal/);
  });

  it("removes features under missing: 'drop'", () => {
    const input = fc([
      squareFeature('a', 0, 0, 10, 1),
      { type: 'Feature', properties: { value: null }, geometry: { type: 'Polygon', coordinates: [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]] } },
    ]);
    const out = cartogram(input, { method: 'olson', value: 'value', missing: 'drop', projection: 'none' });
    expect(out.featureCollection.features).toHaveLength(1);
  });

  it('is deterministic', () => {
    const input = fc([squareFeature('a', 0, 0, 10, 1), squareFeature('b', 20, 0, 10, 7)]);
    const a = cartogram(input, { method: 'olson', value: 'value', projection: 'none' });
    const b = cartogram(input, { method: 'olson', value: 'value', projection: 'none' });
    expect(JSON.stringify(a.featureCollection)).toBe(JSON.stringify(b.featureCollection));
  });
});

/**
 * M1 exit criterion: Olson is an exact construction, so its area error is a hard
 * oracle for the whole pipeline. If value handling, projection, area computation or
 * the flat-buffer round-trip is wrong anywhere, these numbers move off zero.
 */
describe('M1 exit criterion: exact areas on every dataset', () => {
  const datasets: [string, string][] = [
    ['data/real/world-110m.geojson', 'POP_EST'],
    ['data/real/world-50m.geojson', 'POP_EST'],
    ['data/real/nuts0-20m.geojson', 'POP_2021'],
    ['data/real/nuts2-20m.geojson', 'POP_2021'],
    ['data/real/nuts2-03m.geojson', 'POP_2021'],
    ['data/real/nuts3-20m.geojson', 'POP_2021'],
    ['data/real/nl-provinces.geojson', 'POP_2021'],
    ['data/real/nl-municipalities.geojson', 'POP'],
    ['data/synthetic/grid.geojson', 'value'],
    ['data/synthetic/grid-large.geojson', 'value'],
    ['data/synthetic/hex.geojson', 'value'],
    ['data/synthetic/rings.geojson', 'value'],
    ['data/synthetic/archipelago.geojson', 'value'],
    ['data/synthetic/lod-1e2.geojson', 'value'],
    ['data/synthetic/lod-1e5.geojson', 'value'],
  ];

  for (const [path, prop] of datasets) {
    it.skipIf(!has(path))(`${path}`, () => {
      const out = cartogram(load(path), {
        method: 'olson',
        value: prop,
        missing: 'zero',
        negative: 'clamp',
      });
      expect(out.metrics.areaError.mean).toBeLessThan(1e-9);
      expect(out.metrics.areaError.max).toBeLessThan(1e-9);
      // Shapes are untouched by construction, so the anti-blob metrics must be clean
      // for every feature that did not collapse to zero area.
      expect(out.metrics.shape!.meanDetailRetention).toBeCloseTo(1, 6);
      expect(out.metrics.shape!.maxCompactnessDrift).toBeLessThan(1e-9);
    });
  }

  it('degenerate.geojson rejects missing values by default and survives with a policy', () => {
    const path = 'data/synthetic/degenerate.geojson';
    if (!has(path)) return;
    expect(() => cartogram(load(path), { method: 'olson', value: 'value', projection: 'none' })).toThrow();
    const out = cartogram(load(path), {
      method: 'olson',
      value: 'value',
      missing: 'zero',
      negative: 'clamp',
    });
    expect(out.metrics.areaError.mean).toBeLessThan(1e-9);
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});
