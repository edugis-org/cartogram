import { describe, expect, it } from 'vitest';
import { pack } from '../src/geometry/flat.ts';
import { buildVertexIndex, scatter, sharedFraction } from '../src/topology/vertices.ts';
import { densify, autoSpacing } from '../src/topology/densify.ts';
import { featureArea, ringSignedArea } from '../src/geometry/area.ts';
import { adjacency } from '../src/metrics/topology.ts';
import { load, has, squareFeature } from './helpers.ts';
import type { AreaFeature } from '../src/types.ts';

const twoSquares = () =>
  pack([squareFeature('a', 0, 0, 1, 1), squareFeature('b', 1, 0, 1, 1)] as AreaFeature[]);

describe('vertex index', () => {
  it('collapses coincident vertices on a shared border', () => {
    const vi = buildVertexIndex(twoSquares());
    // 8 stored vertices, 2 of them shared -> 6 distinct.
    expect(vi.ids.length).toBe(8);
    expect(vi.count).toBe(6);
    expect(sharedFraction(vi)).toBeCloseTo(4 / 8, 12);
  });

  it('moving a unique vertex moves both features that use it', () => {
    const g = twoSquares();
    const vi = buildVertexIndex(g);
    for (let i = 0; i < vi.count; i++) vi.coords[2 * i]! += 10;
    scatter(g, vi);
    // The shared border stays welded: adjacency survives an arbitrary warp.
    expect(adjacency(g).has('0|1')).toBe(true);
  });

  it('real datasets have bit-identical shared borders', () => {
    // This is the assumption the whole welding strategy rests on, so it is asserted
    // rather than believed. If a dataset ever fails here, that method needs a
    // snapping tolerance instead.
    for (const path of ['data/real/nuts2-20m.geojson', 'data/real/nl-provinces.geojson']) {
      if (!has(path)) continue;
      const fc = load(path);
      const feats = fc.features.filter(
        (f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon',
      ) as AreaFeature[];
      expect(sharedFraction(buildVertexIndex(pack(feats)))).toBeGreaterThan(0.2);
    }
  });
});

describe('topology-preserving densification', () => {
  it('inserts vertices so no edge is longer than the spacing', () => {
    const g = pack([squareFeature('a', 0, 0, 10, 1) as AreaFeature]);
    const { geometry, inserted } = densify(g, 1);
    expect(inserted).toBeGreaterThan(0);
    const n = geometry.coords.length >>> 1;
    for (let v = 0; v < n; v++) {
      const w = (v + 1) % n;
      const len = Math.hypot(
        geometry.coords[2 * w]! - geometry.coords[2 * v]!,
        geometry.coords[2 * w + 1]! - geometry.coords[2 * v + 1]!,
      );
      expect(len).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('produces bit-identical points on both sides of a shared edge', () => {
    // The critical property. Two features share the edge (1,0)-(1,1) but traverse it
    // in opposite directions; a + (b-a)*t and b + (a-b)*(1-t) differ in floating
    // point, so without canonical edge ordering the shared border comes apart at
    // exactly the vertices densification just inserted.
    const g = densify(twoSquares(), 0.1).geometry;
    const vi = buildVertexIndex(g);
    const onBorder = [];
    for (let i = 0; i < vi.count; i++) if (vi.coords[2 * i] === 1) onBorder.push(i);
    // Every point inserted along x = 1 must be shared by both squares, not duplicated.
    for (const i of onBorder) expect(vi.multiplicity[i]!).toBeGreaterThan(1);
    expect(adjacency(g).has('0|1')).toBe(true);
  });

  it('preserves area, orientation and geometry structure', () => {
    const g = pack([squareFeature('a', 0, 0, 10, 1) as AreaFeature]);
    const before = featureArea(g, 0);
    const orientationBefore = Math.sign(ringSignedArea(g, 0));
    const { geometry } = densify(g, 0.7);
    expect(featureArea(geometry, 0)).toBeCloseTo(before, 6);
    expect(Math.sign(ringSignedArea(geometry, 0))).toBe(orientationBefore);
    expect(geometry.featCount).toBe(g.featCount);
    expect(geometry.ringCount).toBe(g.ringCount);
  });

  it('is a no-op when every edge is already short enough', () => {
    const g = pack([squareFeature('a', 0, 0, 1, 1) as AreaFeature]);
    const { geometry, inserted } = densify(g, 100);
    expect(inserted).toBe(0);
    expect(geometry.coords).toBe(g.coords);
  });

  it('coarsens rather than exploding when the spacing is absurdly fine', () => {
    const g = pack([squareFeature('a', 0, 0, 1000, 1) as AreaFeature]);
    const { geometry, spacing } = densify(g, 1e-6, 4);
    // The budget has a floor (small inputs must still densify usefully), so the cap
    // is max(4 x original, 4096) rather than 4 x original.
    expect(geometry.coords.length >>> 1).toBeLessThanOrEqual(4096 + 8);
    expect(spacing).toBeGreaterThan(1e-6);
  });

  it('derives a sane automatic spacing', () => {
    const g = pack([squareFeature('a', 0, 0, 400, 1) as AreaFeature]);
    const s = autoSpacing(g);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(400);
  });
});
