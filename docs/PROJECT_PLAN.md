# Project plan — `cartogram-ts`

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
- **Exit:** `import { cartogram } from 'cartogram-ts'` works and returns input unchanged for `method: 'identity'`.

### M1 — Pipeline + Olson + metrics ✅ done
- Value extraction, missing-value policies, equal-area projection step.
- `olson` method (scale about centroid).
- Metrics: area error (mean/max/percentiles), **compactness drift and boundary-detail
  retention (the anti-blob guard, F20a/F20b)**, runtime, vertex count.
- CLI: `cartogram-ts run data/x.geojson --value pop --method olson -o out.geojson`.
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
  - **Anti-blob: met.** Compactness drift is negative on every dataset, i.e. nothing is
    being rounded towards a circle. Detail retention above 1 means boundaries are
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

### M4 — Dorling / Demers (0.5 week)
- Circle/square sizing, quadtree collision relaxation, neighbour attraction.
- **Exit:** world + NUTS-2 run in < 1 s, no overlaps, orientation correlation > 0.9.

### M5 — Flow-based Gastner–Seguy–More (3–4 weeks, the main event)
0. Reuse the densification pass from M3.
1. Rasterize density onto a `2^k × 2^k` grid with sea padding and the standard
   density-averaging + blur.
2. DCT-II/DCT-III on top of an FFT; validate against a naive O(n²) DCT on small grids.
3. Diffusion in Fourier space; velocity field **v = −∇ρ/ρ** with bilinear sampling.
4. Adaptive Heun integrator with step-size control and the annealed blur schedule.
5. Advect all vertices; unproject; measure.
- Validate stage-by-stage against `go_cart` / `cartogram-cpp` outputs as an external oracle
  (run them once offline, commit their outputs as fixtures — **outputs only, no GPL code**).
- **Exit:** mean area error < 1% on world/NUTS/NL; shape distortion **and compactness drift**
  below the force method's; world 110m under 2 s in a browser worker at grid 512.

### M6 — Performance & scaling (1 week)
- Benchmark suite over the LOD ladder (10²…10⁶ vertices; 12…1500 features).
- Confirm empirically: runtime ≈ a·V + b·(G log G), i.e. **near-linear in feature count**.
- Web Worker offload with transferable buffers; optional streaming progress.

### M7 — Robustness & release (1 week)
- Fuzz/property tests: holes, exclaves, antimeridian, degenerate slivers, zero/negative values,
  duplicate vertices, unclosed rings.
- Self-intersection detection + damping repair.
- Docs site with live examples, API reference, `README`, semver 1.0, npm publish.

Total ≈ 9–11 weeks of focused work; M0–M3 (~4 weeks) already produces a genuinely usable library.

## Public API sketch

```ts
import { cartogram } from 'cartogram-ts';

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
