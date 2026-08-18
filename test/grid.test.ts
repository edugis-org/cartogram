import { describe, expect, it } from 'vitest';
import { pack } from '../src/geometry/flat.ts';
import { buildDensityGrid } from '../src/methods/diffusion/grid.ts';
import { squareFeature, fc, load, has } from './helpers.ts';
import type { AreaFeature } from '../src/types.ts';

describe('density grid', () => {
  it('rasterizes areas in proportion to true areas', () => {
    const g = pack([
      squareFeature('a', 0, 0, 10, 1),
      squareFeature('b', 10, 0, 5, 1),
    ] as AreaFeature[]);
    const grid = buildDensityGrid(g, Float64Array.from([1, 1]), 256, 1.4);
    let a = 0;
    let b = 0;
    for (const o of grid.owner) {
      if (o === 0) a++;
      else if (o === 1) b++;
    }
    // 100 vs 25 square units.
    expect(a / b).toBeCloseTo(4, 1);
  });

  it('handles holes: cells inside a hole belong to no feature', () => {
    const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const hole = [[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]];
    const g = pack([
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [outer, hole] } },
    ] as AreaFeature[]);
    const grid = buildDensityGrid(g, Float64Array.from([1]), 256, 1.2);
    let owned = 0;
    for (const o of grid.owner) if (o === 0) owned++;
    const cellArea = grid.h * grid.h;
    expect(owned * cellArea).toBeCloseTo(100 - 16, 0);
  });

  it('makes density proportional to value per unit area', () => {
    const g = pack([
      squareFeature('a', 0, 0, 10, 1),
      squareFeature('b', 10, 0, 10, 1),
    ] as AreaFeature[]);
    const grid = buildDensityGrid(g, Float64Array.from([1, 4]), 256, 1.3);
    const densityOf = (target: number) => {
      for (let i = 0; i < grid.owner.length; i++) if (grid.owner[i] === target) return grid.rho[i]!;
      return NaN;
    };
    expect(densityOf(1) / densityOf(0)).toBeCloseTo(4, 6);
  });

  it('normalizes to mean density 1 and gives the sea the mean density', () => {
    const g = pack([squareFeature('a', 0, 0, 10, 3)] as AreaFeature[]);
    const grid = buildDensityGrid(g, Float64Array.from([7]), 128, 2);
    let sum = 0;
    for (const v of grid.rho) sum += v;
    expect(sum / grid.rho.length).toBeCloseTo(1, 9);
    expect(grid.seaFraction).toBeGreaterThan(0.5);
  });

  it('rasterizes a real map without leaving holes in the interior', () => {
    const path = 'data/real/nl-provinces.geojson';
    if (!has(path)) return;
    const features = load(path).features as AreaFeature[];
    const g = pack(features);
    const values = Float64Array.from(features.map((f) => (f.properties as { POP_2021: number }).POP_2021 ?? 0));
    const grid = buildDensityGrid(g, values, 256, 1.4);
    let owned = 0;
    for (const o of grid.owner) if (o >= 0) owned++;
    expect(owned).toBeGreaterThan(1000);
    for (const v of grid.rho) expect(Number.isFinite(v)).toBe(true);
  });

  it('is deterministic', () => {
    const g = pack([squareFeature('a', 0, 0, 4, 1), squareFeature('b', 4, 0, 4, 1)] as AreaFeature[]);
    const v = Float64Array.from([2, 5]);
    const a = buildDensityGrid(g, v, 128, 1.5);
    const b = buildDensityGrid(g, v, 128, 1.5);
    expect(Array.from(a.rho)).toEqual(Array.from(b.rho));
  });
});

describe('features smaller than a grid cell', () => {
  it('gives every feature at least one cell', () => {
    // A feature smaller than a cell can fall between cell centres and own nothing,
    // contributing nothing to the density field: it exerts no pressure and is dragged
    // along by its neighbours. At grid 256, 674 of the 1333 NUTS 3 regions were in
    // that position, Paris among them -- 49 km^2 and 2.1 million people, coming out
    // smaller than it started.
    const big = squareFeature('big', 0, 0, 100, 1) as AreaFeature;
    const specks = Array.from({ length: 8 }, (_, i) =>
      squareFeature(`speck${i}`, 10 + i * 0.3, 10, 0.05, 1000) as AreaFeature,
    );
    const g = pack([big, ...specks]);
    const values = Float64Array.from([1, ...specks.map(() => 1000)]);
    const grid = buildDensityGrid(g, values, 64, 1.2);

    const counts = new Int32Array(g.featCount);
    for (const o of grid.owner) if (o >= 0) counts[o]!++;
    for (let f = 0; f < g.featCount; f++) {
      expect(counts[f], `feature ${f} owns no cell`).toBeGreaterThan(0);
    }
    expect(grid.underResolved).toBeGreaterThan(0);
  });

  it('never takes another feature\'s last cell', () => {
    const features = Array.from({ length: 20 }, (_, i) =>
      squareFeature(`f${i}`, i * 0.11, 0, 0.02, 1) as AreaFeature,
    );
    const g = pack(features);
    const grid = buildDensityGrid(g, Float64Array.from(features.map(() => 1)), 64, 1.2);
    const counts = new Int32Array(g.featCount);
    for (const o of grid.owner) if (o >= 0) counts[o]!++;
    for (let f = 0; f < g.featCount; f++) expect(counts[f]).toBeGreaterThan(0);
  });
});
