import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync('harness/index.html', 'utf8');
const main = readFileSync('harness/main.ts', 'utf8');

/**
 * The harness is markup plus a script that reaches into it by id, and nothing checks
 * that the two agree. A method added to the library but not to the dropdown, or an
 * element the script queries but the page never had, fails silently and is only ever
 * noticed by a person staring at the UI. These checks are cheap and catch both.
 */
describe('harness markup matches the script', () => {
  it('offers every cartogram method', () => {
    for (const method of ['identity', 'olson', 'dcn', 'dorling', 'demers']) {
      expect(html, `method '${method}' missing from the method dropdown`).toContain(
        `value="${method}"`,
      );
    }
  });

  it('has an element for every id the script looks up', () => {
    const ids = new Set<string>();
    for (const m of main.matchAll(/\$(?:<[^>]+>)?\('([^']+)'\)/g)) ids.add(m[1]!);
    expect(ids.size).toBeGreaterThan(10);
    for (const id of ids) {
      expect(html, `#${id} is queried by main.ts but not present in index.html`).toContain(
        `id="${id}"`,
      );
    }
  });

  it('has a parameter panel per parameterised method', () => {
    for (const id of ['fit-row', 'dcn-params', 'dorling-params']) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
