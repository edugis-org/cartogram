# Changelog

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
