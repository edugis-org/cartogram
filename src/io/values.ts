import type { Feature } from 'geojson';
import type { MissingPolicy, ValueAccessor } from '../types.ts';
import { InputError } from './validate.ts';

export interface ValueResult {
  /** One value per input feature, after the policy has been applied. */
  values: Float64Array;
  /** True where the original value was missing and has been substituted. */
  substituted: boolean[];
  /** Indices (into the passed feature array) to drop entirely. */
  dropped: number[];
  warnings: string[];
}

function raw(accessor: ValueAccessor, f: Feature, i: number): unknown {
  if (typeof accessor === 'function') return accessor(f, i);
  return f.properties ? f.properties[accessor] : undefined;
}

/**
 * Extract the cartogram variable, applying the missing-value and negative-value
 * policies. Missing means: absent, null, undefined, empty string, NaN or non-finite.
 * A numeric string is accepted and coerced -- real GeoJSON is full of them.
 */
export function extractValues(
  features: Feature[],
  accessor: ValueAccessor,
  missing: MissingPolicy,
  negative: 'error' | 'clamp',
): ValueResult {
  const n = features.length;
  const values = new Float64Array(n);
  const present = new Array<boolean>(n).fill(false);
  const substituted = new Array<boolean>(n).fill(false);
  const warnings: string[] = [];

  let sum = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    const v = raw(accessor, features[i]!, i);
    let num: number;
    if (v === null || v === undefined || v === '') num = NaN;
    else if (typeof v === 'number') num = v;
    else if (typeof v === 'string') num = Number(v);
    else num = NaN;

    if (Number.isFinite(num)) {
      if (num < 0) {
        if (negative === 'error') {
          throw new InputError(
            `feature ${i} has negative value ${num}; cartograms need non-negative values ` +
              `(set negative: 'clamp' to floor at zero)`,
          );
        }
        warnings.push(`feature ${i}: negative value ${num} clamped to 0`);
        num = 0;
      }
      values[i] = num;
      present[i] = true;
      sum += num;
      count++;
    }
  }

  const dropped: number[] = [];
  const missingCount = n - count;

  if (missingCount > 0) {
    switch (missing) {
      case 'error':
        throw new InputError(
          `${missingCount} of ${n} features have a missing or non-numeric value ` +
            `(set missing: 'zero' | 'mean' | 'drop' to handle them)`,
        );
      case 'zero':
        for (let i = 0; i < n; i++) {
          if (!present[i]) {
            values[i] = 0;
            substituted[i] = true;
          }
        }
        warnings.push(`${missingCount} missing values set to 0`);
        break;
      case 'mean': {
        const mean = count > 0 ? sum / count : 0;
        for (let i = 0; i < n; i++) {
          if (!present[i]) {
            values[i] = mean;
            substituted[i] = true;
          }
        }
        warnings.push(`${missingCount} missing values set to the mean (${mean})`);
        break;
      }
      case 'drop':
        for (let i = 0; i < n; i++) if (!present[i]) dropped.push(i);
        warnings.push(`${missingCount} features dropped for missing values`);
        break;
    }
  }

  return { values, substituted, dropped, warnings };
}
