#!/usr/bin/env node
/**
 * Compare our flow method against go-cart-wasm, the authors' own C implementation of
 * Gastner-Seguy-More (2018) compiled to WebAssembly.
 *
 * It is the honest oracle for this library's headline method: same algorithm family,
 * written by the people who devised it, with the adaptive Runge-Kutta integrator this
 * implementation deliberately does not have. If our area errors are near theirs, the
 * simplifications cost little; if they are far off, we know where to look.
 *
 * Both implementations receive the *same* planar input -- projected once by us -- and
 * both outputs are scored with the *same* metrics, ours, so nothing hinges on whose
 * definition of "area error" is being reported.
 *
 * Run with `npm run bench:go-cart`.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import initGoCart from 'go-cart-wasm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lib = await import(resolve(root, 'dist/index.js'));
const { cartogram, pack, allFeatureAreas, cartographicError, topologyError, shapePreservation, selfIntersections } = lib;

const GoCart = await initGoCart({ locateFile: (p) => `${root}/node_modules/go-cart-wasm/dist/${p}` });

const signedArea = (ring) => {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return s / 2;
};

/**
 * go_cart wants outer rings *clockwise* -- the pre-RFC-7946 convention. Fed the other
 * way it computes correctly but silently emits empty geometry, complaining that every
 * polygon in a region is a hole. Natural Earth already winds that way; the Dutch data
 * does not. Our own code is winding-agnostic and needs none of this.
 */
function windClockwise(fc) {
  const fix = (poly) => poly.map((ring, i) => {
    const outer = i === 0;
    const isClockwise = signedArea(ring) < 0;
    return outer === isClockwise ? ring : [...ring].reverse();
  });
  return {
    ...fc,
    features: fc.features.map((f) => {
      const g = f.geometry;
      if (!g) return f;
      if (g.type === 'Polygon') return { ...f, geometry: { ...g, coordinates: fix(g.coordinates) } };
      if (g.type === 'MultiPolygon') return { ...f, geometry: { ...g, coordinates: g.coordinates.map(fix) } };
      return f;
    }),
  };
}

const areal = (fc) => fc.features.filter((f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon');

/** Score any output against the same projected input, with our metrics. */
function score(inputFc, outputFc, values, ms) {
  const before = pack(areal(inputFc));
  const after = pack(areal(outputFc));
  const areas = allFeatureAreas(after);
  const { summary } = cartographicError(areas, values);
  const shape = shapePreservation(before, after);
  return {
    ms,
    areaError: summary.mean,
    areaErrorMax: summary.max,
    topology: topologyError(before, after).error,
    rounding: shape.meanPositiveDrift,
    detail: shape.meanDetailRetention,
    selfIntersections: selfIntersections(after),
    features: after.featCount,
  };
}

const DATASETS = [
  ['nl-provinces', 'data/real/nl-provinces.geojson', 'POP_2021'],
  ['nuts0', 'data/real/nuts0-20m.geojson', 'POP_2021'],
  ['nuts2-20m', 'data/real/nuts2-20m.geojson', 'POP_2021'],
  ['world-110m', 'data/real/world-110m.geojson', 'POP_EST'],
];

const row = (c) => console.log('| ' + c.join(' | ') + ' |');
row(['dataset', 'implementation', 'ms', 'area err', 'max err', 'topology', 'rounding', 'detail', 'self-int']);
row(['---', '---', '---:', '---:', '---:', '---:', '---:', '---:', '---:']);

for (const [name, path, attr] of DATASETS) {
  const raw = JSON.parse(readFileSync(resolve(root, path), 'utf8'));

  // Project once, ourselves; both implementations then see identical planar input.
  const projected = cartogram(raw, {
    method: 'identity', value: attr, missing: 'drop', negative: 'clamp',
    unproject: false, densify: false,
  }).featureCollection;
  const values = Float64Array.from(areal(projected).map((f) => Number(f.properties[attr]) || 0));

  for (const grid of [256, 512]) {
    const t0 = performance.now();
    const ours = cartogram(projected, {
      method: 'flow', value: attr, missing: 'drop', negative: 'clamp',
      projection: 'none', unproject: false, grid,
    });
    const s = score(projected, ours.featureCollection, values, performance.now() - t0);
    row([name, `ours (grid ${grid})`, s.ms.toFixed(0), (s.areaError * 100).toFixed(2) + '%',
      (s.areaErrorMax * 100).toFixed(1) + '%', s.topology.toFixed(3),
      '+' + s.rounding.toFixed(3), s.detail.toFixed(2), s.selfIntersections]);
  }

  const t1 = performance.now();
  let out;
  try {
    out = GoCart.makeCartogram(windClockwise(projected), attr);
  } catch (e) {
    row([name, 'go-cart-wasm', '—', 'failed: ' + e.message, '', '', '', '', '']);
    continue;
  }
  const ms = performance.now() - t1;
  const withGeometry = out.features.filter((f) => f.geometry?.type).length;
  if (withGeometry !== out.features.length) {
    row([name, 'go-cart-wasm', ms.toFixed(0), `only ${withGeometry}/${out.features.length} features had geometry`, '', '', '', '', '']);
    continue;
  }
  const s = score(projected, out, values, ms);
  row([name, 'go-cart-wasm', s.ms.toFixed(0), (s.areaError * 100).toFixed(2) + '%',
    (s.areaErrorMax * 100).toFixed(1) + '%', s.topology.toFixed(3),
    '+' + s.rounding.toFixed(3), s.detail.toFixed(2), s.selfIntersections]);
}
