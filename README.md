# cartogram-ts

Turn GeoJSON into cartograms. TypeScript, browser-compatible, **zero runtime dependencies**.

Status: **M0 + M1 complete.** The pipeline, the Olson non-contiguous method and the metric
suite work end to end on real data. Contiguous methods (force-based, then flow-based) are next.

```ts
import { cartogram } from 'cartogram-ts';

const result = cartogram(featureCollection, {
  method: 'olson',        // 'identity' | 'olson'  (more to come)
  value: 'population',    // property name, or (feature, i) => number
  projection: 'auto',     // 'auto' | 'none' | 'laea' | 'cylindrical-equal-area'
  missing: 'error',       // 'error' | 'zero' | 'mean' | 'drop'
  negative: 'error',      // 'error' | 'clamp'
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
- **Equal-area projections**, written from the formulas with exact inverses: Lambert
  azimuthal for regional maps, Lambert cylindrical for near-global ones, auto-selected.
  Cartograms are about area, so this is a correctness requirement, not a nicety.
- **Metrics**: cartographic error with the literature's `max(o, w)` denominator, adjacency
  Jaccard topology error, and the anti-blob guard — Polsby–Popper compactness drift plus
  boundary-detail retention, which catch a method rounding regions into circles even when
  its area error looks perfect.
- **57 tests**, including the M1 exit criterion run over all 15 datasets in `data/`.

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
