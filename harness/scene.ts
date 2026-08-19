import type { Feature, FeatureCollection } from 'geojson';
import { cartogram, pack, adjacency as adjacencyPairs } from '../src/index.ts';
import type { CartogramOptions } from '../src/types.ts';
import { allFeatureAreas } from '../src/geometry/area.ts';
import type {
  AreaFeature,
  CartogramResult,
  MethodName,
  MissingPolicy,
  ProjectionName,
} from '../src/types.ts';
import type { Scene } from './render.ts';

/** The harness can also run the reference implementation, which is not a library method. */
export type HarnessMethod = MethodName | 'go-cart';

export interface RunSpec {
  value: string;
  method: HarnessMethod;
  fit?: 'total' | 'max';
  projection?: ProjectionName;
  missing?: MissingPolicy;
  iterations?: number;
  shapeAnchor?: number;
  cutoff?: number;
  damping?: number;
  fill?: number;
  grid?: number;
  runs?: number;
  blur?: number;
  gradient?: 'analytic' | 'differences';
  tolerance?: number;
}

export function areaFeatures(fc: FeatureCollection): AreaFeature[] {
  return fc.features.filter(
    (f: Feature) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon',
  ) as AreaFeature[];
}

export function labelOf(f: Feature, i: number): string {
  const p = (f.properties ?? {}) as Record<string, unknown>;
  for (const k of ['NAME', 'name', 'statnaam', 'NUTS_NAME', 'NAME_LATN', 'id']) {
    if (typeof p[k] === 'string') return p[k];
  }
  return String(f.id ?? `#${i}`);
}

/**
 * Build everything the renderer needs for one review run.
 *
 * The input geometry comes from `result.baseline`, i.e. the projected and densified
 * input the method actually started from -- not from packing the raw file. Both sides
 * are then projected, value-filtered, dropped and densified identically, so vertex i of
 * feature f means the same thing on both sides and the morph can interpolate straight
 * between them. Packing the raw file instead misaligns the two maps as soon as a
 * feature is dropped, and breaks outright for warp methods, which insert vertices
 * before warping.
 *
 * DOM-free on purpose, so the harness's own logic is covered by the test suite
 * rather than only by looking at it.
 */
/** The options for one review run. Shared by the direct and worker code paths. */
export function runOptions(spec: RunSpec): CartogramOptions {
  return {
    value: spec.value,
    projection: spec.projection ?? 'auto',
    missing: spec.missing ?? 'zero',
    negative: 'clamp',
    unproject: false, // stay in the equal-area plane; that is what we are judging
    includeBaseline: true,
    method: spec.method,
    ...(spec.method === 'olson' ? { fit: spec.fit ?? 'total' } : {}),
    ...(spec.method === 'dorling' || spec.method === 'demers'
      ? {
          ...(spec.iterations !== undefined ? { iterations: spec.iterations } : {}),
          ...(spec.fill !== undefined ? { fill: spec.fill } : {}),
        }
      : {}),
    ...(spec.method === 'flow'
      ? {
          ...(spec.grid !== undefined ? { grid: spec.grid } : {}),
          ...(spec.runs !== undefined ? { runs: spec.runs } : {}),
          ...(spec.blur !== undefined ? { blur: spec.blur } : {}),
          ...(spec.gradient !== undefined ? { gradient: spec.gradient } : {}),
          ...(spec.tolerance !== undefined ? { tolerance: spec.tolerance } : {}),
        }
      : {}),
    ...(spec.method === 'dcn'
      ? {
          ...(spec.iterations !== undefined ? { iterations: spec.iterations } : {}),
          ...(spec.shapeAnchor !== undefined ? { shapeAnchor: spec.shapeAnchor } : {}),
          ...(spec.cutoff !== undefined ? { cutoff: spec.cutoff } : {}),
          ...(spec.damping !== undefined ? { damping: spec.damping } : {}),
        }
      : {}),
  } as CartogramOptions;
}

export function buildScene(fc: FeatureCollection, spec: RunSpec): { scene: Scene; result: CartogramResult } {
  return sceneFromResult(cartogram(fc, runOptions(spec)), spec);
}

/** Assemble the renderer's view of a finished run. */
export function sceneFromResult(
  result: CartogramResult,
  spec: RunSpec,
): { scene: Scene; result: CartogramResult } {
  const kept = areaFeatures(result.baseline!);
  const gA = pack(kept);
  const gB = pack(areaFeatures(result.featureCollection));

  // Methods that move geometry keep the vertex layout, so the two sides can be
  // interpolated directly. Methods that *replace* geometry (Dorling, Demers) cannot
  // be morphed: the renderer switches between the two instead. Silently interpolating
  // mismatched buffers is the failure this check exists to prevent.
  const replaces = spec.method === 'dorling' || spec.method === 'demers';
  if (!replaces && gA.coords.length !== gB.coords.length) {
    throw new Error(
      `harness: geometry mismatch (${gA.coords.length} vs ${gB.coords.length} coordinates); ` +
        `the morph would misalign`,
    );
  }
  if (gA.featCount !== gB.featCount) {
    throw new Error(`harness: feature count mismatch (${gA.featCount} vs ${gB.featCount})`);
  }

  const inAreas = allFeatureAreas(gA);
  const outAreas = allFeatureAreas(gB);
  const ratios = new Float64Array(gA.featCount);
  for (let f = 0; f < gA.featCount; f++) {
    ratios[f] = inAreas[f]! > 0 ? outAreas[f]! / inAreas[f]! : 0;
  }

  const adjacency: [number, number][] = Array.from(adjacencyPairs(gA), (k) => {
    const [i, j] = k.split('|');
    return [Number(i), Number(j)] as [number, number];
  });

  return {
    scene: {
      geomA: gA,
      geomB: gB,
      morphable: !replaces,
      a: gA.coords,
      b: gB.coords,
      errors: Float64Array.from(result.diagnostics.map((d) => d.error)),
      ratios,
      adjacency,
      labels: kept.map(labelOf),
    },
    result,
  };
}
