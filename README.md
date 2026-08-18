# cartogram-ts

Turn GeoJSON into cartograms. TypeScript, browser-compatible, **zero runtime dependencies**.

Status: **M0–M2 complete.** The pipeline, the Olson non-contiguous method, the metric suite and
the human review harness work end to end on real data. Contiguous methods (force-based,
then flow-based) are next.

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
