# Changelog

## Unreleased

### Added

- **`fitLatitude` (default 85).** A cartogram moves regions off the graticule they came
  from, and in a plane nothing stops that leaving the world: on world countries sized by
  population, India and China grow enough to push Russia off the top of the map, and 1618
  of the returned points came back at ±90° because unprojecting an out-of-range
  coordinate clamps rather than fails. The result is now shrunk by the largest factor
  that brings every coordinate back inside the world — within ±85° of latitude and ±180°
  of longitude — and re-centred. It is a similarity, so area error, shape, topology and
  self-intersections are bit-identical, and a map that never left the world is
  byte-for-byte untouched. Both bounds are checked because which one bites depends on the
  plane: Lambert cylindrical runs out of latitude first, Equal Earth lets longitude
  escape to 203° while still inside 85 of latitude. Centring is what makes it cheap —
  scaling about the centre of mass presses the map against whichever edge it already
  touched.
- **Equal Earth**, and `projection: 'auto'` now picks it for world-scale data instead of
  Lambert cylindrical equal-area. Both are equal-area, so this cannot change whether the
  areas are right; what it changes is how well a square grid resolves the map. Lambert
  cylindrical flattens everything above 50° into wide thin slabs a cell cannot follow. At
  grid 512 the median area error goes from 0.600% to 0.440% on `world-110m`, 1.368% to
  1.354% on `world-50m` and 0.096% to 0.030% on NUTS 0, with the self-intersection count
  roughly halving on both world sets. Available by name as `projection: 'equal-earth'`;
  `'cylindrical-equal-area'` is unchanged and still selectable.
- **`grid: 'auto'` for the flow method.** Sizes the grid so the smallest region carrying
  real value gets at least one cell, ignoring regions whose value is negligible. Never
  goes below the default, capped at 1024. On NUTS 3 it picks 1024 over 512, which takes
  the median area error from 15.9% to 4.1%. `metrics.resolved.grid` reports the choice.
  The harness defaults to it, because at a coarse grid you are reviewing the grid rather
  than the method.

### Changed

- **`tolerance` default 0.02 → 0.2.** Tightening it made results *worse* as well as
  slower. Swept over all seven datasets in `data/` at grid 512, 0.2 beat 0.02 on the
  median area error of six and tied on the seventh, at half the runtime. The cause is an
  interaction rather than a design: a pass stops when the largest vertex movement *in one
  step* gets small, and that movement scales with the step size, so a tight tolerance
  ends the pass while the flow still has somewhere to go. Making the stopping rule
  step-size independent needs its own calibration sweep and is not done here.
- The `gradient` option was documented as buying 0.02 percentage points of area error for
  twice the runtime — a figure measured on the twelve Dutch provinces alone, where it is
  genuinely worth nothing. On NUTS 2 the same switch takes the median area error from
  1.334% to 0.412%. Documented with the measurements it actually has, including the cost:
  about 3x the runtime, and on world countries the self-intersection count goes from 17
  to 48.

## 0.1.2 — 2026-08-20

Work in progress: the flow method changed substantially, and the numbers moved in both
directions on purpose. See `docs/BENCHMARK-GO-CART.md`.

### Fixed

- **Multipart features were treated as a single point.** Olson scaled every part of a
  feature about the feature's combined centroid; France is thirteen polygons whose
  combined centre lies 942 km from mainland France, so its remote islands were hurled
  across the map in proportion to their distance. Each part is now scaled about its own
  centre, with the factor still taken from the feature's total area. Dorling anchors its
  symbol on the largest part rather than the combined centroid, and the force method
  takes its force sources per part (`sources: 'part' | 'feature'`).
- **Regions smaller than a grid cell inflated the flow's density field.** Each was given
  a full cell's worth of mass, which on NUTS 3 grew the total land area sixfold and
  compressed the surrounding ocean, dragging French Guiana thousands of kilometres
  towards Europe. Unresolvable regions are now mass-neutral. The median NUTS 3 region
  now moves 205 km rather than 1342 km, against 200 km for the reference implementation.
- **The finished map drifted in scale and position.** A cartogram fixes relative areas
  and leaves both free, and normalized area error cannot see either. Warp methods now
  match the input's total area and centre of mass (`preserveTotalArea`).
- The harness refused to draw go-cart's world map, and the dev server 404'd at `/`.

### Added

- Progressive grid refinement in the flow method: the grid starts at 128 and doubles
  each pass, with the blur schedule following it. Faster everywhere and more accurate on
  the harder maps.
- `goCartCartogram` at `@edugis/cartogram/go-cart` and the harness can run it as a
  method, so the reference implementation can be compared by eye rather than only in a
  table.
- `rewind`, `polygonArea`, `polygonCentroid`, `similarity`, `centreOfMass`,
  `selfIntersections` exported.
- `docs/READING-THE-METRICS.md` and `docs/BENCHMARK-GO-CART.md`.

### Changed

- **The flow method now integrates adaptively.** Heun with the Euler result it contains
  as an embedded error estimate, and a step size scaled to hold that estimate near a
  tolerance in grid cells (`tolerance`, default 0.02). The fixed geometric schedule it
  replaces had to be conservative everywhere to survive the violent early flow, and so
  spent most of its steps on the long uniform tail where nothing moves.
- **Region density now comes from exact polygon areas** rather than from the area of the
  grid cells a region happens to cover. The flow equalizes the field it is given, so a
  rasterized area off by a fraction of a boundary cell left the real polygon area off by
  the same fraction.

Together, at grid 512: NUTS 2 area error from 9.11% to 3.04%, world countries from 8.01%
to 5.76%, NUTS 0 from 5.51% to 2.44%, and NUTS 0 also 30% faster. The Dutch provinces are
unchanged at 0.20%, and no amount of extra integration moves them — see
`docs/BENCHMARK-GO-CART.md`.

- **The velocity field can be computed analytically** (`gradient: 'analytic'`), by
  differentiating the cosine series in the spectrum and evaluating the resulting sine
  series. It is *not* the default: measured, it moves the mean area error on the Dutch
  provinces from 0.198% to 0.174% and doubles the runtime. That difference is about a
  twentieth of a pixel on screen.

- **The warp methods now preserve the map's total area** (`preserveTotalArea`, default
  on). A cartogram fixes *relative* areas and leaves the absolute scale free, so the
  warps drifted: on NUTS 2 the flow method produced 1.50x the input's total area and
  the force method 0.88x. Normalized area error is blind to this; a reader comparing
  the result with the original is not. The correction is a uniform scale about the
  map's centre, so nothing else changes.
- **The value floor no longer inflates regions.** It gives every region a target of at
  least one grid cell so that sub-cell regions do not compound away to nothing, but it
  is now capped at the region's own area, so flooring can only prevent shrinkage. It
  previously blew a 12 km² London borough up to 21887 km².

### Also in this release

- `docs/READING-THE-METRICS.md`, translating the numbers into what a reader can actually
  see. Area error is quadratic in perceived size, so a mean below a couple of percent is
  invisible; the maximum, the rounding metrics and self-intersections are what matter.
- `goCartCartogram` at `@edugis/cartogram/go-cart`: drives the reference implementation
  (`go-cart-wasm`, an optional peer dependency) through this library's pipeline, returning
  the identical result shape with the same diagnostics and metrics.
- `rewind(featureCollection, 'rfc7946' | 'clockwise')`: ring winding, exported because
  `go_cart` requires the clockwise convention and fails silently without it.

## 0.1.1 — 2026-08-19

### Fixed

- **Dorling and Demers could hang forever** on nearly collinear input, such as two polar
  regions after an equal-area projection squashes them. The search radius is measured in
  grid cells, so a collapsing extent made it explode and the sweep looped over
  astronomically many cells, almost all of them out of range. Found by the new
  robustness suite.
- The dev server returned 404 at `/`. It now redirects to `/harness/`, which is what the
  production build has always done through a redirect file.

### Added

- **Self-intersection detection** (`metrics.selfIntersections`), reported by the CLI and
  the harness. This surfaces something worth knowing: the force method (`dcn`) folds
  boundaries locally on real data, which its ring-orientation check could not see, while
  the flow method introduces essentially none. Some self-intersections are present in the
  source data itself.
- A robustness suite: slivers, duplicate vertices, unclosed and wrongly-wound rings,
  nested holes, far-flung multipolygon parts, extreme value and area ratios, the
  antimeridian, the poles, and randomized inputs — across every method.
- Method-comparison and API documentation in the readme.

## 0.1.0

First release. Five methods (`flow`, `dcn`, `olson`, `dorling`, `demers`), equal-area
projections, topology-preserving densification, a Web Worker client, a metric suite and a
browser review harness.
