import { describe, expect, it } from 'vitest';
import { cartogram } from '../src/index.ts';
import { load } from './helpers.ts';
import type { CartogramResult } from '../src/types.ts';

/**
 * A cartogram moves regions off the graticule they came from, and in a plane there is
 * nothing to stop that leaving the world. On world countries sized by population, India
 * and China grow enough to push Russia clean off the top of the map; the coordinates
 * that come back have latitudes at or past +-90, which is not a place. Unprojecting them
 * does not fail, it clamps -- quietly pressing hundreds of points onto the pole line.
 */

const world = load('data/real/world-110m.geojson');
const base = { method: 'flow' as const, value: 'POP_EST', missing: 'drop' as const, grid: 128, runs: 4 };

function points(result: CartogramResult): number[][] {
  const out: number[][] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') out.push(c as number[]);
    else c.forEach(walk);
  };
  for (const f of result.featureCollection.features) {
    walk((f.geometry as { coordinates?: unknown } | null)?.coordinates);
  }
  return out;
}

function latitudes(result: CartogramResult): { min: number; max: number; atPole: number } {
  const lats = points(result).map(p => p[1]!);
  return {
    min: Math.min(...lats),
    max: Math.max(...lats),
    atPole: lats.filter(l => Math.abs(l) > 89.999).length,
  };
}

describe('fitting a cartogram back inside the world', () => {
  it('is needed: without it the map is pressed onto the pole line', () => {
    const raw = latitudes(cartogram(world, { ...base, fitLatitude: false }));
    expect(raw.max).toBeCloseTo(90, 3);
    expect(raw.min).toBeCloseTo(-90, 3);
    expect(raw.atPole).toBeGreaterThan(100);
  });

  it('brings every coordinate inside, by default', () => {
    const fitted = cartogram(world, base);
    const { min, max, atPole } = latitudes(fitted);
    expect(atPole).toBe(0);
    expect(max).toBeLessThanOrEqual(85);
    expect(min).toBeGreaterThanOrEqual(-85);
    expect(fitted.warnings.join(' ')).toMatch(/beyond 85 degrees/);
  });

  it('centres the result vertically rather than top-aligning it', () => {
    // The reason this is not just a scale. The centre of mass of world countries sits
    // well north of the equator, so scaling about it leaves the north jammed against
    // the limit and the south floating away from it. Centring shares the slack.
    const { min, max } = latitudes(cartogram(world, base));
    expect(Math.abs(max + min)).toBeLessThan(0.5);
  });

  it('changes the size, and nothing a cartogram is read for', () => {
    // A uniform scale is a similarity: relative areas, shape and topology are untouched,
    // which is what makes this an acceptable repair rather than a distortion of the
    // answer.
    const fitted = cartogram(world, base);
    const raw = cartogram(world, { ...base, fitLatitude: false });
    expect(fitted.metrics!.areaError.median).toBeCloseTo(raw.metrics!.areaError.median, 12);
    expect(fitted.metrics!.areaError.mean).toBeCloseTo(raw.metrics!.areaError.mean, 12);
    expect(fitted.metrics!.selfIntersections).toBe(raw.metrics!.selfIntersections);
  });

  it('costs less scale than top-aligning would', () => {
    // Centring is not only better looking, it is cheaper: the map is no longer being
    // pushed against one side of the band. Measured, the same cartogram needs 92% when
    // centred and 80% when scaled about the centre of mass.
    const factor = Number(
      /scaled to ([\d.]+)%/.exec(cartogram(world, base).warnings.join(' '))?.[1],
    );
    expect(factor).toBeGreaterThan(88);
    expect(factor).toBeLessThan(100);
  });

  it('leaves a map that never left the world exactly alone', () => {
    const nl = load('data/real/nl-provinces.geojson');
    const regional = { method: 'flow' as const, value: 'POP_2021', missing: 'mean' as const, grid: 256, runs: 3 };
    const withFit = cartogram(nl, regional);
    const without = cartogram(nl, { ...regional, fitLatitude: false });
    expect(withFit.featureCollection).toEqual(without.featureCollection);
    expect(withFit.warnings.join(' ')).not.toMatch(/latitude/);
  });

  it('honours a limit the caller chooses', () => {
    for (const limit of [60, 75]) {
      const { min, max } = latitudes(cartogram(world, { ...base, fitLatitude: limit }));
      expect(max).toBeLessThanOrEqual(limit);
      expect(min).toBeGreaterThanOrEqual(-limit);
      expect(Math.abs(max + min)).toBeLessThan(0.5);
    }
  });

  it('does not apply to data that was already planar', () => {
    // No projection, no latitude to overflow. The option must not invent one.
    const planar = cartogram(world, { ...base, projection: 'none', fitLatitude: 85 });
    expect(planar.warnings.join(' ')).not.toMatch(/latitude/);
  });
});
