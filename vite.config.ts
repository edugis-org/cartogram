import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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

// Root is the repo root so the harness can fetch datasets straight out of data/.
export default defineConfig({
  root: '.',
  // No public dir: data/ is served straight from the repo root during development.
  publicDir: false,
  server: { open: '/harness/', port: 5174 },
  build: { rollupOptions: { input: resolve(import.meta.dirname, 'harness/index.html') } },
  plugins: [verdictStore()],
});
