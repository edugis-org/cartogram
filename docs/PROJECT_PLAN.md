# Project plan — `@edugis/cartogram`

## Guiding order

Ship the cheap, provably-correct methods first so that the **pipeline, metrics and human
review harness exist before** the hard algorithm (flow-based diffusion) is attempted.
Every method plugs into the same input→project→transform→measure→render path.

## Architecture

```
src/
  index.ts               # cartogram(fc, options) entry point
  types.ts               # public types, options unions, diagnostics
  io/
    validate.ts          # GeoJSON validation, geometry-type checks
    values.ts            # attribute extraction + missing-value policy
    project.ts           # lon/lat -> equal-area plane and back (d3-geo)
  topology/
    index.ts             # vertex/arc dedup, adjacency graph, ring orientation
    area.ts              # signed area, holes, multipolygon aggregation
    densify.ts           # topology-preserving line densification (Duncan & Gastner 2025)
  methods/
    olson.ts             # non-contiguous
    dcn.ts               # Dougenik-Chrisman-Niemeyer + quadtree
    dorling.ts           # Dorling / Demers circles & squares
    diffusion/
      index.ts           # Gastner-Seguy-More driver
      grid.ts            # rasterize density onto grid, sea padding
      dct.ts             # DCT-II/III via FFT
      integrate.ts       # adaptive Heun / RK with step control
  metrics/
    area.ts shape.ts topology.ts orientation.ts report.ts
  worker/                # worker entry + transferable buffers
harness/                 # browser review app (Vite)
data/                    # test datasets (see data/SOURCES.md)
test/                    # unit + property + golden tests
```

Core representation for the transform stage is **flat `Float64Array` coordinate buffers +
ring index arrays**, not nested GeoJSON arrays: this is what makes the hot loops fast,
worker-transferable and allocation-free. GeoJSON ↔ flat conversion happens once at each end.

## Milestones

### M0 — Scaffolding ✅ done
- pnpm + TypeScript + Vite lib mode + Vitest + ESLint/Prettier, ESM-only build, CI.
- `data/` fetch script + `data/SOURCES.md` with provenance/licence.
- Flat-buffer geometry representation and GeoJSON round-trip, with a property test:
  *round-trip is lossless*.
- **Exit:** `import { cartogram } from '@edugis/cartogram'` works and returns input unchanged for `method: 'identity'`.

### M1 — Pipeline + Olson + metrics ✅ done
- Value extraction, missing-value policies, equal-area projection step.
- `olson` method (scale about centroid).
- Metrics: area error (mean/max/percentiles), **compactness drift and boundary-detail
  retention (the anti-blob guard, F20a/F20b)**, runtime, vertex count.
- CLI: `cartogram data/x.geojson --value pop --method olson -o out.geojson`.
- **Exit:** Olson output has area error < 1e-9 on every dataset. That is a hard oracle.
  **Met:** ~1e-16 across all 15 datasets. Finding along the way: raw shoelace area on
  projected world coordinates (~1e7 m) loses ~9 significant digits to cancellation; areas
  and centroids are now accumulated relative to each ring's first vertex.

### M2 — Human review harness ✅ done
- Vite browser app: dataset picker × method picker × parameter panel.
- Side-by-side + overlay + ghost-outline + animated morph.
- Area-error choropleth, adjacency-graph overlay.
- Verdict capture (recognizable / borderline / unusable + notes) → `harness/verdicts.json`.
- **Exit:** we can look at an Olson cartogram of NL provinces and the world and judge it.
  **Met.** Vite app with a dev-server endpoint persisting verdicts to
  `harness/verdicts.json`; canvas renderer with pan/zoom, morph, ghost, adjacency and
  choropleth overlays. Scene construction was pulled out of the DOM into `harness/scene.ts`
  and tested across all datasets: before/after geometry must stay aligned vertex for vertex,
  or the morph animates between mismatched features and every visual verdict is worthless.

### M3 — Contiguous #1: force-based (Sun 2020 / F4Carto, DCN 1985 lineage) ✅ done, with caveats
- **Topology-preserving densification pass first** (Duncan & Gastner 2025); without it long
  straight edges bend through neighbours and contiguity breaks on `grid`/`hex`/NUTS.
- Force model, iteration loop, convergence criterion, iteration callback + cancellation.
- Quadtree (d3-quadtree or own) with distance cutoff ⇒ near-linear.
- Shared-border integrity via coordinate dedup (identical input coords ⇒ identical output coords).
- Implementation notes: shared borders are welded by collapsing bit-identical
  coordinates (measured 23-48% of stored vertices in real data), so no arc extraction or
  snapping tolerance is needed. Forces use Dougenik's 1/(1+d) weight normalization but
  only over a tapered local neighbourhood found through a uniform grid, which keeps cost
  linear in vertex count. Plain additive superposition was tried instead and converges
  markedly worse. Per-vertex step caps tied to the dominant local region prevent folds at
  the source; rejecting whole steps after the fact stalled convergence outright.
- **Anti-blob work is part of this milestone, not a later tuning pass**: the radially
  symmetric DCN force kernel is exactly what rounds polygons into circles. Mitigations to
  implement and compare: distance-decayed forces with a hard cutoff, per-iteration step
  damping, and a shape-anchoring term that penalizes a vertex drifting from its position
  relative to its neighbours along the boundary.
- **Exit criteria, measured** (defaults, `missing: 'drop'`):

  | dataset | features | area err | p90 | topology err | compactness drift | detail | iterations | time |
  |---|---|---|---|---|---|---|---|---|
  | nl-provinces | 12 | 1.9% | 3% | 0.000 | -0.039 | 1.11 | 16, converged | 60 ms |
  | nuts0 | 36 | 5.7% | 9% | 0.000 | -0.031 | 1.09 | 60 | 110 ms |
  | nl-municipalities | 342 | 11.8% | 25% | 0.000 | -0.137 | 1.30 | 60 | 370 ms |
  | nuts2-20m | 292 | 13.9% | 28% | 0.000 | -0.064 | 1.15 | 60 | 237 ms |
  | nuts3-20m | 1333 | 34.5% | 70% | 0.000 | -0.071 | 1.10 | 60 | 672 ms |
  | world-110m | 177 | 27.4% | 65% | 0.000 | -0.035 | 1.11 | 60 | 333 ms |
  | grid (synthetic) | 100 | 4.4% | 9% | 0.000 | -0.330 | 1.74 | 60 | 61 ms |
  | hex (synthetic) | 400 | 2.1% | 4% | 0.019 | -0.191 | 1.19 | 60 | 331 ms |

  - **Contiguity: met, exactly.** Topology error is 0.000 everywhere (0.019 on the
    synthetic hex grid, where a handful of corner-touching cells separate). No folds
    survive into the output.
  - **Anti-blob: partly met, and the first summary metric was misleading.** The
    all-feature mean drift is negative on every dataset, which looked healthy, but on
    inspection the Dutch provinces show Utrecht at +0.113 and Zuid-Holland at +0.098
    while Drenthe sits at -0.29: growing regions round off, shrinking ones get ragged,
    and the mean cancels the two. Visually the Holland coastline bows outward and
    pinches at the provincial border. The metric now reports the mean drift **over the
    features that rounded** plus the max, which is what a reviewer actually sees, and
    per-feature drift is in the diagnostics.
    Radial forces about each region's centroid are the cause and no parameter removes
    it: smoothing the displacement field changes nothing (the field is already smooth),
    and raising `cutoff` to 20 with `shapeAnchor` 0.8 does help
    (Zuid-Holland +0.098 -> +0.073) but costs a great deal of area accuracy on dense
    data (NUTS 2 from 14.6% to 37.2%) and runs 3x slower. It is exposed as a documented
    trade-off rather than a new default. **The structural fix is the flow-based method
    (M5), which warps one global field instead of inflating each region about its own
    centre.** Detail retention above 1 means boundaries are
    *rougher* than a pure rescale, which is what a warp does to a straight edge; it is
    strongest on the synthetic grid, where every edge starts perfectly straight.
  - **Area error < 5%: met only on small, compact, moderately skewed datasets**
    (NL provinces, NUTS 0, hex). It is not met on NUTS 2/3, municipalities or the world.
    More iterations help but with diminishing returns (NUTS 2: 13.9% at 60, 8.3% at 200).
    The residual concentrates in small regions with very large values -- dense urban NUTS 2
    regions that must grow 50x. This is the known weakness of the force family, not a bug
    in this implementation, and it is the reason the flow-based method (M5) is the quality
    target rather than an optional extra. **Do not tune this further; build M5.**
  - Human verdicts: to be recorded in the harness, which now exposes the method and its
    parameters.

### M4 — Dorling / Demers ✅ done
- Circle/square sizing, quadtree collision relaxation, neighbour attraction.
- **Exit criteria, measured** (`missing: 'drop'`, defaults):

  | dataset | features | max area error | overlaps | orientation | time |
  |---|---|---|---|---|---|
  | nl-provinces | 12 | 5.8e-14% | 0 | 0.962 | 17 ms |
  | nuts0 | 36 | 2.9e-13% | 0 | 0.983 | 36 ms |
  | nuts2-20m | 292 | 8.0e-13% | 0 | 0.995 | 266 ms |
  | nl-municipalities | 342 | 5.4e-13% | 0 | 0.995 | 338 ms |
  | world-110m | 177 | 3.8e-11% | 0 | 0.972 | 271 ms |
  | nuts3-20m | 1333 | 2.3e-12% | 0 | 0.997 | 2468 ms |

  **All met**: world and NUTS 2 well under 1 s, zero overlaps everywhere, orientation
  far above 0.9. Areas are exact to floating point, which required solving the polygon
  circumradius so the drawn k-gon has the target area rather than the circle it is
  inscribed in.
- A `fill` factor (default 0.3) scales all symbols together. Circles whose areas sum to
  the whole map area cannot be packed into it -- the densest circle packing fills 90.7%
  of the plane and these symbols are additionally pinned near their true positions -- so
  without it the relaxation can never clear the last overlaps. Relative areas, and hence
  the area error, are untouched.
- The anti-blob metrics (F20a) report a large positive compactness drift for these
  methods and 100% of features rounder. That is correct and is left visible: these
  methods discard shape by construction, which is exactly why F20a makes them opt-in
  and never the default.

### M5 — Flow-based Gastner–Seguy–More ✅ done
0. Reuse the densification pass from M3.
1. Rasterize density onto a `2^k × 2^k` grid with sea padding and the standard
   density-averaging + blur.
2. DCT-II/DCT-III on top of an FFT; validate against a naive O(n²) DCT on small grids.
3. Diffusion in Fourier space; velocity field **v = −∇ρ/ρ** with bilinear sampling.
4. Adaptive Heun integrator with step-size control and the annealed blur schedule.
5. Advect all vertices; unproject; measure.
- Validate stage-by-stage against `go_cart` / `cartogram-cpp` outputs as an external oracle
  (run them once offline, commit their outputs as fixtures — **outputs only, no GPL code**).
- **Exit criteria, measured** (`missing: 'drop'`, grid 512 unless noted):

  | dataset | flow area err | dcn area err | flow rounding | dcn rounding | topology | flow time |
  |---|---|---|---|---|---|---|
  | nl-provinces | **0.25%** | 1.87% | +0.041 | +0.090 | 0.000 | 5.3 s |
  | nl-municipalities | **2.07%** | 11.90% | +0.093 | +0.092 | 0.000 | 17 s |
  | nuts2-20m | **10.04%** | 14.59% | +0.071 | +0.064 | 0.000 | 19 s |
  | world-110m | **8.66%** | 28.73% | +0.066 | +0.075 | 0.000 | 17 s |
  | grid (synthetic) | **0.90%** | 3.14% | +0.180 | +0.023 | 0.000 | 16 s |
  | nuts0 | 7.63% | **5.89%** | +0.027 | +0.017 | 0.000 | 17 s |

  - **Area error: met on NL, well improved elsewhere, not met everywhere.** Beats the
    force method on five of six datasets, by 3x to 7x on the ones that matter most.
    NUTS 0 is the exception and the reason is resolution: a country is only as accurate
    as the number of grid cells it covers, and NUTS 0 mixes Malta and Cyprus with
    France. Raising the grid helps monotonically (NUTS 2: 23.4% at 256, 10.0% at 512).
  - **Shape: met.** Rounding is roughly half the force method's on real maps, and
    shared borders are welded *by construction* -- one displacement field applied to
    every point, so identical coordinates have identical images. No vertex index, no
    snapping, no fold detection: none of the machinery M3 needed.
  - **Runtime: not met.** 5 s for 12 provinces at grid 512, 17 s for the larger sets,
    against a 2 s target. Cost is dominated by one 2D inverse cosine transform per
    integration step (600 steps by default). The obvious next step is the Web Worker
    offload of M6 plus a cheaper step schedule; the harness defaults to grid 256, which
    is interactive at 1-6 s.
- Implementation notes: diffusion is solved in the cosine basis, where the heat equation
  is diagonal and advancing to any time t is one multiply per coefficient. The velocity
  field uses central differences on the diffused grid rather than analytic sine/cosine
  transforms of the gradient -- the field is smooth by construction, and it halves the
  transforms per step. The outer loop matters more than any parameter: a single pass
  cannot converge because the density field is built from the map's *current* shape, so
  each pass re-rasterizes and halves the blur.

### M6 — Performance & scaling ✅ done
- **Benchmark suite** committed as `bench/run.mjs` (`npm run bench`), writing
  `bench/results.json` so later changes compare against a baseline rather than memory.
- **N1 confirmed empirically.**

  | vertices (25 features) | olson | dcn | flow (grid 128) |
  |---:|---:|---:|---:|
  | 100 | 0.2 ms | 23 ms | 311 ms |
  | 800 | 1.5 ms | 28 ms | 310 ms |
  | 6 400 | 7.8 ms | 39 ms | 334 ms |
  | 51 200 | 74.9 ms | 314 ms | 701 ms |

  | features (fixed detail) | olson | dorling | dcn | flow |
  |---:|---:|---:|---:|---:|
  | 100 | 1.0 ms | 19 ms | 30 ms | 294 ms |
  | 400 | 3.7 ms | 73 ms | 148 ms | 380 ms |
  | 1 600 | 10.6 ms | 581 ms | 383 ms | 562 ms |

  Olson is linear in vertices (512x vertices, 375x time). The flow method is almost flat
  in both, exactly as `a*V + b*(G log G)` predicts: its cost is the grid, which the user
  chooses, not the data.
- **Dorling was violating N1 and the benchmark caught it**: 0.43, 0.49, 1.61 ms per
  feature at 100, 400, 1600 features. Two causes, both fixed. Sweep cost scaled with the
  *largest* symbol, since every symbol searched a neighbourhood wide enough to reach it;
  symbols far above the median are now handled separately, of which there are few by
  definition. And the separation loop ran to a zero overlap *count*, which never
  terminates on dense data -- it burned the full 1000-sweep cap on everything above a few
  hundred symbols. It now stops on penetration *depth*, which falls monotonically, with
  over-relaxation to speed it up. Result: 0.37, 0.22, 0.37 ms per feature, and NUTS 3 from
  2446 ms to 685 ms with overlaps still exactly zero.
- **Web Worker offload** shipped: `CartogramWorker` (exported) plus the worker entry at
  `@edugis/cartogram/worker`. Progress and cancellation travel as messages, since functions and
  AbortSignals do not survive structured cloning. Cancelling supersedes a run without
  terminating the worker, so the next run does not pay to start one. The harness now runs
  every cartogram there and reports pass-by-pass progress instead of freezing.
- **Flow speedups**: a pass stops once the field is flat enough that vertices no longer
  move (each step costs a full inverse cosine transform -- 14 s of a 17 s run at grid 512),
  and passes stop when they no longer pay for themselves. NUTS 3 at grid 256 went from
  4141 ms to about 1300 ms. Left undone: the adaptive Runge-Kutta of the 2018 paper, which
  is the remaining lever on step count. Benchmarking against go-cart-wasm
  (`docs/BENCHMARK-GO-CART.md`) since put a number on that: their adaptive integrator
  reaches 0.03% area error on the Dutch provinces where we reach 0.20%, and 1.21% on
  NUTS 0 where we reach 5.51%. On the harder maps we are ahead (9.1% against 11.9% on
  NUTS 2). Implementing the adaptive integrator is the clearest remaining improvement.

### M7 — Robustness & release (1 week)
- Fuzz/property tests: holes, exclaves, antimeridian, degenerate slivers, zero/negative values,
  duplicate vertices, unclosed rings.
- Self-intersection detection + damping repair.
- Docs site with live examples, API reference, `README`, semver 1.0, npm publish.

Total ≈ 9–11 weeks of focused work; M0–M3 (~4 weeks) already produces a genuinely usable library.

## Public API sketch

```ts
import { cartogram } from '@edugis/cartogram';

const result = cartogram(featureCollection, {
  value: 'population',              // or (f) => number
  method: 'flow',                   // 'olson' | 'dcn' | 'dorling' | 'demers' | 'flow'
  project: 'equal-earth',           // 'none' | 'equal-earth' | 'laea' | custom d3 projection
  unproject: true,                  // return lon/lat
  missing: 'zero',                  // 'error' | 'zero' | 'mean' | 'drop'
  flow: { grid: 512, maxError: 0.01, blur: 'annealed' },
  onIteration: (i, err) => {},
  signal: abortController.signal,
});

result.featureCollection;  // GeoJSON out
result.diagnostics;        // per-feature target/achieved area, relative error
result.metrics;            // mean/max area error, shape distortion, runtime
```

## Risks

| Risk | Mitigation |
|---|---|
| Force methods round every region into a circular blob (F20a) | compactness-drift metric computed from M1 onward, so the regression is visible the moment a method is added; force kernels damped/cut off; Dorling kept opt-in |
| DCT/diffusion numerics are subtle; silent wrongness | stage-wise unit tests vs. naive transforms; fixture outputs from `cartogram-cpp` as an oracle |
| GPL contamination from reference implementations | read papers first, implement from the paper; only *outputs* used as fixtures; licence note in `CONTRIBUTING.md` |
| Real-world data topology (slivers, gaps, overlaps) breaks contiguity | topology index + explicit repair pass; NUTS/municipality datasets as the stress test |
| "Recognizability" is subjective | metrics + a committed human-verdict record so regressions are visible |
| Browser memory at grid 1024 + 10⁶ vertices | Float64Array everywhere, worker isolation, documented grid/LOD guidance |
