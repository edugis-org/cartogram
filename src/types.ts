import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';

/** The only geometry types a cartogram method can transform. */
export type AreaGeometry = Polygon | MultiPolygon;
export type AreaFeature = Feature<AreaGeometry>;

/** How to obtain the cartogram variable for a feature. */
export type ValueAccessor = string | ((feature: Feature, index: number) => number | null | undefined);

/**
 * Policy for features whose value is missing, null, NaN or non-finite.
 * - `error`  throw (default: the user should know)
 * - `zero`   treat as 0 (region collapses towards a point)
 * - `mean`   substitute the mean of the present values
 * - `drop`   remove the feature from the output entirely
 */
export type MissingPolicy = 'error' | 'zero' | 'mean' | 'drop';

/** Planar working coordinate system. */
export type ProjectionName = 'auto' | 'none' | 'laea' | 'cylindrical-equal-area';

export type MethodName = 'identity' | 'olson' | 'dcn' | 'dorling' | 'demers' | 'flow';

export interface CommonOptions {
  /** Property name or accessor yielding the numeric cartogram variable. */
  value: ValueAccessor;
  /** What to do about missing values. Default `error`. */
  missing?: MissingPolicy;
  /** How to treat negative values: `error` (default) or `clamp` to zero. */
  negative?: 'error' | 'clamp';
  /**
   * Equal-area projection applied before the transform. Cartograms are about area,
   * so lon/lat input MUST be projected or the result is wrong. Default `auto`:
   * `none` if the coordinates are not lon/lat, cylindrical equal-area for
   * near-global extents, otherwise Lambert azimuthal equal-area centred on the data.
   */
  projection?: ProjectionName;
  /** Return coordinates in the input CRS. Default `true`. */
  unproject?: boolean;
  /** Compute quality metrics (adds a pass over the geometry). Default `true`. */
  metrics?: boolean;
  /**
   * Insert vertices along long boundary edges before warping, in a way that keeps
   * shared borders bit-identical (Duncan & Gastner 2025). Warping only the existing
   * vertices lets a long straight edge cut through its neighbours.
   * `auto` (the default) enables it for warp-based methods and skips it for methods
   * that move whole features rigidly; a number sets the spacing in working-plane
   * units; `false` disables it.
   */
  densify?: 'auto' | number | false;
  /**
   * Also return the projected (and densified) input geometry as `result.baseline`.
   * Needed to compare or morph input against output vertex for vertex, since
   * densification changes the vertex count. Default `false`.
   */
  includeBaseline?: boolean;
}

export interface IdentityOptions extends CommonOptions {
  method: 'identity';
}

export interface OlsonOptions extends CommonOptions {
  method: 'olson';
  /**
   * Global multiplier applied to every scale factor. Olson's own practice was to
   * scale so the largest region keeps its original size (`fit: 'max'`); `fit: 'total'`
   * (default) preserves the total area of the map instead.
   */
  fit?: 'total' | 'max';
}

export interface DcnOptions extends CommonOptions {
  method: 'dcn';
  /** Maximum iterations. Default 60. */
  iterations?: number;
  /** Stop once the mean cartographic error reaches this. Default 0.02 (2%). */
  targetError?: number;
  /** Influence radius as a multiple of a region's own radius. Default 5. */
  cutoff?: number;
  /** Step size multiplier. Default 1. Lower it if the map folds. */
  damping?: number;
  /**
   * Smoothing passes over the displacement field along boundaries. Default 2.
   * Radial forces bow straight edges into arcs; smoothing the displacement makes
   * neighbouring vertices travel together so boundaries move roughly rigidly.
   */
  smoothing?: number;
  /**
   * Anti-blob strength, 0..1. Default 0.25. The force field is smooth and slowly
   * erases boundary detail, which is what rounds regions into circles; this puts the
   * detail back at the region's new scale. 0 reproduces textbook DCN, blobbing and all.
   */
  shapeAnchor?: number;
  /** Progress callback, for animating or inspecting convergence (F17). */
  onIteration?: (iteration: number, meanError: number) => void;
  /** Cancellation (F17). */
  signal?: AbortSignal;
}

/**
 * Dorling (1996) circles / Demers squares. Shape is discarded entirely, so this is
 * opt-in only and never a default (requirement F20a). Areas are exact; readability
 * depends on relative position, which `metrics.orientation` measures.
 */
export interface DorlingOptions extends CommonOptions {
  method: 'dorling' | 'demers';
  /** Maximum relaxation iterations. Default 200. */
  iterations?: number;
  /** Pull back towards the region's true position, 0..1. Default 0.15. */
  anchor?: number;
  /** Pull originally-adjacent regions back into contact, 0..1. Default 0.3. */
  attraction?: number;
  /** Overlap resolution strength, 0..1. Default 1. */
  repulsion?: number;
  /** Vertices per circle. Default 64. Ignored for squares. */
  segments?: number;
  /**
   * Total symbol area as a fraction of the map area. Default 0.3. Circles summing to
   * the full map area cannot be packed into it, so relaxation would never clear the
   * last overlaps. Relative areas, and therefore the area error, are unaffected.
   */
  fill?: number;
  onIteration?: (iteration: number, maxMove: number) => void;
  signal?: AbortSignal;
}

/**
 * Flow-based contiguous cartogram (Gastner, Seguy & More 2018). The quality target:
 * shared borders cannot tear and regions do not round off, both by construction.
 */
export interface FlowOptions extends CommonOptions {
  method: 'flow';
  /** Grid resolution per side, a power of two. Default 512. Higher = finer, slower. */
  grid?: number;
  /** Domain size as a multiple of the map's larger dimension. Default 1.5. */
  padding?: number;
  /** Stop once the mean cartographic error reaches this. Default 0.01. */
  targetError?: number;
  /** Cap on integration steps within one pass. Default 200. */
  stepsPerRun?: number;
  /**
   * How the velocity field is obtained: `differences` (default) uses central
   * differences on the reconstructed density; `analytic` differentiates the cosine
   * series in the spectrum, which is exact for the represented field but costs three
   * inverse transforms per step. Measured, `analytic` buys 0.02 percentage points of
   * area error for twice the runtime — invisible either way.
   */
  gradient?: 'analytic' | 'differences';
  /**
   * Local error tolerance of the adaptive step, in grid cells. Default 0.02. Tighter
   * is more accurate and costs more steps, each of which is an inverse cosine
   * transform — the dominant expense of this method.
   */
  tolerance?: number;
  /** Passes over the whole flow, each re-rasterizing the current map. Default 10. */
  runs?: number;
  /** Blur of the first pass, in cells; halves each pass. Default 4. */
  blur?: number;
  onIteration?: (step: number, meanError: number) => void;
  signal?: AbortSignal;
}

export type CartogramOptions =
  | IdentityOptions
  | OlsonOptions
  | DcnOptions
  | DorlingOptions
  | FlowOptions;

/** Per-feature diagnostics, in the working (projected) plane. */
export interface FeatureDiagnostic {
  index: number;
  id: string | number | undefined;
  /** Raw cartogram variable after the missing-value policy. */
  value: number;
  /** Area of the input geometry, projected plane units. */
  inputArea: number;
  /** Area the output geometry should have to be exactly proportional. */
  targetArea: number;
  /** Area the output geometry actually has. */
  outputArea: number;
  /**
   * Cartographic error for this feature, Nusrat & Kobourov (2016):
   * |o - w| / max(o, w) with o, w the achieved and desired *normalized* areas.
   */
  error: number;
  /** True if this feature's value was substituted by the missing-value policy. */
  substituted: boolean;
  /**
   * Change in Polsby-Popper compactness for this feature. Positive means it became
   * rounder; a large positive value on a growing region is the blob failure (F20a)
   * that aggregate metrics hide.
   */
  compactnessDrift?: number;
}

export interface AreaErrorMetrics {
  /** Mean over features of |o - w| / max(o, w). */
  mean: number;
  max: number;
  median: number;
  p90: number;
}

export interface TopologyMetrics {
  /** Jaccard distance of the adjacency graphs: 1 - |Ec n Em| / |Ec u Em|. */
  error: number;
  inputEdges: number;
  outputEdges: number;
  sharedEdges: number;
}

export interface CartogramMetrics {
  areaError: AreaErrorMetrics;
  topology?: TopologyMetrics;
  /**
   * Shape-preservation guard (requirements F20a/F20b). Compactness is Polsby-Popper
   * 4*pi*A/P^2, which is 1 for a circle.
   *
   * Watch `meanPositiveDrift` and `maxCompactnessDrift`, not `meanCompactnessDrift`:
   * on a real map the regions that grow round off while the regions that shrink get
   * more ragged, so the plain mean cancels out and reports a healthy-looking negative
   * number while individual regions are visibly turning into discs.
   * `meanDetailRetention` well below 1 means boundary detail has been smoothed away.
   */
  shape?: {
    meanCompactnessDrift: number;
    maxCompactnessDrift: number;
    meanPositiveDrift: number;
    fractionRounder: number;
    meanDetailRetention: number;
  };
  /**
   * Relative-position preservation: Spearman rank correlation of feature centroids
   * before and after, per axis. 1 means every region kept its north/south and
   * east/west ordering. Decisive for the shape-abstracting methods, which are only
   * readable because the circles stay where the regions were.
   */
  orientation?: { x: number; y: number; mean: number };
  /**
   * Boundary segments that cross another segment of the same ring (F19). A warp can
   * fold a boundary over itself, producing a polygon that is syntactically valid but
   * geometrically nonsense. Should be 0; counting stops at 1000.
   */
  selfIntersections?: number;
  featureCount: number;
  vertexCount: number;
  /** Milliseconds spent inside cartogram(), excluding metric computation. */
  runtimeMs: number;
  /** Vertices inserted by densification, and the spacing used. */
  densification?: { inserted: number; spacing: number };
}

export interface IterationReport {
  iterations: number;
  meanError: number;
  converged: boolean;
  /** Times a step had to be halved because it would have folded a ring. */
  foldRetries: number;
  /** Dorling/Demers: pairs still overlapping when relaxation stopped. */
  overlaps?: number;
  /** Flow: diffusion time reached, and the fraction of the grid that was sea. */
  diffusionTime?: number;
  seaFraction?: number;
}

export interface CartogramResult {
  featureCollection: FeatureCollection;
  /**
   * The projected, densified input, when `includeBaseline` is set. Aligned with the
   * output vertex for vertex, so the two can be compared or morphed directly.
   */
  baseline?: FeatureCollection;
  /** Convergence detail for iterative methods. */
  iteration?: IterationReport;
  diagnostics: FeatureDiagnostic[];
  metrics: CartogramMetrics;
  /** Non-fatal problems: dropped features, substituted values, clamped negatives. */
  warnings: string[];
}
