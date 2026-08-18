import { readFileSync, existsSync } from 'node:fs';
import type { FeatureCollection } from 'geojson';

export function load(path: string): FeatureCollection {
  return JSON.parse(readFileSync(path, 'utf8')) as FeatureCollection;
}

export function has(path: string): boolean {
  return existsSync(path);
}

/** A square ring, counter-clockwise, closed. */
export function square(x: number, y: number, size: number): number[][] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
}

export function squareFeature(id: string, x: number, y: number, size: number, value: number) {
  return {
    type: 'Feature' as const,
    id,
    properties: { value },
    geometry: { type: 'Polygon' as const, coordinates: [square(x, y, size)] },
  };
}

export function fc(features: unknown[]): FeatureCollection {
  return { type: 'FeatureCollection', features } as FeatureCollection;
}
