import type { Feature, FeatureCollection, GeoJsonObject } from 'geojson';
import type {
  CartogramMetrics,
  CartogramOptions,
  CartogramResult,
  FeatureDiagnostic,
} from './types.ts';
import { pack, unpack, cloneCoords, vertexCount } from './geometry/flat.ts';
import { allFeatureAreas } from './geometry/area.ts';
import { partition } from './io/validate.ts';
import { extractValues } from './io/values.ts';
import { chooseProjection, projectInPlace, unprojectInPlace } from './io/project.ts';
import { olson } from './methods/olson.ts';
import { cartographicError } from './metrics/area.ts';
import { topologyError } from './metrics/topology.ts';
import { shapePreservation } from './metrics/shape.ts';

export * from './types.ts';
export { pack, unpack } from './geometry/flat.ts';
export { featureArea, featureCentroid, allFeatureAreas, bbox } from './geometry/area.ts';
export { cartographicError } from './metrics/area.ts';
export { topologyError, adjacency } from './metrics/topology.ts';
export { shapePreservation, compactness, featurePerimeter } from './metrics/shape.ts';
export { laea, cylindricalEqualArea, chooseProjection } from './io/project.ts';

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
  const packed = pack(kept.map((k) => k.feature));
  const projection = chooseProjection(packed, options.projection ?? 'auto');
  projectInPlace(packed, projection);

  const before = options.metrics === false ? null : cloneCoords(packed);
  const inputAreas = allFeatureAreas(packed);

  // --- transform --------------------------------------------------------------
  const t0 = now();
  let targetAreas: Float64Array;
  switch (options.method) {
    case 'identity':
      targetAreas = inputAreas.slice();
      break;
    case 'olson':
      targetAreas = olson(packed, keptValues, { fit: options.fit ?? 'total' });
      break;
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
  };

  if (before) {
    metrics.topology = topologyError(before, packed);
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
  return { featureCollection, diagnostics, metrics, warnings };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
