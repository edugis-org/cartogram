import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const VERDICTS = resolve(import.meta.dirname, 'harness/verdicts.json');

/**
 * Persist human quality verdicts to harness/verdicts.json.
 *
 * Requirement 4.2: the point of the harness is that a person judges whether a
 * cartogram is still *recognizable*, and that the judgement is committed to the
 * repo so a later change that quietly ruins the maps is visible as a regression.
 * A dev-server endpoint is enough; no database, no build step.
 */
function verdictStore(): Plugin {
  return {
    name: 'cartogram-verdicts',
    configureServer(server) {
      // The app's entry lives at /harness/, so the dev root would otherwise 404.
      // The production build writes a redirect file for the same reason; the dev
      // server has no such file, so it needs the redirect here.
      server.middlewares.use((req, res, next) => {
        if (req.url === '/' || req.url === '') {
          res.statusCode = 302;
          res.setHeader('location', '/harness/');
          res.end();
          return;
        }
        next();
      });

      server.middlewares.use('/__verdicts', (req, res) => {
        if (req.method === 'GET') {
          res.setHeader('content-type', 'application/json');
          res.end(existsSync(VERDICTS) ? readFileSync(VERDICTS, 'utf8') : '{}');
          return;
        }
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            try {
              const entry = JSON.parse(body) as { key: string };
              const all = existsSync(VERDICTS)
                ? (JSON.parse(readFileSync(VERDICTS, 'utf8')) as Record<string, unknown>)
                : {};
              all[entry.key] = { ...entry, savedAt: new Date().toISOString() };
              mkdirSync(dirname(VERDICTS), { recursive: true });
              writeFileSync(VERDICTS, JSON.stringify(all, null, 2) + '\n');
              res.statusCode = 200;
              res.end('{"ok":true}');
            } catch (e) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: String(e) }));
            }
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

/**
 * The app loads its datasets from /data at runtime. In development that works because
 * the dev server's root is the repo root; a production build has to carry them along,
 * so they are copied into the output. They are not part of the npm package -- see
 * `files` in package.json -- because a library has no business shipping 13 MB of
 * Natural Earth and Eurostat geometry.
 */
function buildApp(outDir: string): Plugin {
  return {
    name: 'cartogram-build-app',
    apply: 'build',
    closeBundle() {
      const out = resolve(import.meta.dirname, outDir);
      cpSync(resolve(import.meta.dirname, 'data'), resolve(out, 'data'), { recursive: true });
      // The entry keeps its source path (harness/index.html) so that asset URLs stay
      // correct; a redirect at the root means the deployed app works at the domain
      // root as well.
      writeFileSync(
        resolve(out, 'index.html'),
        '<!doctype html><meta charset="utf-8">' +
          '<title>cartogram</title>' +
          '<meta http-equiv="refresh" content="0; url=./harness/">' +
          '<a href="./harness/">cartogram review harness</a>\n',
      );
    },
  };
}

const OUT_DIR = 'dist-app';

// Root is the repo root so the app can fetch datasets straight out of data/.
export default defineConfig({
  root: '.',
  // No public dir: data/ is served from the repo root in dev and copied in on build.
  publicDir: false,
  // Relative base, so the built app works from any path -- a project page on GitHub
  // Pages, a subdirectory, or opened straight off disk.
  base: './',
  server: { open: '/harness/', port: 5174 },
  // Workers must be ES modules: the harness worker pulls in go-cart-wasm, which Rollup
  // code-splits, and the default IIFE worker output cannot represent multiple chunks.
  worker: { format: 'es' },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, 'harness/index.html') },
  },
  plugins: [verdictStore(), buildApp(OUT_DIR)],
});
