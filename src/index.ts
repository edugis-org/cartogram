import type { Feature, FeatureCollection, GeoJsonObject } from 'geojson';
import type {
  CartogramMetrics,
  CartogramOptions,
  CartogramResult,
  FeatureDiagnostic,
  IterationReport,
} from './types.ts';
import { pack, unpack, cloneCoords, vertexCount } from './geometry/flat.ts';
import { densify, autoSpacing } from './topology/densify.ts';
import { allFeatureAreas } from './geometry/area.ts';
import { partition } from './io/validate.ts';
import { extractValues } from './io/values.ts';
import { chooseProjection, projectInPlace, unprojectInPlace } from './io/project.ts';
import { olson } from './methods/olson.ts';
import { dcn, DCN_DEFAULTS } from './methods/dcn.ts';
import { dorling, DORLING_DEFAULTS } from './methods/dorling.ts';
import { cartographicError } from './metrics/area.ts';
import { topologyError } from './metrics/topology.ts';
import { shapePreservation } from './metrics/shape.ts';
import { orientationPreservation } from './metrics/orientation.ts';

export * from './types.ts';
export { pack, unpack } from './geometry/flat.ts';
export { featureArea, featureCentroid, allFeatureAreas, bbox } from './geometry/area.ts';
export { cartographicError } from './metrics/area.ts';
export { topologyError, adjacency } from './metrics/topology.ts';
export { shapePreservation, compactness, featurePerimeter } from './metrics/shape.ts';
export { orientationPreservation } from './metrics/orientation.ts';
export { laea, cylindricalEqualArea, chooseProjection } from './io/project.ts';
export { densify, autoSpacing } from './topology/densify.ts';
export { buildVertexIndex, sharedFraction } from './topology/vertices.ts';

/**
 * Turn a GeoJSON FeatureCollection into a cartogram: feature areas rescaled to be
 * proportional to a numeric attribute.
 *
 * Pipeline: validate -> extract values -> project to an equal-area plane ->
 * transform -> measure -> unproject -> rebuild GeoJSON.
 *
 * Non-areal features (points, lines, null geometry) pass through untouched and keep
 * their position in the output collection.
 */
export function cartogram(input: GeoJsonObject, options: CartogramOptions): CartogramResult {
  const warnings: string[] = [];
  const { collection, area, passthrough } = partition(input);

  if (passthrough.length > 0) {
    warnings.push(`${passthrough.length} non-areal features passed through untransformed`);
  }

  // --- values -----------------------------------------------------------------
  const areaFeatures = area.map((a) => a.feature);
  const { values, substituted, dropped, warnings: valueWarnings } = extractValues(
    areaFeatures,
    options.value,
    options.missing ?? 'error',
    options.negative ?? 'error',
  );
  warnings.push(...valueWarnings);

  const dropSet = new Set(dropped);
  const kept = area.filter((_, i) => !dropSet.has(i));
  const keptValues = Float64Array.from(
    Array.from(values).filter((_, i) => !dropSet.has(i)),
  );
  const keptSubstituted = substituted.filter((_, i) => !dropSet.has(i));

  // --- geometry ---------------------------------------------------------------
  let packed = pack(kept.map((k) => k.feature));
  const projection = chooseProjection(packed, options.projection ?? 'auto');
  projectInPlace(packed, projection);

  // Densify before warping, never after: a long straight edge moved only at its
  // endpoints cuts through its neighbours (F20, Duncan & Gastner 2025). Methods that
  // move whole features rigidly, or replace their geometry outright, cannot bend an
  // edge, so they skip it by default.
  const warps = options.method === 'dcn';
  const requested = options.densify ?? 'auto';
  const spacing =
    requested === false ? 0 : requested === 'auto' ? (warps ? autoSpacing(packed) : 0) : requested;
  let densification: { inserted: number; spacing: number } | undefined;
  if (spacing > 0) {
    const d = densify(packed, spacing);
    packed = d.geometry;
    densification = { inserted: d.inserted, spacing: d.spacing };
  }

  const before = options.metrics === false && !options.includeBaseline ? null : cloneCoords(packed);
  const inputAreas = allFeatureAreas(packed);

  // --- transform --------------------------------------------------------------
  const t0 = now();
  let targetAreas: Float64Array;
  let iteration: IterationReport | undefined;
  switch (options.method) {
    case 'identity':
      targetAreas = inputAreas.slice();
      break;
    case 'olson':
      targetAreas = olson(packed, keptValues, { fit: options.fit ?? 'total' });
      break;
    case 'dcn': {
      const report = dcn(packed, keptValues, {
        iterations: options.iterations ?? DCN_DEFAULTS.iterations,
        targetError: options.targetError ?? DCN_DEFAULTS.targetError,
        cutoff: options.cutoff ?? DCN_DEFAULTS.cutoff,
        damping: options.damping ?? DCN_DEFAULTS.damping,
        shapeAnchor: options.shapeAnchor ?? DCN_DEFAULTS.shapeAnchor,
        onIteration: options.onIteration,
        signal: options.signal,
      });
      targetAreas = report.targetAreas;
      iteration = {
        iterations: report.iterations,
        meanError: report.meanError,
        converged: report.converged,
        foldRetries: report.foldRetries,
      };
      break;
    }
    case 'dorling':
    case 'demers': {
      const report = dorling(packed, keptValues, {
        shape: options.method === 'demers' ? 'square' : 'circle',
        iterations: options.iterations ?? DORLING_DEFAULTS.iterations,
        anchor: options.anchor ?? DORLING_DEFAULTS.anchor,
        attraction: options.attraction ?? DORLING_DEFAULTS.attraction,
        repulsion: options.repulsion ?? DORLING_DEFAULTS.repulsion,
        segments: options.segments ?? DORLING_DEFAULTS.segments,
        fill: options.fill ?? DORLING_DEFAULTS.fill,
        onIteration: options.onIteration,
        signal: options.signal,
      });
      // This method replaces the geometry rather than moving it, so the packed
      // buffers are swapped wholesale. The metrics still work: they compare features,
      // not vertices, and never assume both sides have the same vertex count.
      packed = report.geometry;
      targetAreas = report.targetAreas;
      iteration = {
        iterations: report.iterations,
        meanError: 0,
        converged: report.converged,
        foldRetries: 0,
        overlaps: report.overlaps,
      };
      if (report.overlaps > 0) {
        warnings.push(`${report.overlaps} pairs still overlap after relaxation`);
      }
      break;
    }
    default: {
      const exhaustive: never = options;
      throw new Error(`unknown method: ${JSON.stringify(exhaustive)}`);
    }
  }
  const runtimeMs = now() - t0;

  // --- measure (in the projected plane, before unprojecting) ------------------
  const outputAreas = allFeatureAreas(packed);
  const { perFeature: errors, summary } = cartographicError(outputAreas, keptValues);

  const metrics: CartogramMetrics = {
    areaError: summary,
    featureCount: packed.featCount,
    vertexCount: vertexCount(packed),
    runtimeMs,
    ...(densification ? { densification } : {}),
  };

  if (before) {
    metrics.topology = topologyError(before, packed);
    metrics.orientation = orientationPreservation(before, packed);
    const shape = shapePreservation(before, packed);
    // Anti-blob guard (F20a/F20b): compactness must not systematically rise.
    metrics.shape = {
      meanCompactnessDrift: shape.meanCompactnessDrift,
      maxCompactnessDrift: shape.maxCompactnessDrift,
      fractionRounder: shape.fractionRounder,
      meanDetailRetention: shape.meanDetailRetention,
    };
  }

  const diagnostics: FeatureDiagnostic[] = kept.map((k, i) => ({
    index: k.index,
    id: k.feature.id,
    value: keptValues[i]!,
    inputArea: inputAreas[i]!,
    targetArea: targetAreas[i]!,
    outputArea: outputAreas[i]!,
    error: errors[i]!,
    substituted: keptSubstituted[i]!,
  }));

  // --- rebuild ----------------------------------------------------------------
  if (options.unproject !== false) unprojectInPlace(packed, projection);
  const geometries = unpack(packed);

  const byIndex = new Map<number, number>();
  kept.forEach((k, i) => byIndex.set(k.index, i));
  // Collection indices removed by missing: 'drop'.
  const droppedIndices = new Set(dropped.map((i) => area[i]!.index));

  const features: Feature[] = [];
  collection.features.forEach((f, index) => {
    const slot = byIndex.get(index);
    if (slot !== undefined) features.push({ ...f, geometry: geometries[slot]! });
    else if (!droppedIndices.has(index)) features.push(f); // non-areal passthrough
  });

  const featureCollection: FeatureCollection = { ...collection, type: 'FeatureCollection', features };
  const result: CartogramResult = { featureCollection, diagnostics, metrics, warnings };
  if (iteration) result.iteration = iteration;

  if (options.includeBaseline && before) {
    if (options.unproject !== false) unprojectInPlace(before, projection);
    const baseGeoms = unpack(before);
    result.baseline = {
      type: 'FeatureCollection',
      features: kept.map((k, i) => ({ ...k.feature, geometry: baseGeoms[i]! })),
    };
  }
  return result;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
