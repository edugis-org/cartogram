import { describe, expect, it } from 'vitest';
import { buildScene, labelOf } from '../harness/scene.ts';
import { DATASETS } from '../harness/datasets.ts';
import { effectiveT, geometryAt, morph } from '../harness/render.ts';
import { load, has, fc, squareFeature } from './helpers.ts';
import type { Feature } from 'geojson';

/**
 * The harness is how a human judges quality (requirement 4.2), so its own logic is
 * tested rather than only looked at. The critical invariant is that the "before" and
 * "after" geometries line up vertex for vertex; if they ever stop doing so, the morph
 * silently animates between mismatched features and every visual judgement made with
 * it is worthless.
 */
describe('review harness scene', () => {
  for (const d of DATASETS) {
    const path = d.url.replace(/^\//, '');
    it.skipIf(!has(path))(`builds a scene for ${d.label}`, () => {
      const { scene, result } = buildScene(load(path), {
        value: d.attributes[0]!,
        method: 'olson',
        missing: 'zero',
      });

      expect(scene.a.length).toBe(scene.b.length);
      expect(scene.errors.length).toBe(scene.geomA.featCount);
      expect(scene.ratios.length).toBe(scene.geomA.featCount);
      expect(scene.labels.length).toBe(scene.geomA.featCount);
      expect(result.diagnostics.length).toBe(scene.geomA.featCount);
      expect(result.metrics.areaError.max).toBeLessThan(1e-9);
      for (const c of [scene.a, scene.b]) {
        for (let i = 0; i < c.length; i++) expect(Number.isFinite(c[i]!)).toBe(true);
      }
    });
  }

  it('keeps before/after aligned when features are dropped', () => {
    const path = 'data/synthetic/degenerate.geojson';
    if (!has(path)) return;
    const { scene } = buildScene(load(path), { value: 'value', method: 'olson', missing: 'drop' });
    expect(scene.a.length).toBe(scene.b.length);
    expect(scene.geomA.featCount).toBe(scene.labels.length);
  });

  it('always shows the cartogram for methods whose geometry cannot be morphed', () => {
    // Regression: the morph slider is disabled for Dorling and Demers, but a disabled
    // slider keeps the value it had under the previous method. Parked below the
    // midpoint, it made those methods draw the original map instead of the symbols.
    const input = fc([squareFeature('a', 0, 0, 10, 1), squareFeature('b', 20, 0, 10, 4)]);
    const { scene } = buildScene(input, { value: 'value', method: 'dorling', projection: 'none' });
    expect(scene.morphable).toBe(false);

    for (const slider of [0, 0.2, 0.5, 1]) {
      const t = effectiveT(scene, slider);
      const out = new Float64Array(Math.max(scene.a.length, scene.b.length));
      expect(Array.from(morph(scene, t, out).slice(0, scene.b.length))).toEqual(
        Array.from(scene.b),
      );
      expect(geometryAt(scene, t)).toBe(scene.geomB);
    }

    // A morphable method still follows the slider exactly.
    const { scene: warped } = buildScene(input, { value: 'value', method: 'olson', projection: 'none' });
    expect(warped.morphable).toBe(true);
    expect(effectiveT(warped, 0.3)).toBe(0.3);
  });

  it('morphs endpoints exactly and interpolates linearly in between', () => {
    const input = fc([squareFeature('a', 0, 0, 10, 1), squareFeature('b', 20, 0, 10, 4)]);
    const { scene } = buildScene(input, { value: 'value', method: 'olson', projection: 'none' });
    const out = new Float64Array(scene.a.length);

    expect(Array.from(morph(scene, 0, out))).toEqual(Array.from(scene.a));
    expect(Array.from(morph(scene, 1, out))).toEqual(Array.from(scene.b));

    morph(scene, 0.5, out);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBeCloseTo((scene.a[i]! + scene.b[i]!) / 2, 12);
    }
  });

  it('reports area ratios that match the value ratios', () => {
    const input = fc([squareFeature('a', 0, 0, 10, 1), squareFeature('b', 20, 0, 10, 3)]);
    const { scene } = buildScene(input, { value: 'value', method: 'olson', projection: 'none' });
    expect(scene.ratios[1]! / scene.ratios[0]!).toBeCloseTo(3, 10);
  });

  it('finds adjacency in a contiguous grid and none in the cartogram', () => {
    const input = fc([squareFeature('a', 0, 0, 1, 1), squareFeature('b', 1, 0, 1, 2)]);
    const { scene, result } = buildScene(input, { value: 'value', method: 'identity', projection: 'none' });
    expect(scene.adjacency).toEqual([[0, 1]]);
    expect(result.metrics.topology!.error).toBe(0);
  });

  it('labels features from whichever name property the dataset uses', () => {
    const f = (props: Record<string, unknown>) => ({ type: 'Feature', properties: props, geometry: null }) as unknown as Feature;
    expect(labelOf(f({ NAME: 'France' }), 0)).toBe('France');
    expect(labelOf(f({ statnaam: 'Utrecht' }), 0)).toBe('Utrecht');
    expect(labelOf(f({}), 7)).toBe('#7');
  });

  it('every catalogued dataset exists on disk with the attribute it claims', () => {
    for (const d of DATASETS) {
      const path = d.url.replace(/^\//, '');
      expect(has(path), `${path} missing`).toBe(true);
      const data = load(path);
      const props = (data.features[0]!.properties ?? {}) as Record<string, unknown>;
      for (const a of d.attributes) expect(Object.keys(props), `${path}.${a}`).toContain(a);
    }
  });
});
