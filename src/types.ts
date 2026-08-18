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

export type MethodName = 'identity' | 'olson';

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

export type CartogramOptions = IdentityOptions | OlsonOptions;

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
}

export interface CartogramResult {
  featureCollection: FeatureCollection;
  diagnostics: FeatureDiagnostic[];
  metrics: CartogramMetrics;
  /** Non-fatal problems: dropped features, substituted values, clamped negatives. */
  warnings: string[];
}
