#!/usr/bin/env node
/**
 * Benchmark suite. Run with `npm run bench`.
 *
 * Two questions it exists to answer, both from the requirements:
 *   N1  is runtime near-linear in feature count, and linear in vertex count?
 *   M6  what does each method actually cost on real data?
 *
 * Results are written to bench/results.json so a later change can be compared against
 * a committed baseline rather than against memory.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { cartogram } = await import(resolve(root, 'dist/index.js'));

const load = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));

/** Median of `runs` timings, to blunt GC noise. */
function time(fn, runs = 3) {
  const ms = [];
  let result;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    result = fn();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  return { ms: ms[ms.length >> 1], result };
}

const REAL = [
  ['nl-provinces', 'data/real/nl-provinces.geojson', 'POP_2021'],
  ['nuts0', 'data/real/nuts0-20m.geojson', 'POP_2021'],
  ['nl-municipalities', 'data/real/nl-municipalities.geojson', 'POP'],
  ['nuts2-20m', 'data/real/nuts2-20m.geojson', 'POP_2021'],
  ['world-110m', 'data/real/world-110m.geojson', 'POP_EST'],
  ['nuts3-20m', 'data/real/nuts3-20m.geojson', 'POP_2021'],
];

const LOD = ['lod-1e2', 'lod-1e3', 'lod-1e4', 'lod-1e5'];
const FEATURE_SCALING = [
  ['grid 100', 'data/synthetic/grid.geojson'],
  ['hex 400', 'data/synthetic/hex.geojson'],
  ['grid-large 1600', 'data/synthetic/grid-large.geojson'],
];

const results = { generated: new Date().toISOString(), node: process.version, sections: {} };

function row(cells) {
  console.log('| ' + cells.join(' | ') + ' |');
}

// --- methods on real data ----------------------------------------------------
console.log('\n## methods on real data\n');
row(['dataset', 'features', 'vertices', 'method', 'ms', 'area err', 'topology']);
row(['---', '---:', '---:', '---', '---:', '---:', '---:']);
results.sections.real = [];

for (const [name, path, attr] of REAL) {
  const fc = load(path);
  for (const method of ['olson', 'dorling', 'dcn', 'flow']) {
    const opts = { method, value: attr, missing: 'drop', negative: 'clamp' };
    if (method === 'flow') opts.grid = 256;
    const { ms, result } = time(() => cartogram(fc, opts), method === 'flow' ? 1 : 3);
    const m = result.metrics;
    row([
      name, m.featureCount, m.vertexCount, method,
      ms.toFixed(0), (m.areaError.mean * 100).toFixed(2) + '%', m.topology.error.toFixed(3),
    ]);
    results.sections.real.push({
      dataset: name, method, features: m.featureCount, vertices: m.vertexCount,
      ms: +ms.toFixed(1), areaError: m.areaError.mean, topologyError: m.topology.error,
    });
  }
}

// --- scaling in vertices -----------------------------------------------------
// Same 25 features at four levels of detail: runtime should grow linearly with
// vertices, and the flow method's grid work should barely move at all.
console.log('\n## vertex scaling (25 features throughout)\n');
row(['dataset', 'vertices', 'olson ms', 'dcn ms', 'flow ms']);
row(['---', '---:', '---:', '---:', '---:']);
results.sections.vertexScaling = [];

for (const name of LOD) {
  const fc = load(`data/synthetic/${name}.geojson`);
  const base = { value: 'value', missing: 'zero' };
  const olson = time(() => cartogram(fc, { ...base, method: 'olson' }));
  const dcn = time(() => cartogram(fc, { ...base, method: 'dcn', iterations: 20, targetError: 0 }));
  const flow = time(() => cartogram(fc, { ...base, method: 'flow', grid: 128, runs: 3 }), 1);
  const vertices = olson.result.metrics.vertexCount;
  row([name, vertices, olson.ms.toFixed(1), dcn.ms.toFixed(0), flow.ms.toFixed(0)]);
  results.sections.vertexScaling.push({
    dataset: name, vertices,
    olsonMs: +olson.ms.toFixed(2), dcnMs: +dcn.ms.toFixed(1), flowMs: +flow.ms.toFixed(1),
  });
}

// --- scaling in feature count ------------------------------------------------
console.log('\n## feature scaling\n');
row(['dataset', 'features', 'vertices', 'olson ms', 'dorling ms', 'dcn ms', 'flow ms']);
row(['---', '---:', '---:', '---:', '---:', '---:', '---:']);
results.sections.featureScaling = [];

for (const [name, path] of FEATURE_SCALING) {
  const fc = load(path);
  const base = { value: 'value', missing: 'zero' };
  const olson = time(() => cartogram(fc, { ...base, method: 'olson' }));
  const dorling = time(() => cartogram(fc, { ...base, method: 'dorling' }), 1);
  const dcn = time(() => cartogram(fc, { ...base, method: 'dcn', iterations: 20, targetError: 0 }));
  const flow = time(() => cartogram(fc, { ...base, method: 'flow', grid: 128, runs: 3 }), 1);
  const m = olson.result.metrics;
  row([name, m.featureCount, m.vertexCount, olson.ms.toFixed(1), dorling.ms.toFixed(0), dcn.ms.toFixed(0), flow.ms.toFixed(0)]);
  results.sections.featureScaling.push({
    dataset: name, features: m.featureCount, vertices: m.vertexCount,
    olsonMs: +olson.ms.toFixed(2), dorlingMs: +dorling.ms.toFixed(1),
    dcnMs: +dcn.ms.toFixed(1), flowMs: +flow.ms.toFixed(1),
  });
}

// --- flow grid resolution ----------------------------------------------------
console.log('\n## flow: cost and quality against grid size (nl-provinces)\n');
row(['grid', 'ms', 'area err']);
row(['---:', '---:', '---:']);
results.sections.flowGrid = [];
{
  const fc = load('data/real/nl-provinces.geojson');
  for (const grid of [128, 256, 512]) {
    const { ms, result } = time(
      () => cartogram(fc, { method: 'flow', value: 'POP_2021', missing: 'drop', grid }), 1,
    );
    row([grid, ms.toFixed(0), (result.metrics.areaError.mean * 100).toFixed(2) + '%']);
    results.sections.flowGrid.push({ grid, ms: +ms.toFixed(1), areaError: result.metrics.areaError.mean });
  }
}

writeFileSync(resolve(root, 'bench/results.json'), JSON.stringify(results, null, 2) + '\n');
console.log('\nwritten to bench/results.json\n');
