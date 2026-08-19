import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runOptions } from '../harness/scene.ts';
import { goCartCartogram } from '../src/backends/go-cart.ts';
import { cartogram } from '../src/index.ts';
import type { CartogramOptions } from '../src/types.ts';

/**
 * The harness can drive the reference implementation as well as the built-in methods.
 * These check the wiring: that the options it builds are accepted, and that both paths
 * produce a comparable result on the same input.
 */
describe('harness method wiring', () => {
  const fc = JSON.parse(readFileSync('data/real/nl-provinces.geojson', 'utf8'));

  it('builds flow options including the new gradient and tolerance controls', () => {
    const options = runOptions({
      value: 'POP_2021', method: 'flow', grid: 256, runs: 4, blur: 4,
      gradient: 'analytic', tolerance: 0.01,
    }) as CartogramOptions & { gradient: string; tolerance: number };
    expect(options.method).toBe('flow');
    expect(options.gradient).toBe('analytic');
    expect(options.tolerance).toBe(0.01);
    // And the library accepts them.
    const r = cartogram(fc, { ...options, value: 'POP_2021', missing: 'zero', grid: 64, runs: 2 } as CartogramOptions);
    expect(Number.isFinite(r.metrics.areaError.mean)).toBe(true);
  });

  it('passes go-cart options through without the library rejecting them', () => {
    // The harness widens the method discriminant with 'go-cart'; the options it builds
    // must still be the shape the backend expects.
    const options = runOptions({ value: 'POP_2021', method: 'go-cart', missing: 'drop' }) as { method: string; value: string; includeBaseline: boolean };
    expect(options.method).toBe('go-cart');
    expect(options.value).toBe('POP_2021');
    expect(options.includeBaseline).toBe(true);
  });

  it.skipIf(!process.env.GO_CART)('builds a scene for go-cart even when it changes the vertex count', async () => {
    // go-cart reconstructs its own polygons and prunes degenerate vertices, so its
    // output matches the input's vertex count only by coincidence: it did on the Dutch
    // provinces (1608 either way) and did not on world countries (10365 -> 10362),
    // where the morph-alignment guard fired and the map was simply not drawn.
    const { buildScene } = await import('../harness/scene.ts');
    const initGoCart = (await import('go-cart-wasm')).default;
    const goCart = await initGoCart({ locateFile: (p: string) => `${process.cwd()}/node_modules/go-cart-wasm/dist/${p}` });
    const world = JSON.parse(readFileSync('data/real/world-110m.geojson', 'utf8'));

    const { goCartCartogram: run } = await import('../src/backends/go-cart.ts');
    const result = run(world, { goCart: goCart as never, value: 'POP_EST', missing: 'drop', negative: 'clamp', unproject: false, includeBaseline: true });
    const built = buildScene(world, { value: 'POP_EST', method: 'go-cart', missing: 'drop' }, result);
    expect(built.scene.morphable).toBe(false);
    expect(built.scene.geomB.featCount).toBe(built.scene.geomA.featCount);
  });

  it.skipIf(!process.env.GO_CART)('produces a comparable result through the backend', async () => {
    const initGoCart = (await import('go-cart-wasm')).default;
    const goCart = await initGoCart({ locateFile: (p: string) => `${process.cwd()}/node_modules/go-cart-wasm/dist/${p}` });
    const result = goCartCartogram(fc, { goCart: goCart as never, value: 'POP_2021', missing: 'drop' });
    expect(result.metrics.areaError.mean).toBeLessThan(0.02);
    expect(result.metrics.topology!.error).toBe(0);
  });
});
