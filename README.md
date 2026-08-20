# @edugis/cartogram

Turn GeoJSON into cartograms. TypeScript, browser-compatible, **zero runtime dependencies**.

Status: **M0–M6 complete.** The pipeline, five cartogram methods including the flow-based
one that is the quality target, the metric suite and the human review harness all work
end to end on real data. Runs off the main thread in a Web Worker, with a
committed benchmark suite. Remaining: robustness and release (M7).

```ts
import { cartogram } from '@edugis/cartogram';

const result = cartogram(featureCollection, {
  method: 'flow',         // 'identity' | 'olson' | 'dcn' | 'flow' | 'dorling' | 'demers'
  value: 'population',    // property name, or (feature, i) => number
  projection: 'auto',     // 'auto' | 'none' | 'laea' | 'cylindrical-equal-area'
  missing: 'error',       // 'error' | 'zero' | 'mean' | 'drop'
  negative: 'error',      // 'error' | 'clamp'
  densify: 'auto',        // insert vertices before warping; 'auto' | number | false
  fitLatitude: 85,        // shrink to keep coordinates inside ±85°; false to disable

  // flow only:
  grid: 512,              // resolution per side, or 'auto' to size it from the data

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
import { CartogramWorker } from '@edugis/cartogram';

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
  new URL('@edugis/cartogram/worker', import.meta.url), { type: 'module' },
));
```

## Benchmarks

```
npm run bench          # writes bench/results.json
npm run bench:go-cart  # head-to-head against the reference C implementation
```

The flow method is benchmarked against [`go-cart-wasm`](https://github.com/riatelab/go-cart-wasm),
the authors' own C implementation of the same algorithm. Summary: they are more accurate on
well-behaved maps (0.03% against our 0.20% on the Dutch provinces), we are substantially
more accurate on the harder ones (3.0% against 11.9% on NUTS 2, 5.8% against 10.4% on
world countries), and shape and topology behaviour agree closely. Full table and caveats in
[`docs/BENCHMARK-GO-CART.md`](docs/BENCHMARK-GO-CART.md).

Scaling is near-linear as required: Olson is linear in vertices (512× vertices, 375×
time), and the flow method is almost flat in both vertex and feature count, because its
cost is the grid you choose rather than the data you give it. See
[`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md) for the tables.

## Reading the metrics

Area error is quadratic in what a reader sees: 0.2% area error is 0.1% of linear scale,
about 30 m on a 30 km region — a sixteenth of a pixel on a typical screen. Human area
judgement is far coarser, with a just-noticeable difference around 10–20%. So a **mean**
area error below a couple of percent is invisible and not worth chasing; the numbers that
matter are the **maximum** area error (a single region plainly the wrong size), the
rounding metrics, and self-intersections. See
[`docs/READING-THE-METRICS.md`](docs/READING-THE-METRICS.md).

## Review harness

**Live: <https://edugis-org.github.io/cartogram/>**

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
- **the reference implementation as a sixth method**: `go-cart-wasm` runs alongside the
  built-in ones, on the same data and scored with the same metrics, so the two can be
  compared by eye rather than only in a table
- **verdict capture**: recognizable / borderline / unusable plus notes, written with the
  run's metrics to `harness/verdicts.json` so a change that quietly ruins the maps shows up
  as a regression rather than being discovered by chance

The harness's own logic (`harness/scene.ts`) is DOM-free and covered by the test suite,
because a harness that misaligns the two maps would invalidate every judgement made with it.

## Using the reference implementation instead

The authors' own C implementation is available as `go-cart-wasm`, and this library can
drive it, so you keep one API and one metric suite either way:

```ts
import initGoCart from 'go-cart-wasm';
import { goCartCartogram } from '@edugis/cartogram/go-cart';

const goCart = await initGoCart();
const result = goCartCartogram(featureCollection, { goCart, value: 'population' });
```

It is an optional peer dependency — nothing WebAssembly-shaped is installed unless you
ask for it. Use it when you want the best accuracy on well-behaved maps and can afford a
671 kB WASM payload; use the built-in `flow` when you want no WASM, a grid you can tune,
or better results on maps full of very small regions. Numbers for both:
[`docs/BENCHMARK-GO-CART.md`](docs/BENCHMARK-GO-CART.md).

## Choosing a method

No cartogram preserves area, shape and topology at once — that trade-off is the subject
of the field's reference survey, and it is why this library ships several methods rather
than one. Measured on the datasets in `data/`:

| method | contiguous | shape | area error | notes |
|---|---|---|---|---|
| `flow` | yes | best of the contiguous methods | 0.2–9% | **the default choice.** Gastner–Seguy–More diffusion. Seconds, not milliseconds |
| `dcn` | yes | rounds regions off; introduces self-intersections | 2–29% | force-based, ~100× faster than `flow` |
| `olson` | no | **exact** | ~1e-14 | pure per-feature scaling; the correctness oracle |
| `dorling` | no | circles | ~1e-13 | good for "which is biggest" questions |
| `demers` | no | squares | ~1e-13 | as Dorling, squares tile better |

### Staying inside the world

A cartogram moves regions off the graticule they came from, and in a plane nothing stops
that leaving the world. On world countries sized by population, India and China grow
enough to push Russia off the top of the map: 1618 of the returned points came back at
±90°, because unprojecting an out-of-range coordinate does not fail, it clamps — pressing
them onto the pole line and smearing the shapes that own them.

`fitLatitude` (default 85) shrinks the finished cartogram by the largest factor that
brings every coordinate inside, and centres it vertically. On `world-110m` that is a
scale to 92%, and it is a similarity: area error, shape, topology and self-intersections
come back bit-identical. A map that never left the world — anything regional — is not
touched at all, and the result is byte-for-byte what `fitLatitude: false` gives.

Centring matters as much as the scale. The centre of mass of world countries sits well
north of the equator, so scaling about it top-aligns the map: Russia stays jammed
against the limit while Antarctica floats off the bottom. Centring shares the slack, and
needs less shrink for it — 92% rather than 80%.

### Grid resolution

The flow's resolution limit is one specific thing: a region smaller than a grid cell
cannot be represented in the density field, so it exerts no pressure and comes out shrunk
however dense it is. Paris is 105 km² holding 2.1 million people and is exactly this
failure.

`grid: 'auto'` sizes the grid so that the smallest region *carrying real value* gets at
least one cell. The value filter is what makes it usable rather than absurd: sizing to
the smallest region outright asks for a grid of 82,000 on world countries, because
somewhere in the file there is an islet. A tenth of the mean value share is a low enough
bar to keep every region a reader would miss and high enough to drop the rocks — it lands
on Singapore for world countries, Melilla for NUTS 3, Brussels for NUTS 2.

It never goes below the default and is capped at 1024. Both bounds are deliberate: sizing
purely to the minimum viable grid picks 256 for NUTS 0 and costs 0.51% → 1.25% area error
for a saving nobody asked for, and the next doubling past 1024 costs four to five times
the runtime for a diminishing return. Where 1024 is still not enough, the under-resolved
warning says so.

It is not the default, because it is not free — on NUTS 3 it picks 1024 over 512, which
takes the area error from 15.9% to 4.5% and the runtime from 13 to 60 seconds. That is
usually the right trade and it should still be yours. `metrics.resolved.grid` reports
what it chose.

### Velocity field

`gradient` decides how the velocity is taken from the diffused density: `differences`
(the default) by central differences, `analytic` by differentiating the cosine series in
the spectrum. How much the exact one buys is a property of the map, not of the method —
at grid 512, median area error:

| dataset | `differences` | `analytic` | runtime |
|---|---|---|---|
| nl-provinces | 0.146% | 0.141% | 3.6 s → 11.7 s |
| nuts2-20m | 1.334% | **0.412%** | 11.1 s → 33.2 s |
| world-110m | 0.685% | 0.501% | 17.0 s → 47.1 s |

The two agree wherever the density field is smooth at the scale of a cell and diverge
where it is not — so on a dozen similar regions it is worth nothing, and on a map with
many regions and sharp density contrasts it is worth a factor of three. It is not free
even where it wins: on world countries it also takes the self-intersection count from 17
to 48.

### Step tolerance

`tolerance` sets the adaptive integrator's local error target, in grid cells. Tightening
it makes the result **worse as well as slower**, which is unusual enough to be worth
stating: swept over all seven datasets in `data/` at grid 512, `0.2` beat `0.02` on the
median area error of six and tied on the seventh, at half the runtime.

| dataset | 0.02 | 0.2 | runtime |
|---|---|---|---|
| nl-provinces | 0.146% | 0.097% | 3.6 s → 1.7 s |
| nl-municipalities | 0.068% | 0.038% | 10.0 s → 4.8 s |
| nuts0-20m | 0.013% | 0.006% | 8.9 s → 5.0 s |
| nuts2-20m | 1.334% | 1.034% | 11.3 s → 5.7 s |
| nuts3-20m | 15.94% | 15.77% | 12.8 s → 6.2 s |
| world-110m | 0.685% | 0.600% | 17.1 s → 8.8 s |
| world-50m | 1.677% | 1.368% | 17.5 s → 8.4 s |

The cause is an interaction, not a design: a pass stops when the largest vertex movement
*in one step* gets small, and that movement scales with the step size, so a tight
tolerance ends the pass while the flow still has somewhere to go. The accuracy it buys
inside a pass is worth less than the flow it costs. `0.3` is past the edge — it regresses
on the municipalities and on world countries — so the default is `0.2`.

Topology error stayed at 0 across the whole sweep and shape drift was flat; the one cost
is self-intersections on world countries, 17 at 0.02 against 23 at 0.2.

Two honest caveats:

- `dcn` introduces self-intersecting boundaries on real data (hundreds of segments on
  NUTS 2). Damping reduces them but doubles the area error, so it is reported through
  `metrics.selfIntersections` rather than silently traded away. Prefer `flow` unless you
  need the speed.
- `flow` is only as accurate as its grid: a region smaller than one grid cell can only be
  approximated. When that happens the result carries a warning naming the count. For
  NUTS 3-scale data use `grid: 1024`, or `grid: 'auto'` to have it worked out.

## API

```ts
cartogram(featureCollection, options) => {
  featureCollection,   // GeoJSON out, same order, ids and properties
  baseline?,           // the projected, densified input (with includeBaseline)
  diagnostics[],       // per feature: value, input/target/output area, error, rounding
  metrics,             // area error, topology, orientation, shape, self-intersections
  iteration?,          // convergence detail for iterative methods
  warnings[],          // dropped features, substituted values, under-resolved features
}
```

Common options: `value` (property name or accessor), `method`, `projection`
(`auto` | `none` | `laea` | `cylindrical-equal-area`), `missing`
(`error` | `zero` | `mean` | `drop`), `negative` (`error` | `clamp`), `unproject`,
`densify`, `fitLatitude`, `includeBaseline`, `metrics`.

Per-method options are typed on the union member — `fit` for `olson`; `iterations`,
`targetError`, `cutoff`, `damping`, `shapeAnchor`, `smoothing` for `dcn`; `grid`,
`padding`, `runs`, `stepsPerRun`, `blur` for `flow`; `iterations`, `anchor`,
`attraction`, `repulsion`, `fill`, `segments` for `dorling`/`demers`. Iterative methods
also take `onIteration` and `signal`.

### CLI

```
npx @edugis/cartogram data/real/nl-provinces.geojson --value POP_2021 --method flow -o out.geojson
```

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
npm run build     # tsc -> dist/, ESM + .d.ts (the npm package)
npm run bench     # benchmarks -> bench/results.json
npm run app:dev   # the review harness at localhost:5174/harness/ (restart it after
                  # adding a dependency: Vite pre-bundles them at startup, and a new
                  # one shows up as a "Failed to fetch" from the worker until it does)
npm run app:build # the harness as a deployable app -> dist-app/
```

The library and the app come out of the same repository: `npm publish` ships only `dist/`,
while `npm run app:build` produces the harness plus its datasets. See
[`docs/PUBLISHING.md`](docs/PUBLISHING.md).
