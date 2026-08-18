import { describe, expect, it } from 'vitest';
import { extractValues } from '../src/io/values.ts';
import { InputError } from '../src/io/validate.ts';
import type { Feature } from 'geojson';

const feat = (value: unknown): Feature =>
  ({ type: 'Feature', properties: { value }, geometry: null }) as unknown as Feature;

describe('value extraction', () => {
  it('reads numbers and numeric strings', () => {
    const r = extractValues([feat(3), feat('4.5')], 'value', 'error', 'error');
    expect(Array.from(r.values)).toEqual([3, 4.5]);
  });

  it('accepts an accessor function', () => {
    const r = extractValues([feat(1), feat(2)], (_f, i) => i * 10, 'error', 'error');
    expect(Array.from(r.values)).toEqual([0, 10]);
  });

  it("throws on missing values under the default 'error' policy", () => {
    expect(() => extractValues([feat(1), feat(null)], 'value', 'error', 'error')).toThrow(InputError);
    expect(() => extractValues([feat(1), feat('abc')], 'value', 'error', 'error')).toThrow(InputError);
  });

  it("substitutes zero under 'zero' and the mean under 'mean'", () => {
    const z = extractValues([feat(1), feat(3), feat(null)], 'value', 'zero', 'error');
    expect(Array.from(z.values)).toEqual([1, 3, 0]);
    expect(z.substituted).toEqual([false, false, true]);

    const m = extractValues([feat(1), feat(3), feat(null)], 'value', 'mean', 'error');
    expect(Array.from(m.values)).toEqual([1, 3, 2]);
  });

  it("reports the indices to remove under 'drop'", () => {
    const d = extractValues([feat(1), feat(undefined), feat(5)], 'value', 'drop', 'error');
    expect(d.dropped).toEqual([1]);
  });

  it('rejects negative values by default and clamps on request', () => {
    expect(() => extractValues([feat(-1)], 'value', 'error', 'error')).toThrow(/negative/);
    const c = extractValues([feat(-1), feat(2)], 'value', 'error', 'clamp');
    expect(Array.from(c.values)).toEqual([0, 2]);
    expect(c.warnings.join()).toMatch(/clamped/);
  });
});
