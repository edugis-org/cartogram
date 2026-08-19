# Changelog

## Unreleased

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

### Added

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
