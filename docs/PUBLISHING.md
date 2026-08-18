# Publishing

Two artefacts come out of this one repository:

| | what | contains | excludes |
|---|---|---|---|
| **npm package** `cartogram-ts` | the library | `dist/` (ESM + `.d.ts`), `README.md`, `LICENSE` | the harness, the datasets, the benchmarks |
| **web app** | the review harness | `dist-app/` — the harness plus `data/` | nothing from `src/` beyond what is bundled |

One repository, one package, two build targets. A workspaces monorepo was considered and
rejected: the app *is* the library's review harness, the two change together in the same
commits, and the split would add ceremony paid daily for a benefit taken rarely. If the app
ever grows its own dependencies or release cadence, revisit it then.

## The library

```
npm run build          # tsc -> dist/
npm pack --dry-run     # inspect exactly what would be published
npm publish            # prepublishOnly runs typecheck + tests + build first
```

`files: ["dist"]` in `package.json` is what keeps 13 MB of Natural Earth and Eurostat
geometry out of the package; `README.md` and `LICENSE` are included by npm automatically.
Entry points:

- `cartogram-ts` — the API
- `cartogram-ts/worker` — the Web Worker entry, for bundlers that want an explicit URL

Before the first publish:

- The npm name `cartogram-ts` was free when this was written. Check again, or scope it
  (`@geodan/cartogram-ts`) if you would rather own the namespace.
- Set the `repository`, `homepage` and `bugs` URLs in `package.json` to the real ones.
- Decide the copyright holder in `LICENSE` (currently a personal name, not Geodan).
- `npm version patch|minor|major` before publishing; it tags the commit.

## The app

```
npm run app:dev        # http://localhost:5174/harness/
npm run app:build      # -> dist-app/
npm run app:preview    # serve the built app locally
```

`base: './'` means the build works from any path: a GitHub Pages project page, a
subdirectory, or straight off disk. `dist-app/index.html` redirects to `harness/`, so the
app also works at a domain root. The datasets are copied into `dist-app/data/` at build
time, because the harness fetches them at runtime.

Deploying to GitHub Pages is then `npm run app:build` and publishing `dist-app/`, e.g. with
a workflow on push to `main`.

**Attribution is not optional for the app.** It ships Eurostat GISCO geometry
(© EuroGeographics, attribution required) and CBS data (CC BY 4.0). The harness carries a
credits panel; keep it. Natural Earth is public domain and needs none. Full provenance is
in [`data/SOURCES.md`](../data/SOURCES.md).

**Note on the verdict store**: recording review verdicts is a dev-server feature — it
writes `harness/verdicts.json` through a Vite middleware. The built app has no server, so
the verdict buttons will report the store as unavailable. That is intended: verdicts are a
development record, committed to the repo, not something end users produce.
