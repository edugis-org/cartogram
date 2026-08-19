import type { Feature, FeatureCollection, GeoJsonObject } from 'geojson';
import type {
  CartogramMetrics,
  CartogramResult,
  CommonOptions,
  FeatureDiagnostic,
  ValueAccessor,
} from '../types.ts';
import { pack, unpack, cloneCoords, vertexCount } from '../geometry/flat.ts';
import { allFeatureAreas } from '../geometry/area.ts';
import { partition } from '../io/validate.ts';
import { extractValues } from '../io/values.ts';
import { chooseProjection, projectInPlace, unprojectInPlace } from '../io/project.ts';
import { cartographicError } from '../metrics/area.ts';
import { topologyError } from '../metrics/topology.ts';
import { shapePreservation } from '../metrics/shape.ts';
import { orientationPreservation } from '../metrics/orientation.ts';
import { selfIntersections } from '../metrics/validity.ts';
import { rewind } from '../prepare/rewind.ts';

/**
 * The shape of the `go-cart-wasm` module we depend on. Declared here so this file
 * needs no types from the optional dependency.
 */
export interface GoCartModule {
  makeCartogram(geojson: FeatureCollection, fieldName: string): FeatureCollection;
}

export interface GoCartOptions extends Omit<CommonOptions, 'densify'> {
  /**
   * The initialized go-cart-wasm module. Supply it yourself, so this library needs no
   * dependency on it and you keep control of where the .wasm file is loaded from:
   *
   * ```ts
   * import initGoCart from 'go-cart-wasm';
   * const goCart = await initGoCart();
   * ```
   */
  goCart: GoCartModule;
  /** Property name or accessor for the cartogram variable. */
  value: ValueAccessor;
}

/**
 * Run a flow-based cartogram through `go-cart-wasm` — the authors' own C
 * implementation of Gastner, Seguy & More (2018) compiled to WebAssembly — while
 * keeping this library's pipeline, options and metrics around it.
 *
 * Why bother, when go-cart-wasm can be called directly? Because on its own it gives
 * you a bare `makeCartogram(geojson, field)`: no projection, no missing-value policy,
 * no diagnostics, no metrics, and a silent failure mode if your rings are wound the
 * wrong way. This wrapper supplies all of that, and returns the identical
 * `CartogramResult` the built-in methods return, so the two are directly comparable
 * and interchangeable.
 *
 * Measured against our own `flow` (see `docs/BENCHMARK-GO-CART.md`): markedly more
 * accurate on well-behaved maps — 0.03% area error against 0.20% on the Dutch
 * provinces — and less accurate on maps full of regions smaller than a grid cell.
 * It exposes no grid or tolerance parameter, so quality and runtime cannot be traded;
 * the grid is fixed when the WebAssembly is compiled.
 */
export function goCartCartogram(input: GeoJsonObject, options: GoCartOptions): CartogramResult {
  const warnings: string[] = [];
  const { collection, area, passthrough } = partition(input);
  if (passthrough.length > 0) {
    warnings.push(`${passthrough.length} non-areal features passed through untransformed`);
  }

  const { values, substituted, dropped, warnings: valueWarnings } = extractValues(
    area.map((a) => a.feature),
    options.value,
    options.missing ?? 'error',
    options.negative ?? 'error',
  );
  warnings.push(...valueWarnings);

  const dropSet = new Set(dropped);
  const kept = area.filter((_, i) => !dropSet.has(i));
  const keptValues = Float64Array.from(Array.from(values).filter((_, i) => !dropSet.has(i)));
  const keptSubstituted = substituted.filter((_, i) => !dropSet.has(i));

  const packed = pack(kept.map((k) => k.feature));
  const projection = chooseProjection(packed, options.projection ?? 'auto');
  projectInPlace(packed, projection);
  const before = cloneCoords(packed);
  const inputAreas = allFeatureAreas(packed);

  // Hand go_cart projected geometry with a plain numeric property it can read, wound
  // the way it needs. Its own value parsing is CSV-based and unforgiving, so the
  // value goes on under a fixed name rather than whatever the caller used.
  const FIELD = '__cartogram_value';
  const geometries = unpack(packed);
  const prepared: FeatureCollection = rewind(
    {
      type: 'FeatureCollection',
      features: kept.map((k, i) => ({
        type: 'Feature',
        properties: { ...(k.feature.properties ?? {}), [FIELD]: keptValues[i]! },
        geometry: geometries[i]!,
      })) as Feature[],
    },
    'clockwise',
  );

  const t0 = now();
  const raw = options.goCart.makeCartogram(prepared, FIELD);
  const runtimeMs = now() - t0;

  const returned = raw.features.filter(
    (f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon',
  );
  if (returned.length !== kept.length) {
    throw new Error(
      `go-cart returned geometry for ${returned.length} of ${kept.length} features. ` +
        `This usually means the input geometry was rejected; check for empty or invalid rings.`,
    );
  }

  const output = pack(returned as never);
  const outputAreas = allFeatureAreas(output);
  const { perFeature: errors, summary } = cartographicError(outputAreas, keptValues);

  const shape = shapePreservation(before, output);
  const metrics: CartogramMetrics = {
    areaError: summary,
    topology: topologyError(before, output),
    orientation: orientationPreservation(before, output),
    selfIntersections: selfIntersections(output),
    shape: {
      meanCompactnessDrift: shape.meanCompactnessDrift,
      maxCompactnessDrift: shape.maxCompactnessDrift,
      meanPositiveDrift: shape.meanPositiveDrift,
      fractionRounder: shape.fractionRounder,
      meanDetailRetention: shape.meanDetailRetention,
    },
    featureCount: output.featCount,
    vertexCount: vertexCount(output),
    runtimeMs,
  };

  const diagnostics: FeatureDiagnostic[] = kept.map((k, i) => ({
    index: k.index,
    id: k.feature.id,
    value: keptValues[i]!,
    inputArea: inputAreas[i]!,
    targetArea: inputAreas.reduce((a, b) => a + b, 0) * (keptValues[i]! /
      keptValues.reduce((a, b) => a + b, 0)),
    outputArea: outputAreas[i]!,
    error: errors[i]!,
    substituted: keptSubstituted[i]!,
    compactnessDrift: shape.compactnessDrift[i]!,
  }));

  if (options.unproject !== false) unprojectInPlace(output, projection);
  const outGeometries = unpack(output);

  const byIndex = new Map<number, number>();
  kept.forEach((k, i) => byIndex.set(k.index, i));
  const droppedIndices = new Set(dropped.map((i) => area[i]!.index));

  const features: Feature[] = [];
  collection.features.forEach((f, index) => {
    const slot = byIndex.get(index);
    if (slot !== undefined) features.push({ ...f, geometry: outGeometries[slot]! });
    else if (!droppedIndices.has(index)) features.push(f);
  });

  const result: CartogramResult = {
    featureCollection: { ...collection, type: 'FeatureCollection', features },
    diagnostics,
    metrics,
    warnings,
  };

  if (options.includeBaseline) {
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
