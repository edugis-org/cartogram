import { describe, expect, it } from 'vitest';
import { cartogram } from '../src/index.ts';
import { fc, squareFeature, load, has } from './helpers.ts';
import type { CartogramResult } from '../src/types.ts';

const run = (input: ReturnType<typeof fc>, opts: Record<string, unknown> = {}): CartogramResult =>
  cartogram(input, {
    method: 'flow',
    value: 'value',
    projection: 'none',
    grid: 128,
    ...opts,
  } as never);

function grid(values: number[][]) {
  const features = [];
  for (let j = 0; j < values.length; j++) {
    for (let i = 0; i < values[j]!.length; i++) {
      features.push(squareFeature(`c${i}-${j}`, i, j, 1, values[j]![i]!));
    }
  }
  return fc(features);
}

describe('flow-based cartogram', () => {
  it('equalizes density: two regions reach the ratio of their values', () => {
    const two = fc([squareFeature('a', 0, 0, 1, 3), squareFeature('b', 1, 0, 1, 1)]);
    const r = run(two, { grid: 256, padding: 1 });
    const [a, b] = r.diagnostics.map((d) => d.outputArea);
    expect(a! / b!).toBeGreaterThan(2.7);
    expect(a! / b!).toBeLessThan(3.3);
  });

  it('keeps shared borders welded without any vertex bookkeeping (F18)', () => {
    // The force method needs an explicit vertex index for this. Here it is automatic:
    // one displacement field is applied to every point, so identical coordinates have
    // identical images whatever the field does.
    const r = run(grid([[1, 4, 1], [6, 1, 3], [1, 2, 9]]));
    expect(r.metrics.topology!.error).toBe(0);
  });

  it('rounds regions off markedly less than the force method', () => {
    // The reason this method is the quality target: nothing pushes a boundary radially
    // away from a centroid, so straight edges stay much straighter.
    const input = grid([[1, 6, 1], [6, 1, 6], [1, 6, 1]]);
    const flowResult = run(input, { grid: 256 });
    const dcnResult = cartogram(input, {
      method: 'dcn',
      value: 'value',
      projection: 'none',
    } as never);
    expect(flowResult.metrics.shape!.meanPositiveDrift).toBeLessThan(
      dcnResult.metrics.shape!.meanPositiveDrift,
    );
  });

  it('reports progress and honours cancellation (F17)', () => {
    const seen: number[] = [];
    run(grid([[1, 9], [9, 1]]), { onIteration: (_i: number, e: number) => seen.push(e) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]!).toBeLessThan(seen[0]!);

    const controller = new AbortController();
    controller.abort();
    const stopped = run(grid([[1, 9], [9, 1]]), { signal: controller.signal });
    expect(stopped.iteration!.iterations).toBe(0);
  });

  it('rejects a grid size that is not a power of two', () => {
    expect(() => run(grid([[1, 2]]), { grid: 100 })).toThrow(/power of two/);
  });

  it('is deterministic', () => {
    const input = grid([[1, 4], [7, 2]]);
    expect(JSON.stringify(run(input).featureCollection)).toBe(
      JSON.stringify(run(input).featureCollection),
    );
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

  it('survives zero values', () => {
    const r = run(grid([[0, 5], [5, 5]]));
    expect(r.metrics.topology!.error).toBe(0);
    expect(Number.isFinite(r.metrics.areaError.mean)).toBe(true);
  });
});

describe('flow on real data', () => {
  it.skipIf(!has('data/real/nl-provinces.geojson'))(
    'beats the force method on the Dutch provinces, in both area and rounding',
    () => {
      const input = load('data/real/nl-provinces.geojson');
      const opts = { value: 'POP_2021', missing: 'drop', negative: 'clamp' } as const;
      const flowResult = cartogram(input, { ...opts, method: 'flow', grid: 256 } as never);
      const dcnResult = cartogram(input, { ...opts, method: 'dcn' } as never);

      expect(flowResult.metrics.areaError.mean).toBeLessThan(0.02);
      expect(flowResult.metrics.areaError.mean).toBeLessThan(dcnResult.metrics.areaError.mean);
      expect(flowResult.metrics.shape!.meanPositiveDrift).toBeLessThan(
        dcnResult.metrics.shape!.meanPositiveDrift,
      );
      expect(flowResult.metrics.topology!.error).toBe(0);
    },
  );
});

describe('degenerate values do not destroy the map', () => {
  it('a zero-valued region shrinks hard but stays finite', () => {
    // Regression. The velocity is -grad(rho)/rho, so a region with density near zero
    // divides by near zero: with `missing: 'zero'` on NUTS 3 the Western Isles grew by
    // a factor of 296765 and flattened the rest of the map into a single line.
    const input = fc([
      squareFeature('a', 0, 0, 1, 0),
      squareFeature('b', 1, 0, 1, 5),
      squareFeature('c', 0, 1, 1, 5),
      squareFeature('d', 1, 1, 1, 5),
    ]);
    const r = cartogram(input, {
      method: 'flow',
      value: 'value',
      projection: 'none',
      grid: 128,
    } as never);

    const ratios = r.diagnostics.map((d) => d.outputArea / d.inputArea);
    for (const ratio of ratios) {
      expect(ratio).toBeGreaterThan(1e-4); // nothing collapses to a point
      expect(ratio).toBeLessThan(1e3); // and nothing is launched off the map
    }
    expect(ratios[0]!).toBeLessThan(1); // the worthless region does shrink
  });

  it('does not let a region shrink below what the grid can represent', () => {
    // Flooring the rasterized density each pass instead of the value once compounds:
    // the floor is re-applied to an already shrunken region every pass, which took the
    // UK regions down by thirteen orders of magnitude rather than the intended amount.
    const input = fc([
      squareFeature('a', 0, 0, 1, 0),
      squareFeature('b', 1, 0, 1, 1000),
      squareFeature('c', 0, 1, 1, 1000),
      squareFeature('d', 1, 1, 1, 1000),
    ]);
    const r = cartogram(input, {
      method: 'flow', value: 'value', projection: 'none', grid: 128, runs: 10,
    } as never);
    expect(r.diagnostics[0]!.outputArea / r.diagnostics[0]!.inputArea).toBeGreaterThan(1e-4);
  });
});

describe('the value floor cannot inflate a region', () => {
  it('a worthless region never grows past its own size because of flooring', () => {
    // Regression. The floor exists so a region smaller than a grid cell does not
    // compound away to nothing over successive passes, but flooring it *at* one cell
    // inflated anything smaller than a cell up to a full one. On NUTS 3 at grid 256
    // that took Tower Hamlets from 12 km2 to 21887 km2 -- a 1864-fold inflation of a
    // region with no data -- and did the same to 180 other British regions.
    const big = squareFeature('big', 0, 0, 100, 1000);
    const speck = squareFeature('speck', 10, 10, 0.4, 0); // far smaller than a cell
    const r = cartogram(fc([big, speck]), {
      method: 'flow', value: 'value', projection: 'none', grid: 64, runs: 4,
    } as never);

    const s = r.diagnostics.find((d) => d.id === 'speck')!;
    // It may shrink, and it may be nudged by its neighbour, but flooring must not
    // hand it a whole grid cell's worth of area.
    expect(s.outputArea / s.inputArea).toBeLessThan(20);
  });
});

describe('overall scale', () => {
  it('keeps the cartogram the same total size as the input map', () => {
    // A cartogram fixes relative areas; the absolute scale is free, and the warp drifts
    // — measured at 1.50x the input's total area on NUTS 2 before this was pinned.
    // Normalized area error cannot see it; a reader comparing against the original can.
    const input = grid([[1, 9, 1], [9, 1, 9], [1, 9, 1]]);
    const r = cartogram(input, {
      method: 'flow', value: 'value', projection: 'none', grid: 128,
      includeBaseline: true,
    } as never);

    const total = (fc: { features: { geometry: unknown }[] }) =>
      r.diagnostics.reduce((s, d) => s + d.outputArea, 0);
    const inputTotal = r.diagnostics.reduce((s, d) => s + d.inputArea, 0);
    expect(total(r.featureCollection as never) / inputTotal).toBeCloseTo(1, 2);
  });

  it('can be switched off', () => {
    const input = grid([[1, 9], [9, 1]]);
    const scaled = cartogram(input, {
      method: 'flow', value: 'value', projection: 'none', grid: 128,
      preserveTotalArea: false,
    } as never);
    // Relative areas are identical either way; only the overall size differs.
    const pinned = cartogram(input, {
      method: 'flow', value: 'value', projection: 'none', grid: 128,
    } as never);
    const ratio = (r: typeof pinned) => r.diagnostics[0]!.outputArea / r.diagnostics[1]!.outputArea;
    expect(ratio(scaled)).toBeCloseTo(ratio(pinned), 6);
  });
});
