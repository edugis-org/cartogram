import { describe, expect, it } from 'vitest';
import { cartogram } from '../src/index.ts';
import type { CartogramOptions, MethodName } from '../src/types.ts';
import { fc, squareFeature } from './helpers.ts';
import type { FeatureCollection } from 'geojson';

const METHODS: MethodName[] = ['olson', 'dcn', 'dorling', 'demers', 'flow'];

/** Small, fast settings: this suite is about not crashing, not about quality. */
function run(input: FeatureCollection, method: MethodName, extra: Record<string, unknown> = {}) {
  return cartogram(input, {
    method,
    value: 'value',
    missing: 'zero',
    negative: 'clamp',
    grid: 64,
    runs: 2,
    iterations: 5,
    ...extra,
  } as CartogramOptions);
}

/** Every coordinate finite, every ring closed, every geometry the right shape. */
function expectWellFormed(result: ReturnType<typeof cartogram>, label: string) {
  for (const f of result.featureCollection.features) {
    const g = f.geometry;
    if (!g || g.type === 'Point' || g.type === 'LineString') continue;
    const polys =
      g.type === 'Polygon'
        ? [(g as { coordinates: number[][][] }).coordinates]
        : (g as { coordinates: number[][][][] }).coordinates;
    for (const poly of polys) {
      for (const ring of poly) {
        expect(ring.length, `${label}: ring too short`).toBeGreaterThanOrEqual(4);
        const first = ring[0]!;
        const last = ring[ring.length - 1]!;
        expect(first[0], `${label}: ring not closed`).toBe(last[0]);
        expect(first[1], `${label}: ring not closed`).toBe(last[1]);
        for (const c of ring) {
          expect(Number.isFinite(c[0]), `${label}: non-finite x`).toBe(true);
          expect(Number.isFinite(c[1]), `${label}: non-finite y`).toBe(true);
        }
      }
    }
  }
  expect(Number.isFinite(result.metrics.areaError.mean), `${label}: NaN area error`).toBe(true);
}

describe('adversarial input: every method survives it', () => {
  const cases: [string, FeatureCollection][] = [
    ['a single feature', fc([squareFeature('only', 0, 0, 1, 5)])],
    ['all values identical', fc([squareFeature('a', 0, 0, 1, 7), squareFeature('b', 1, 0, 1, 7)])],
    [
      'extreme value ratio (1 : 1e9)',
      fc([squareFeature('tiny', 0, 0, 1, 1), squareFeature('huge', 1, 0, 1, 1e9)]),
    ],
    [
      'extreme area ratio',
      fc([squareFeature('tiny', 0, 0, 0.001, 5), squareFeature('huge', 1, 0, 100, 5)]),
    ],
    [
      'a sliver polygon',
      fc([
        {
          type: 'Feature',
          properties: { value: 3 },
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 0.0001], [0, 0.0001], [0, 0]]] },
        },
        squareFeature('b', 0, 1, 1, 1),
      ]),
    ],
    [
      'duplicate consecutive vertices',
      fc([
        {
          type: 'Feature',
          properties: { value: 2 },
          geometry: {
            type: 'Polygon',
            coordinates: [[[0, 0], [0, 0], [1, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
          },
        },
        squareFeature('b', 2, 0, 1, 1),
      ]),
    ],
    [
      'an unclosed ring',
      fc([
        {
          type: 'Feature',
          properties: { value: 2 },
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
        },
        squareFeature('b', 2, 0, 1, 1),
      ]),
    ],
    [
      'clockwise (wrong-winding) ring',
      fc([
        {
          type: 'Feature',
          properties: { value: 2 },
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
        },
        squareFeature('b', 2, 0, 1, 1),
      ]),
    ],
    [
      'far-flung multipolygon parts',
      fc([
        {
          type: 'Feature',
          properties: { value: 4 },
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
              [[[500, 500], [501, 500], [501, 501], [500, 501], [500, 500]]],
            ],
          },
        },
        squareFeature('b', 2, 0, 1, 1),
      ]),
    ],
    [
      'nested holes',
      fc([
        {
          type: 'Feature',
          properties: { value: 4 },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
              [[2, 2], [2, 8], [8, 8], [8, 2], [2, 2]],
            ],
          },
        },
        squareFeature('b', 12, 0, 2, 1),
      ]),
    ],
    ['zero values everywhere', fc([squareFeature('a', 0, 0, 1, 0), squareFeature('b', 1, 0, 1, 0)])],
    [
      'mixed geometry types',
      fc([
        squareFeature('a', 0, 0, 1, 3),
        { type: 'Feature', properties: { value: 1 }, geometry: { type: 'Point', coordinates: [5, 5] } },
        { type: 'Feature', properties: { value: 1 }, geometry: null },
        squareFeature('b', 1, 0, 1, 1),
      ]),
    ],
  ];

  for (const [label, input] of cases) {
    for (const method of METHODS) {
      it(`${label} — ${method}`, () => {
        expectWellFormed(run(input, method), `${label}/${method}`);
      });
    }
  }
});

describe('adversarial input: antimeridian and poles', () => {
  const acrossAntimeridian = fc([
    {
      type: 'Feature',
      properties: { value: 5 },
      geometry: { type: 'Polygon', coordinates: [[[170, 0], [179, 0], [179, 10], [170, 10], [170, 0]]] },
    },
    {
      type: 'Feature',
      properties: { value: 1 },
      geometry: { type: 'Polygon', coordinates: [[[-179, 0], [-170, 0], [-170, 10], [-179, 10], [-179, 0]]] },
    },
  ]);
  const nearPole = fc([
    {
      type: 'Feature',
      properties: { value: 5 },
      geometry: { type: 'Polygon', coordinates: [[[0, 80], [40, 80], [40, 89.9], [0, 89.9], [0, 80]]] },
    },
    {
      type: 'Feature',
      properties: { value: 1 },
      geometry: { type: 'Polygon', coordinates: [[[40, 80], [80, 80], [80, 89.9], [40, 89.9], [40, 80]]] },
    },
  ]);

  for (const method of METHODS) {
    it(`across the antimeridian — ${method}`, () => {
      expectWellFormed(run(acrossAntimeridian, method), `antimeridian/${method}`);
    });
    it(`near the pole — ${method}`, () => {
      expectWellFormed(run(nearPole, method), `pole/${method}`);
    });
  }
});

describe('randomized inputs', () => {
  /** Deterministic pseudo-random generator: a failure here must be reproducible. */
  function rng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }

  function randomCollection(seed: number): FeatureCollection {
    const rand = rng(seed);
    const n = 3 + Math.floor(rand() * 12);
    const features = [];
    for (let i = 0; i < n; i++) {
      const cx = rand() * 40;
      const cy = rand() * 40;
      const sides = 3 + Math.floor(rand() * 8);
      const r = 0.2 + rand() * 3;
      const ring = Array.from({ length: sides }, (_, k) => {
        const t = (2 * Math.PI * k) / sides;
        return [cx + r * Math.cos(t) * (0.5 + rand()), cy + r * Math.sin(t) * (0.5 + rand())];
      });
      features.push({
        type: 'Feature' as const,
        properties: { value: rand() < 0.15 ? 0 : rand() * 1000 },
        geometry: { type: 'Polygon' as const, coordinates: [[...ring, ring[0]!]] },
      });
    }
    return fc(features);
  }

  for (let seed = 1; seed <= 6; seed++) {
    for (const method of METHODS) {
      it(`seed ${seed} — ${method}`, () => {
        expectWellFormed(run(randomCollection(seed), method, { projection: 'none' }), `seed${seed}/${method}`);
      });
    }
  }
});
