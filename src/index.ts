import type { Feature, FeatureCollection, GeoJsonObject } from 'geojson';
import type {
  CartogramMetrics,
  CartogramOptions,
  CartogramResult,
  FeatureDiagnostic,
  IterationReport,
} from './types.ts';
import type { FlatGeometry } from './geometry/flat.ts';
import { pack, unpack, cloneCoords, vertexCount } from './geometry/flat.ts';
import { densify, autoSpacing } from './topology/densify.ts';
import { allFeatureAreas, bbox, centreOfMass, similarity } from './geometry/area.ts';
import { looksLikeLonLat, partition } from './io/validate.ts';
import { extractValues } from './io/values.ts';
import type { Projection } from './io/project.ts';
import { chooseProjection, projectInPlace, unprojectInPlace } from './io/project.ts';
import { olson } from './methods/olson.ts';
import { dcn, DCN_DEFAULTS } from './methods/dcn.ts';
import { dorling, DORLING_DEFAULTS } from './methods/dorling.ts';
import { flow, FLOW_DEFAULTS } from './methods/diffusion/index.ts';
import { cartographicError } from './metrics/area.ts';
import { topologyError } from './metrics/topology.ts';
import { shapePreservation } from './metrics/shape.ts';
import { orientationPreservation } from './metrics/orientation.ts';
import { selfIntersections } from './metrics/validity.ts';

export * from './types.ts';
export { pack, unpack } from './geometry/flat.ts';
export {
  featureArea, featureCentroid, allFeatureAreas, bbox, scaleAbout, similarity, centreOfMass,
  polygonArea, polygonCentroid,
} from './geometry/area.ts';
export { cartographicError } from './metrics/area.ts';
export { topologyError, adjacency } from './metrics/topology.ts';
export { shapePreservation, compactness, featurePerimeter } from './metrics/shape.ts';
export { orientationPreservation } from './metrics/orientation.ts';
export { selfIntersections } from './metrics/validity.ts';
export { laea, equalEarth, cylindricalEqualArea, chooseProjection } from './io/project.ts';
export { densify, autoSpacing } from './topology/densify.ts';
export { buildVertexIndex, sharedFraction } from './topology/vertices.ts';
export { CartogramWorker } from './worker/client.ts';
export { rewind, isClockwise, ringSignedArea } from './prepare/rewind.ts';
export type { WorkerOptions, WorkerRequest, WorkerResponse } from './worker/protocol.ts';

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
  const warps = options.method === 'dcn' || options.method === 'flow';
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
  let resolved: { grid: number } | undefined;
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
        smoothing: options.smoothing ?? DCN_DEFAULTS.smoothing,
        sources: options.sources ?? DCN_DEFAULTS.sources,
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
    case 'flow': {
      // `grid: 'auto'` needs the projected, densified geometry and the values, so it is
      // resolved here rather than with the other options.
      const resolvedGrid =
        options.grid === 'auto'
          ? autoGrid(packed, keptValues, options.padding ?? FLOW_DEFAULTS.padding)
          : (options.grid ?? FLOW_DEFAULTS.grid);
      const params = {
        grid: resolvedGrid,
        padding: options.padding ?? FLOW_DEFAULTS.padding,
        targetError: options.targetError ?? FLOW_DEFAULTS.targetError,
        stepsPerRun: options.stepsPerRun ?? FLOW_DEFAULTS.stepsPerRun,
        tolerance: options.tolerance ?? FLOW_DEFAULTS.tolerance,
        floorCells: options.floorCells ?? FLOW_DEFAULTS.floorCells,
        gradient: options.gradient ?? FLOW_DEFAULTS.gradient,
        runs: options.runs ?? FLOW_DEFAULTS.runs,
        blur: options.blur ?? FLOW_DEFAULTS.blur,
        onIteration: options.onIteration,
        signal: options.signal,
      };
      const report = flow(packed, keptValues, params);
      targetAreas = report.targetAreas;
      resolved = { grid: resolvedGrid };
      if (report.underResolved > 0) {
        warnings.push(
          `${report.underResolved} features are smaller than one grid cell and had to be ` +
            `given one; their areas are quantized to the grid. Increase \`grid\` for accuracy.`,
        );
      }
      iteration = {
        iterations: report.steps,
        meanError: report.meanError,
        converged: report.converged,
        foldRetries: 0,
        diffusionTime: report.time,
        seaFraction: report.seaFraction,
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

  // Pin the map's size *and* its position. A cartogram determines relative areas;
  // absolute scale and position are both free, and a warp of the plane drifts in both.
  // Normalized area error cannot see either, but a reader comparing the result with the
  // original certainly can: before this, on NUTS 3, the median region ended up 1342 km
  // from where it started and French Guiana 2904 km, against 200 km and 48 km for the
  // reference implementation.
  //
  // Scale comes from total area. Position comes from the area-weighted centre of mass,
  // matched to the input's: anchoring on the bounding box instead lets a handful of
  // remote territories -- the Azores, Réunion, French Guiana -- decide where the whole
  // map sits, and an earlier version that scaled about the output's bounding-box centre
  // made the drift worse rather than better.
  const rescales = options.method === 'flow' || options.method === 'dcn';
  if (rescales && (options.preserveTotalArea ?? true) && before) {
    const inputTotal = inputAreas.reduce((a, b) => a + b, 0);
    const outputTotal = allFeatureAreas(packed).reduce((a, b) => a + b, 0);
    if (inputTotal > 0 && outputTotal > 0) {
      const factor = Math.sqrt(inputTotal / outputTotal);
      const [ix, iy] = centreOfMass(before, inputAreas);
      const [ox, oy] = centreOfMass(packed, inputAreas);
      similarity(packed, factor, ix - ox * factor, iy - oy * factor);
    }
  }

  // --- fit the result back inside the world -----------------------------------
  const latitudeLimit = options.fitLatitude ?? 85;
  if (latitudeLimit !== false && projection.name !== 'none') {
    const fit = fitToWorld(packed, projection, latitudeLimit);
    if (fit) {
      similarity(packed, fit.factor, fit.tx, fit.ty);
      warnings.push(
        `the cartogram reached outside the world (beyond ${latitudeLimit} degrees of ` +
          `latitude or 180 of longitude) and was scaled to ` +
          `${(fit.factor * 100).toFixed(1)}% and re-centred to bring it back in. ` +
          `Relative areas are unchanged; only the overall size and position are.`,
      );
    }
  }

  // --- measure (in the projected plane, before unprojecting) ------------------
  const outputAreas = allFeatureAreas(packed);
  const { perFeature: errors, summary } = cartographicError(outputAreas, keptValues);

  const metrics: CartogramMetrics = {
    areaError: summary,
    featureCount: packed.featCount,
    vertexCount: vertexCount(packed),
    runtimeMs,
    ...(densification ? { densification } : {}),
    ...(resolved ? { resolved } : {}),
  };

  let perFeatureDrift: Float64Array | undefined;
  if (before) {
    metrics.topology = topologyError(before, packed);
    metrics.orientation = orientationPreservation(before, packed);
    metrics.selfIntersections = selfIntersections(packed);
    const shape = shapePreservation(before, packed);
    perFeatureDrift = shape.compactnessDrift;
    // Anti-blob guard (F20a/F20b): compactness must not systematically rise.
    metrics.shape = {
      meanCompactnessDrift: shape.meanCompactnessDrift,
      maxCompactnessDrift: shape.maxCompactnessDrift,
      meanPositiveDrift: shape.meanPositiveDrift,
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
    ...(perFeatureDrift ? { compactnessDrift: perFeatureDrift[i]! } : {}),
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

/**
 * The similarity that brings a cartogram back inside the world: the largest scale at
 * which every coordinate has a latitude within `limit` and a longitude within 180, with
 * the result centred on what is left over.
 *
 * Returns null when nothing needs doing, which is the usual case -- a regional map has
 * nothing to overflow, and this must leave it exactly alone.
 *
 * **Both bounds, not just latitude.** Which one binds depends on the plane: Lambert
 * cylindrical is tall for its width, so latitude runs out first, while Equal Earth is
 * wide for its height and lets longitude escape instead -- measured on world countries
 * it reached 203 degrees while still inside 85 of latitude. A fit that watched only one
 * of them would be correct on one projection and wrong on the next.
 *
 * **Why centred rather than scaled in place.** Shrinking about the map's centre of mass
 * aligns the result against whichever edge it was already pressed on. The centre of mass
 * of world countries sits well north of the equator, so the north stays pinned against
 * the limit while the south pulls away from it: Russia jammed against the top of the map
 * and Antarctica floating off the bottom. Centring each extent shares the slack, which
 * is both what it should look like and a *smaller* shrink, since the map is no longer
 * being pushed against one side.
 *
 * **Why bisection rather than algebra.** The projection is a parameter. "Which y gives
 * latitude 85" is one line for the cylindrical case, a different one for the azimuthal
 * case, another for Equal Earth, and nothing at all for the next projection added; the
 * inverse is the only thing every projection is guaranteed to offer. The search is
 * monotone -- at a scale of zero every point sits on the centre -- so bisection cannot
 * get lost, and forty steps give roughly a part in 10^12.
 */
function fitToWorld(
  g: FlatGeometry,
  p: Projection,
  limit: number,
): { factor: number; tx: number; ty: number } | null {
  const c = g.coords;
  if (c.length === 0) return null;

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < c.length; i += 2) {
    if (c[i]! < xMin) xMin = c[i]!;
    if (c[i]! > xMax) xMax = c[i]!;
    if (c[i + 1]! < yMin) yMin = c[i + 1]!;
    if (c[i + 1]! > yMax) yMax = c[i + 1]!;
  }
  const xMid = (xMin + xMax) / 2;
  const yMid = (yMin + yMax) / 2;

  // The transform for a given scale: both extents centred on the plane's origin, which
  // for every projection here is the centre of the map it was built for.
  const at = (k: number): { factor: number; tx: number; ty: number } => ({
    factor: k,
    tx: -k * xMid,
    ty: -k * yMid,
  });

  const fits = (k: number): boolean => {
    const { tx, ty } = at(k);
    for (let i = 0; i < c.length; i += 2) {
      const [lon, lat] = p.inverse(c[i]! * k + tx, c[i + 1]! * k + ty);
      if (!(Math.abs(lat) <= limit) || !(Math.abs(lon) <= 180)) return false;
    }
    return true;
  };

  if (fits(1)) {
    // Already inside. Centring it anyway would move a map that had no problem.
    return null;
  }

  let inside = 0;
  let outside = 1;
  for (let step = 0; step < 40; step++) {
    const mid = (inside + outside) / 2;
    if (fits(mid)) inside = mid;
    else outside = mid;
  }
  return at(inside);
}


/**
 * A grid resolution sized to the map, rather than to a default.
 *
 * The flow's resolution limit is one specific thing: a region smaller than a grid cell
 * cannot be represented in the density field, so it exerts no pressure and comes out
 * shrunk no matter how dense it is. Paris is 105 km^2 holding 2.1 million people and is
 * exactly this failure. So the grid is chosen to give the smallest region *that carries
 * real value* at least one cell.
 *
 * The value filter is what makes this usable rather than absurd. Sizing to the smallest
 * region outright asks for a grid of 82,000 on world countries, because somewhere in the
 * file there is an islet; the binding region has to be one whose absence would be
 * visible. A tenth of the mean share is a low bar that still excludes the rocks -- on
 * world countries it lands on Singapore, on NUTS 3 on Melilla, on NUTS 2 on Brussels,
 * which are precisely the regions this is for.
 *
 * Clamped to 1024 because the transforms go as N^2 log N and the next doubling costs
 * four to five times the runtime for a diminishing return. Where 1024 is still not
 * enough the under-resolved warning says so and names the count.
 */
function autoGrid(g: FlatGeometry, values: Float64Array, padding: number): number {
  const areas = allFeatureAreas(g);
  const n = g.featCount;
  let total = 0;
  for (let f = 0; f < n; f++) total += values[f]!;
  if (!(total > 0) || n === 0) return FLOW_DEFAULTS.grid;

  // A tenth of the mean value share: low enough to keep every region a reader would
  // miss, high enough to drop the ones that would cost everyone else a slowdown.
  const floor = total / (10 * n);
  let smallest = Infinity;
  for (let f = 0; f < n; f++) {
    if (values[f]! >= floor && areas[f]! > 0 && areas[f]! < smallest) smallest = areas[f]!;
  }
  if (!Number.isFinite(smallest)) return FLOW_DEFAULTS.grid;

  const [minX, minY, maxX, maxY] = bbox(g);
  const needed = (Math.max(maxX - minX, maxY - minY) * padding) / Math.sqrt(smallest);

  const power = 1 << Math.ceil(Math.log2(Math.max(needed, 1)));
  // Never below the default: `auto` exists to notice that a map needs a finer grid, not
  // to save time on one that does not. Sizing purely to the minimum viable grid picks
  // 256 for NUTS 0 and costs 0.51% -> 1.25% area error for the privilege.
  return Math.min(1024, Math.max(FLOW_DEFAULTS.grid, power));
}
