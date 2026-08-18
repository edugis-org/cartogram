# Test data — provenance, licence, attributes

All files are GeoJSON `FeatureCollection`s in EPSG:4326 (synthetic ones are planar
numbers in a lon/lat-plausible range). Every file carries its cartogram attribute
**inside the properties**, so it is self-sufficient.

## Real-world data (`data/real/`)

| File | Features | Cartogram attribute(s) | Source | Licence |
|---|---|---|---|---|
| `world-110m.geojson` | 177 | `POP_EST`, `GDP_MD` | [Natural Earth 110m admin-0 countries](https://github.com/nvkelso/natural-earth-vector) | Public domain (CC0) |
| `world-50m.geojson` | 242 | `POP_EST`, `GDP_MD` | Natural Earth 50m admin-0 countries | Public domain (CC0) |
| `nuts0-20m.geojson` | 37 | `POP_2021` | [Eurostat GISCO NUTS 2021, 1:20M](https://gisco-services.ec.europa.eu/distribution/v2/nuts/) | © EuroGeographics, free reuse with attribution |
| `nuts2-20m.geojson` | 334 | `POP_2021` | GISCO NUTS 2021 level 2, 1:20M | idem |
| `nuts2-03m.geojson` | 334 | `POP_2021` | GISCO NUTS 2021 level 2, **1:3M** (high detail, same features — LOD pair with the above) | idem |
| `nuts3-20m.geojson` | 1514 | `POP_2021` | GISCO NUTS 2021 level 3, 1:20M | idem |
| `nl-provinces.geojson` | 12 | `POP_2021` (via `NUTS2`) | Geometry [cartomap.github.io/nl](https://cartomap.github.io/nl/) (CBS generalised), population Eurostat | CC BY 4.0 (CBS) |
| `nl-municipalities.geojson` | 342 | `POP` | Geometry cartomap/CBS 2023, population [CBS OData 85984NED](https://opendata.cbs.nl/) | CC BY 4.0 (CBS) |

Population joins:
- NUTS: Eurostat `demo_r_pjanaggr3`, 2021, sex=T, age=TOTAL. Matched 36/37 (NUTS0),
  292/334 (NUTS2), 1333/1514 (NUTS3). Unmatched features get `POP_2021: null` —
  deliberately kept, because handling missing values is requirement F5 and these are
  real-world gaps (UK, overseas territories, extra-regio codes), not synthetic ones.
- NL municipalities: CBS 85984NED `AantalInwoners_5`, matched 342/342.

## Synthetic data (`data/synthetic/`)

Regenerate with `python3 data/generate-synthetic.py` (deterministic, seed 20260818).
Every feature has `id`, `name` and a numeric `value`.

| File | Features / vertices | Tests |
|---|---|---|
| `grid.geojson` | 100 / 500 | baseline regular tessellation, smooth value field + one 500× outlier |
| `grid-large.geojson` | 1600 / 8000 | feature-count scaling on a perfect tessellation |
| `hex.geojson` | 400 / 2800 | non-square tessellation, 6-way adjacency |
| `rings.geojson` | 8 / 975 | **polygons with holes**, nested containment |
| `archipelago.geojson` | 20 / 873 | **MultiPolygon**, far-flung disconnected parts, exclaves |
| `degenerate.geojson` | 7 / 73 | slivers, spiky star, duplicate vertices, tiny-area/huge-value, **zero, null and negative values** |
| `lod-1e2 … lod-1e5.geojson` | 25 features, 125→51225 vertices | **level-of-detail ladder**: identical map and identical values at four detail levels. Output shape should converge as detail rises, and runtime should grow linearly in vertices while being flat in feature count. |

## Notes for use

- The synthetic `degenerate.geojson` is expected to *fail* under `missing: 'error'`; that
  is the point of the file.
- `nuts2-20m` vs `nuts2-03m` and the `lod-*` ladder are the two designed LOD comparisons.
- `world-*` has the most extreme value skew (China/India vs. Vatican-scale states) and is
  the hardest recognizability test.
