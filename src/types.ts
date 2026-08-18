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

export type MethodName = 'identity' | 'olson' | 'dcn';

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

export type CartogramOptions = IdentityOptions | OlsonOptions | DcnOptions;

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
   * 4*pi*A/P^2, which is 1 for a circle. If `meanCompactnessDrift` is clearly positive
   * and `fractionRounder` approaches 1, the method is rounding regions into blobs and
   * has failed, however low its area error. `meanDetailRetention` well below 1 means
   * boundary detail has been smoothed away.
   */
  shape?: {
    meanCompactnessDrift: number;
    maxCompactnessDrift: number;
    fractionRounder: number;
    meanDetailRetention: number;
  };
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
