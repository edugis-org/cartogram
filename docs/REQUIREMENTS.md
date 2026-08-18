# Requirements — `@edugis/cartogram`

## 1. Purpose

A TypeScript library, usable in the browser (and Node), that transforms a GeoJSON
`FeatureCollection` into a **cartogram**: a map in which the area of each feature is
rescaled to be proportional to a numeric attribute of that feature, while the map
remains visually recognizable.

## 2. Functional requirements

### 2.1 Input

| # | Requirement |
|---|---|
| F1 | Input is a valid GeoJSON `FeatureCollection` (RFC 7946). |
| F2 | Geometries: `Polygon` and `MultiPolygon`. `GeometryCollection` containing only these SHOULD be accepted. Points/lines are passed through untouched (or optionally warped along with the field). |
| F3 | The cartogram variable is a numeric property on each feature, selected by property name or by an accessor function `(feature) => number`. |
| F4 | Arbitrary levels of detail must be supported: from ~20-vertex synthetic shapes to full-resolution NUTS/Natural Earth 10m geometry (10^5–10^6 vertices). |
| F5 | Missing / null / zero / negative values must be handled by an explicit, documented policy (`error` \| `zero` \| `mean` \| `drop`), not silently. |
| F6 | Input may be in any projected CRS supplied as plain coordinates; for lon/lat input the library MUST offer an internal projection step (equal-area default, e.g. Lambert azimuthal or Equal Earth) because cartogram algorithms operate on planar area. |
| F7 | Features may be non-contiguous (islands, exclaves) and the collection may contain topological gaps/overlaps found in real data. |

### 2.2 Output

| # | Requirement |
|---|---|
| F8 | Output is a GeoJSON `FeatureCollection` with the same feature count, same `id`/properties, and the same geometry *types* as the input (contiguous methods) — or replacement geometry (non-contiguous / Dorling / mosaic methods). |
| F9 | Output carries per-feature diagnostics: target area, achieved area, relative area error. |
| F10 | Output coordinates are in the working (projected) CRS by default, with an option to unproject back to lon/lat. |
| F11 | Deterministic: same input + same options ⇒ byte-identical output. |

### 2.3 Algorithms

| # | Requirement |
|---|---|
| F12 | At least one **contiguous** area-cartogram method (diffusion-based, Gastner–Newman / Gastner–Seguy–More "fast flow-based"). |
| F13 | At least one **non-contiguous** method (Olson 1976 — scale each polygon about its centroid). Trivial, O(n), useful baseline. |
| F14 | At least one **Dorling / Demers** circle- or square-based method with collision relaxation. |
| F15 | Optional: **rubber-sheet / Dougenik–Chrisman–Niemeyer (1985)** force-based contiguous cartogram — cheap, shape-preserving-ish, a good default for mid-size data. |
| F16 | Pluggable API: all methods behind one `cartogram(fc, options)` entry point with `method` discriminator; each method also exported standalone for tree-shaking. |
| F17 | Iterative methods must expose iteration callbacks so a UI can animate/inspect progress, and support cancellation. |

### 2.4 Topology

| # | Requirement |
|---|---|
| F18 | Contiguous methods must not tear shared borders: internal boundaries stay coincident. Implementation approach: build a shared-vertex/topology index (TopoJSON-style arc extraction) or warp a global displacement field sampled at every vertex, so identical coordinates map identically. |
| F19 | No self-intersections introduced in the output; if a method can fold, detect and report (and optionally repair by damping the step). |
| F20a | **No blob/circle degeneration.** Several well-known methods (Dougenik–Chrisman–Niemeyer and the whole force family, and Dorling by construction) pull polygons towards circles: coastal detail is smoothed away and every country ends up a rounded blob. This is a **failure**, not a stylistic choice, and must be actively prevented and measured, not left to parameter luck. Concretely: (a) compactness must not systematically increase — see the compactness-drift metric in §4.1; (b) methods whose force kernel is radially symmetric about a centroid must be damped, distance-weighted or replaced by a field-based warp; (c) shape-abstracting methods (Dorling, Demers) are opt-in only and never the default. |
| F20b | **Boundary detail must survive.** Vertex count per feature must be preserved (no implicit simplification), and the local shape of a boundary segment must remain recognizable: high-frequency coastline detail may be displaced by the warp but must not be smoothed away. |
| F20 | **Topology-preserving line densification** must run before any warp-based method (Duncan & Gastner 2025). Warping only the existing vertices lets long straight edges bend through neighbouring regions, breaking F18/F19. Densification target spacing is derived from the grid/force length scale and is a documented option. |

## 3. Non-functional requirements

| # | Requirement |
|---|---|
| N1 | **Near-linear time in feature count.** Grid/FFT-based diffusion is `O(V + G log G)` where `V` = vertex count and `G` = grid cells (a *constant* w.r.t. feature count, chosen by user resolution). Force-based methods must use a spatial index (quadtree / Barnes–Hut) to avoid the naive `O(n^2)` pairwise loop. |
| N2 | Memory linear in vertex count + grid size. Streaming not required. |
| N3 | Pure TypeScript, ESM, zero required native deps; must run in a browser without Node built-ins. Bundled size target < 100 kB min+gzip for the core. |
| N4 | Optional Web Worker offloading; the heavy loop must be worker-safe (no DOM access) and support transferable `Float64Array` buffers. |
| N5 | Dependencies kept minimal and browser-safe; permissive licences only (MIT/BSD/ISC/Apache-2.0). Licences of the reference implementations, verified: `go_cart` is an *adapted MIT* licence (extra condition: cite Gastner, Seguy & More 2018 for generated images), `go-cart-wasm` is MIT, and only `cartogram-cpp` is **AGPL-3.0**. We implement from the papers in any case. |
| N6 | Public API fully typed; `geojson` types from `@types/geojson`. |
| N7 | Node ≥ 20, ES2022 target, works under Vite/webpack/rollup and via CDN. |

## 4. Quality assessment requirements

Correctness is necessary but not sufficient — the map must remain **recognizable**.

### 4.1 Quantitative metrics (computed automatically per run)

Metric definitions follow Nusrat & Kobourov (2016) **verbatim**, so our numbers are
comparable with the literature (see `docs/STAR-2016-REVIEW.md` §2):

- **Cartographic error**, with `o(v)` = achieved normalized area, `w(v)` = desired value:
  average `(1/|V|)·Σ |o−w| / max{o,w}` and maximum `max_v |o−w| / max{o,w}`.
  Note the `max{o,w}` denominator — **not** `w` — which bounds each term in [0,1].
  Also report percentiles.
- **Topological error**: `1 − |E_c ∩ E_m| / |E_c ∪ E_m|` over adjacency edge sets
  (Jaccard distance of the adjacency graphs). Plus a count of introduced self-intersections.
- **Shape distortion**: Hamming distance (area of the symmetric difference after
  normalizing scale and position) as the primary measure, with turning-function distance
  as a secondary. The normalization must be documented — the survey leaves it unpinned.
- **Polygonal complexity**: corner count per region, input vs. output.
- **Compactness drift** (the anti-blob guard, requirement F20a). Per feature, the
  Polsby–Popper compactness `C = 4·pi·A / P^2` (1 for a circle, lower for a
  ragged shape), measured before and after. Report the mean and max of
  `C_out − C_in` and the fraction of features whose compactness rose.
  **A method that drives `C_out` towards 1 is rounding the map into blobs and fails,
  however good its area error is.** Target: mean drift <= 0.05, no systematic
  positive bias across a dataset.
- **Boundary-detail retention**: ratio of output to input perimeter after
  normalizing for the feature's area change (`P_out / (P_in · sqrt(A_out/A_in))`).
  Values well below 1 mean detail has been smoothed away.
- **Global orientation preservation**: correlation of relative centroid positions
  (Procrustes / rank correlation of x and y ordering).
- **Runtime & memory**, reported against vertex count and feature count.

### 4.2 Human visual assessment (required)

- A browser-based **review harness** renders input vs. output side by side and
  overlaid, per dataset × method × parameter set.
- Reviewer can toggle: original outline ghost, adjacency graph, area-error choropleth,
  animated morph input→output.
- Reviewer records a verdict per run (recognizable / borderline / unusable) plus notes;
  verdicts stored as JSON in the repo so regressions are visible over time.
- A "golden set" of screenshots per dataset/method is committed for visual regression.

## 5. Test data requirements

| Dataset | Purpose |
|---|---|
| World countries (Natural Earth 110m / 50m / 10m) with population + GDP | scale + LOD sweep, wildly skewed values, tiny + huge features |
| EU NUTS (levels 0/1/2/3, multiple resolutions from Eurostat GISCO) | dense contiguous tessellation, many features, real topology |
| Netherlands provinces (12) | small, familiar, fast iteration, human recognizability check |
| Netherlands municipalities (~340) | mid-size contiguous |
| Synthetic shapes | controlled complexity: regular grid, hexagons, concentric rings, a shape with a hole, a multipolygon with far-flung islands, degenerate slivers, 10^2…10^6 vertex versions of the same shape |

All test datasets must carry the cartogram attribute **inside** the GeoJSON properties,
so a file is self-sufficient. Datasets are stored under `data/`, with provenance and
licence recorded in `data/SOURCES.md`.

## 6. Out of scope (v1)

- Value-by-alpha maps, gridded/mosaic cartograms (hexmaps), flow maps.
- Server-side rendering to raster.
- Automatic label placement.
