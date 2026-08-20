import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DATASETS } from '../harness/datasets.ts';

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
    // 'go-cart' is a harness-only method: the reference implementation, driven through
    // the backend rather than being one of the library's own.
    for (const method of ['identity', 'olson', 'dcn', 'flow', 'dorling', 'demers', 'go-cart']) {
      expect(html, `method '${method}' missing from the method dropdown`).toContain(
        `value="${method}"`,
      );
    }
  });

  it('offers every setting the library takes an "auto" for', () => {
    // A library option with no control is an option nobody in the harness can review.
    // `grid: 'auto'` was added to the API and forgotten here for exactly that reason.
    expect(html, `grid dropdown has no 'auto' option`).toMatch(
      /<select id="grid">[\s\S]*?value="auto"/,
    );
    expect(main, `main.ts turns every grid value into a number, so 'auto' becomes NaN`)
      .toContain(`els.grid.value === 'auto' ? 'auto' : Number(els.grid.value)`);
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

  it('never references data with an absolute path', () => {
    // An absolute `/data/...` assumes the app is served from the domain root. It works
    // on the dev server and 404s the moment the app is deployed under a prefix -- which
    // is exactly what happened on the GitHub Pages project page, where the harness sat
    // on "loading" forever. Relative paths work in both.
    for (const d of DATASETS) {
      expect(d.url.startsWith('/'), `${d.url} is absolute`).toBe(false);
      expect(d.url.startsWith('../data/'), `${d.url} should be relative to the page`).toBe(true);
    }
  });

  it('resolves dataset paths correctly from both dev and deployed pages', () => {
    // The page is at <base>/harness/ and the data at <base>/data/ in both.
    const cases: [string, string][] = [
      ['http://localhost:5174/harness/', 'http://localhost:5174/data/'],
      ['https://edugis-org.github.io/cartogram/harness/', 'https://edugis-org.github.io/cartogram/data/'],
    ];
    for (const [base, expected] of cases) {
      const resolved = new URL(DATASETS[0]!.url, base).href;
      expect(resolved.startsWith(expected), `${resolved} should start with ${expected}`).toBe(true);
    }
  });

  it('has a parameter panel per parameterised method', () => {
    for (const id of ['fit-row', 'dcn-params', 'dorling-params', 'flow-params', 'gocart-params']) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
