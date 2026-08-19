export interface DatasetSpec {
  /**
   * Path to the dataset, **relative to the page**, never rooted at `/`.
   *
   * The page lives at `<base>/harness/` and the data at `<base>/data/`, in development
   * and in the built app alike, so `../data/...` resolves correctly in both. An
   * absolute `/data/...` silently assumes the app is served from the domain root: it
   * works on the dev server and 404s the moment the app is deployed under any prefix,
   * such as a GitHub Pages project page.
   */
  url: string;
  label: string;
  group: 'real' | 'synthetic';
  /** Candidate cartogram attributes; the first is the default. */
  attributes: string[];
  /** Datasets with known gaps in the attribute need a missing-value policy. */
  hasMissing?: boolean;
  note?: string;
}

export const DATASETS: DatasetSpec[] = [
  {
    url: '../data/real/nl-provinces.geojson',
    label: 'Netherlands provinces (12)',
    group: 'real',
    attributes: ['POP_2021'],
    note: 'Small and familiar: the fastest recognizability check.',
  },
  {
    url: '../data/real/nl-municipalities.geojson',
    label: 'Netherlands municipalities (342)',
    group: 'real',
    attributes: ['POP'],
  },
  {
    url: '../data/real/nuts0-20m.geojson',
    label: 'EU NUTS 0 — countries (37)',
    group: 'real',
    attributes: ['POP_2021'],
    hasMissing: true,
  },
  {
    url: '../data/real/nuts2-20m.geojson',
    label: 'EU NUTS 2 — 1:20M (334)',
    group: 'real',
    attributes: ['POP_2021'],
    hasMissing: true,
  },
  {
    url: '../data/real/nuts2-03m.geojson',
    label: 'EU NUTS 2 — 1:3M (334, high detail)',
    group: 'real',
    attributes: ['POP_2021'],
    hasMissing: true,
    note: 'Same features as the 1:20M file: the level-of-detail comparison.',
  },
  {
    url: '../data/real/nuts3-20m.geojson',
    label: 'EU NUTS 3 (1514)',
    group: 'real',
    attributes: ['POP_2021'],
    hasMissing: true,
  },
  {
    url: '../data/real/world-110m.geojson',
    label: 'World countries 110m (177)',
    group: 'real',
    attributes: ['POP_EST', 'GDP_MD'],
    note: 'The most extreme value skew: the hardest recognizability test.',
  },
  {
    url: '../data/real/world-50m.geojson',
    label: 'World countries 50m (242)',
    group: 'real',
    attributes: ['POP_EST', 'GDP_MD'],
  },
  { url: '../data/synthetic/grid.geojson', label: 'Synthetic: grid (100)', group: 'synthetic', attributes: ['value'] },
  { url: '../data/synthetic/grid-large.geojson', label: 'Synthetic: grid large (1600)', group: 'synthetic', attributes: ['value'] },
  { url: '../data/synthetic/hex.geojson', label: 'Synthetic: hexagons (400)', group: 'synthetic', attributes: ['value'] },
  { url: '../data/synthetic/rings.geojson', label: 'Synthetic: rings with holes (8)', group: 'synthetic', attributes: ['value'] },
  { url: '../data/synthetic/archipelago.geojson', label: 'Synthetic: archipelago (20)', group: 'synthetic', attributes: ['value'] },
  {
    url: '../data/synthetic/degenerate.geojson',
    label: 'Synthetic: degenerate shapes (7)',
    group: 'synthetic',
    attributes: ['value'],
    hasMissing: true,
    note: 'Slivers, duplicate vertices, zero/null/negative values. Expected to be ugly.',
  },
  { url: '../data/synthetic/lod-1e2.geojson', label: 'Synthetic: LOD 1e2 (25)', group: 'synthetic', attributes: ['value'] },
  { url: '../data/synthetic/lod-1e3.geojson', label: 'Synthetic: LOD 1e3 (25)', group: 'synthetic', attributes: ['value'] },
  { url: '../data/synthetic/lod-1e4.geojson', label: 'Synthetic: LOD 1e4 (25)', group: 'synthetic', attributes: ['value'] },
  { url: '../data/synthetic/lod-1e5.geojson', label: 'Synthetic: LOD 1e5 (25)', group: 'synthetic', attributes: ['value'] },
];
