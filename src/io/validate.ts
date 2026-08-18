import type { Feature, FeatureCollection, GeoJsonObject } from 'geojson';
import type { AreaFeature } from '../types.ts';

export class InputError extends Error {}

/**
 * Split a FeatureCollection into the features a cartogram can transform and the ones
 * it must pass through untouched (points, lines, null geometry).
 *
 * GeometryCollections containing only Polygon/MultiPolygon are flattened into a
 * MultiPolygon, per requirement F2; mixed ones are passed through.
 */
export function partition(fc: GeoJsonObject): {
  collection: FeatureCollection;
  area: { feature: AreaFeature; index: number }[];
  passthrough: number[];
} {
  if (!fc || (fc as FeatureCollection).type !== 'FeatureCollection') {
    throw new InputError('input must be a GeoJSON FeatureCollection');
  }
  const collection = fc as FeatureCollection;
  if (!Array.isArray(collection.features)) {
    throw new InputError('FeatureCollection has no features array');
  }

  const area: { feature: AreaFeature; index: number }[] = [];
  const passthrough: number[] = [];

  collection.features.forEach((f: Feature, index) => {
    const g = f.geometry;
    if (!g) {
      passthrough.push(index);
      return;
    }
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      area.push({ feature: f as AreaFeature, index });
      return;
    }
    if (g.type === 'GeometryCollection') {
      const parts = g.geometries;
      if (parts.length > 0 && parts.every((p) => p.type === 'Polygon' || p.type === 'MultiPolygon')) {
        const coordinates = parts.flatMap((p) =>
          p.type === 'Polygon' ? [p.coordinates] : p.coordinates,
        );
        area.push({
          feature: { ...f, geometry: { type: 'MultiPolygon', coordinates } } as AreaFeature,
          index,
        });
        return;
      }
    }
    passthrough.push(index);
  });

  return { collection, area, passthrough };
}

/** Heuristic: do these coordinates look like unprojected lon/lat degrees? */
export function looksLikeLonLat(bounds: [number, number, number, number]): boolean {
  const [minX, minY, maxX, maxY] = bounds;
  return minX >= -180.5 && maxX <= 180.5 && minY >= -90.5 && maxY <= 90.5;
}
