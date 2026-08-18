# cartogram-ts

Turn GeoJSON into cartograms. TypeScript, browser-compatible, **zero runtime dependencies**.

Status: **M0–M6 complete.** The pipeline, five cartogram methods including the flow-based
one that is the quality target, the metric suite and the human review harness all work
end to end on real data. Runs off the main thread in a Web Worker, with a
committed benchmark suite. Remaining: robustness and release (M7).

```ts
import { cartogram } from 'cartogram-ts';

const result = cartogram(featureCollection, {
  method: 'flow',         // 'identity' | 'olson' | 'dcn' | 'flow' | 'dorling' | 'demers'
  value: 'population',    // property name, or (feature, i) => number
  projection: 'auto',     // 'auto' | 'none' | 'laea' | 'cylindrical-equal-area'
  missing: 'error',       // 'error' | 'zero' | 'mean' | 'drop'
  negative: 'error',      // 'error' | 'clamp'
  densify: 'auto',        // insert vertices before warping; 'auto' | number | false

  // dcn only:
  iterations: 60,
  targetError: 0.02,      // stop here
  shapeAnchor: 0.25,      // anti-blob strength, 0..1
  onIteration: (i, err) => {},
  signal: controller.signal,
});

result.featureCollection;              // GeoJSON out, same feature order and properties
result.diagnostics[0].error;           // per-feature cartographic error
result.metrics.areaError.mean;         // Nusrat & Kobourov (2016) mean error
result.metrics.shape.meanCompactnessDrift;  // anti-blob guard
result.warnings;                       // dropped features, substituted values, ...
```

CLI:

```
npm run build
node dist/cli.js data/real/nl-provinces.geojson --value POP_2021 -o out.geojson
```

## What works today

- **Pipeline**: validate → extract values → equal-area projection → transform → measure →
  unproject → rebuild GeoJSON. Polygons, MultiPolygons, holes, and Polygon-only
  GeometryCollections. Points and lines pass through untouched, in place.
- **Olson (1976) non-contiguous cartogram** — exact areas *and* exact shapes, O(V), no
  parameters. It is also the pipeline's correctness oracle: its area error is ~1e-16 on
  every dataset in `data/`, so any bug in areas, projection or value handling shows up
  immediately.
- **Flow-based cartogram (Gastner, Seguy & More 2018)** — the quality target and the
  best method here. The map is rasterized to a density field, diffused to uniform, and
  every point is carried by the flow `v = -grad(rho)/rho`. Area error 0.25% on the Dutch
  provinces against 1.87% for the force method, and 8.7% against 28.7% on world
  countries. Shared borders cannot tear and regions round off far less, both by
  construction rather than by effort: one global displacement field is applied to every
  point. Diffusion is solved in the cosine basis, where the heat equation is diagonal, on
  an FFT written for the purpose and checked against direct evaluation of the transforms.
- **Dougenik–Chrisman–Niemeyer (1985) contiguous cartogram**, hardened along the lines of
  Sun (2020): local support through a uniform grid (linear in vertex count, not quadratic
  in features), per-vertex step caps that prevent folds at the source, and an explicit
  anti-blob term. **Shared borders stay welded exactly** — topology error 0.000 on every
  real dataset — because bit-identical coordinates are collapsed to one moving point.
  Area error reaches ~2% on small compact maps and 12–35% on large or heavily skewed ones;
  that ceiling is the known limit of the force family and the reason the flow-based method
  is next. Growing regions do round off somewhat (radial forces about each centroid are
  inherently circular); raising `cutoff` to ~20 and `shapeAnchor` to ~0.8 counteracts it at
  a real cost in area accuracy and speed. See `docs/PROJECT_PLAN.md` for the measured table.
- **Dorling (1996) circles and Demers squares** — areas exact to floating point, zero
  overlapping symbols on every dataset, relative position preserved (rank correlation
  0.96–0.997). These discard shape entirely, so they are **opt-in and never the default**
  (F20a), and the anti-blob metrics are left to report them honestly rather than being
  suppressed.
- **Topology-preserving line densification** (Duncan & Gastner 2025) before any warp, with
  shared edges subdivided into bit-identical points from both sides.
- **Metrics**: cartographic error, adjacency Jaccard topology error, relative-position rank
  correlation, and the anti-blob guard.
- **Equal-area projections**, written from the formulas with exact inverses: Lambert
  azimuthal for regional maps, Lambert cylindrical for near-global ones, auto-selected.
  Cartograms are about area, so this is a correctness requirement, not a nicety.
- **57 tests**, including the M1 exit criterion run over all 15 datasets in `data/`.

## Off the main thread

A flow cartogram takes seconds, which is a frozen page if it runs where the UI does.

```ts
import { CartogramWorker } from 'cartogram-ts';

const worker = new CartogramWorker();
const result = await worker.run(featureCollection, { method: 'flow', value: 'pop' }, {
  onProgress: (pass, meanError) => console.log(pass, meanError),
  signal: abortController.signal,
});
```

Bundler users should pass their own worker factory — bundlers only rewrite worker URLs
when they can see a literal `new URL(...)` at the call site:

```ts
new CartogramWorker(() => new Worker(
  new URL('cartogram-ts/worker', import.meta.url), { type: 'module' },
));
```

## Benchmarks

```
npm run bench     # writes bench/results.json
```

Scaling is near-linear as required: Olson is linear in vertices (512× vertices, 375×
time), and the flow method is almost flat in both vertex and feature count, because its
cost is the grid you choose rather than the data you give it. See
[`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md) for the tables.

## Review harness

Cartogram quality is not only area error: the map has to stay **recognizable**. The harness
is where a person decides that, and it records the decision.

```
npm run harness      # http://localhost:5174/harness/
```

- every dataset in `data/` x every method x its parameters, all in the browser
- side-by-side original and cartogram, or a single view with a **morph slider** and an
  animate button - the transition is what makes a distortion legible
- ghost outline of the original, adjacency-graph overlay, choropleth by area error or by
  grew/shrank, hover for per-feature value, area ratio and error
- live metrics panel, including the anti-blob guard (compactness drift, detail retention)
- **verdict capture**: recognizable / borderline / unusable plus notes, written with the
  run's metrics to `harness/verdicts.json` so a change that quietly ruins the maps shows up
  as a regression rather than being discovered by chance

The harness's own logic (`harness/scene.ts`) is DOM-free and covered by the test suite,
because a harness that misaligns the two maps would invalidate every judgement made with it.

## Provenance

No source code was copied from any cartogram implementation. Every file under `src/`
and `harness/` was written for this project, from the published papers and from standard
numerical methods; the algorithms are cited in the source where they are implemented.
There are **no runtime dependencies at all**, vendored or otherwise — the FFT and cosine
transforms the flow method needs were written here rather than pulled in, and are checked
against direct evaluation of their defining sums.

The reference implementations ([`go_cart`](https://github.com/Flow-Based-Cartograms/go_cart),
[`cartogram-cpp`](https://github.com/mgastner/cartogram-cpp),
[`go-cart-wasm`](https://github.com/riatelab/go-cart-wasm),
[`d3-cartogram`](https://github.com/emeeks/d3-cartogram)) were not downloaded or read
during development — only their READMEs and licence files, to record what exists and under
what terms. See [`docs/LITERATURE.md`](docs/LITERATURE.md).

The honest caveat: the building blocks here are textbook (the shoelace formula, Lambert
azimuthal equal-area, iterative Cooley–Tukey, a DCT via a symmetric FFT extension, scanline
polygon fill). Canonical algorithms written idiomatically tend to converge on similar
shapes, so resemblance to other implementations at that level is expected and is not
derivation from them.

Only the data in `data/` comes from outside; its sources and licences are recorded in
[`data/SOURCES.md`](data/SOURCES.md).

## Docs

- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) — what it must do
- [`docs/LITERATURE.md`](docs/LITERATURE.md) — methods and existing code to reuse
- [`docs/STAR-2016-REVIEW.md`](docs/STAR-2016-REVIEW.md) — deep read of the field's reference survey
- [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md) — milestones M0–M7 and architecture
- [`data/SOURCES.md`](data/SOURCES.md) — test datasets, provenance, licences

## Development

```
npm install
npm test          # vitest
npm run typecheck
npm run build     # tsc -> dist/, ESM + .d.ts
```
