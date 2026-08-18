import { describe, expect, it } from 'vitest';
import { pack } from '../src/geometry/flat.ts';
import { selfIntersections } from '../src/metrics/validity.ts';
import { squareFeature } from './helpers.ts';
import type { AreaFeature } from '../src/types.ts';

const polygon = (ring: number[][]): AreaFeature =>
  ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }) as AreaFeature;

describe('self-intersection detection (F19)', () => {
  it('finds none in a simple polygon', () => {
    expect(selfIntersections(pack([squareFeature('a', 0, 0, 10, 1) as AreaFeature]))).toBe(0);
  });

  it('finds none in a polygon with a hole', () => {
    const g = pack([
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
            [[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]],
          ],
        },
      } as AreaFeature,
    ]);
    expect(selfIntersections(g)).toBe(0);
  });

  it('finds a bow-tie', () => {
    // The classic self-intersection: opposite corners swapped.
    expect(selfIntersections(pack([polygon([[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]])]))).toBeGreaterThan(0);
  });

  it('finds a local fold that leaves the winding intact', () => {
    // This is what the force method's orientation check cannot see: the ring still
    // winds the same way overall, but one section has folded back over itself.
    // A spike from the top edge punches down through the bottom edge. The ring still
    // winds the same way overall, so an orientation check sees nothing wrong.
    const ring = [
      [0, 0], [10, 0], [10, 10],
      [6, 10], [5, -5], [4, 10],
      [0, 10], [0, 0],
    ];
    expect(selfIntersections(pack([polygon(ring)]))).toBeGreaterThan(0);
  });

  it('does not count shared endpoints of consecutive segments', () => {
    // A convex ring has every consecutive pair touching at a vertex; none of that is
    // an intersection, and a naive test would report one per vertex.
    const n = 40;
    const ring = Array.from({ length: n }, (_, i) => {
      const t = (2 * Math.PI * i) / n;
      return [Math.cos(t), Math.sin(t)];
    });
    expect(selfIntersections(pack([polygon([...ring, ring[0]!])]))).toBe(0);
  });

  it('stops counting at the limit rather than grinding on', () => {
    const spikes: number[][] = [];
    for (let i = 0; i < 60; i++) spikes.push([i, i % 2 === 0 ? 0 : 10], [i + 0.5, i % 2 === 0 ? 10 : 0]);
    const count = selfIntersections(pack([polygon([...spikes, spikes[0]!])]), 5);
    expect(count).toBeLessThanOrEqual(5);
  });
});
