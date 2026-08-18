import type { FeatureCollection } from 'geojson';
import type { CartogramResult, MethodName, MissingPolicy, ProjectionName } from '../src/types.ts';
import { runOptions, sceneFromResult, type RunSpec } from './scene.ts';
import { CartogramWorker } from '../src/worker/client.ts';
import { DATASETS } from './datasets.ts';
import {
  draw, effectiveT, fitView, geometryAt, morph, pick,
  type DrawOptions, type Scene, type View,
} from './render.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  status: $('status'),
  dataset: $<HTMLSelectElement>('dataset'),
  attribute: $<HTMLSelectElement>('attribute'),
  missing: $<HTMLSelectElement>('missing'),
  method: $<HTMLSelectElement>('method'),
  fit: $<HTMLSelectElement>('fit'),
  fitRow: $('fit-row'),
  dcnParams: $('dcn-params'),
  dorlingParams: $('dorling-params'),
  flowParams: $('flow-params'),
  grid: $<HTMLSelectElement>('grid'),
  runs: $<HTMLInputElement>('runs'),
  blur: $<HTMLInputElement>('blur'),
  fill: $<HTMLInputElement>('fill'),
  iterations: $<HTMLInputElement>('iterations'),
  shapeAnchor: $<HTMLInputElement>('shapeAnchor'),
  cutoff: $<HTMLInputElement>('cutoff'),
  damping: $<HTMLInputElement>('damping'),
  projection: $<HTMLSelectElement>('projection'),
  layout: $<HTMLSelectElement>('layout'),
  choropleth: $<HTMLSelectElement>('choropleth'),
  ghost: $<HTMLInputElement>('ghost'),
  adjacency: $<HTMLInputElement>('adjacency'),
  morph: $<HTMLInputElement>('morph'),
  play: $<HTMLButtonElement>('play'),
  metrics: $('metrics'),
  note: $('dataset-note'),
  stage: $('stage'),
  canvasA: $<HTMLCanvasElement>('canvas-a'),
  canvasB: $<HTMLCanvasElement>('canvas-b'),
  captionB: $('caption-b'),
  tooltip: $('tooltip'),
  notes: $<HTMLTextAreaElement>('verdict-notes'),
  verdictState: $('verdict-state'),
};

const cache = new Map<string, FeatureCollection>();
// Runs go to a worker: a flow cartogram at grid 512 takes seconds, and on the main
// thread that is a frozen page with no way to tell whether it is working or hung.
const worker = new CartogramWorker(
  () => new Worker(new URL('../src/worker/cartogram.worker.ts', import.meta.url), { type: 'module' }),
);
let inFlight: AbortController | undefined;
let scene: Scene | null = null;
let result: CartogramResult | null = null;
let view: View = { scale: 1, tx: 0, ty: 0 };
let scratch = new Float64Array(0);
let hover: number | null = null;
let playing = 0;

/** The key a verdict is stored under: one run = dataset + attribute + method + params. */
function runKey(): string {
  return [
    els.dataset.value,
    els.attribute.value,
    els.method.value,
    els.method.value === 'olson' ? els.fit.value : '-',
    els.method.value === 'dcn'
      ? `it${els.iterations.value} a${els.shapeAnchor.value} c${els.cutoff.value} d${els.damping.value}`
      : els.method.value === 'dorling' || els.method.value === 'demers'
        ? `it${els.iterations.value} fill${els.fill.value}`
        : els.method.value === 'flow'
          ? `g${els.grid.value} runs${els.runs.value} blur${els.blur.value}`
          : '-',
    els.projection.value,
    els.missing.value,
  ].join(' | ');
}

async function loadDataset(url: string): Promise<FeatureCollection> {
  const cached = cache.get(url);
  if (cached) return cached;
  els.status.textContent = `loading ${url}…`;
  const fc = (await (await fetch(url)).json()) as FeatureCollection;
  cache.set(url, fc);
  return fc;
}

async function run(): Promise<void> {
  const spec = DATASETS.find((d) => d.url === els.dataset.value)!;
  const fc = await loadDataset(spec.url);
  els.note.textContent = spec.note ?? '';

  // Supersede any run still going: changing a parameter mid-run should not queue up
  // work whose result nobody wants.
  inFlight?.abort();
  const controller = new AbortController();
  inFlight = controller;

  const runSpec: RunSpec = {
    value: els.attribute.value,
    method: els.method.value as MethodName,
    fit: els.fit.value as 'total' | 'max',
    projection: els.projection.value as ProjectionName,
    missing: els.missing.value as MissingPolicy,
    iterations: Number(els.iterations.value),
    shapeAnchor: Number(els.shapeAnchor.value),
    cutoff: Number(els.cutoff.value),
    damping: Number(els.damping.value),
    fill: Number(els.fill.value),
    grid: Number(els.grid.value),
    runs: Number(els.runs.value),
    blur: Number(els.blur.value),
  };

  const t0 = performance.now();
  els.status.textContent = `computing ${runSpec.method}…`;
  try {
    const computed = await worker.run(fc, runOptions(runSpec) as never, {
      signal: controller.signal,
      onProgress: (iteration, meanError) => {
        if (controller.signal.aborted) return;
        els.status.textContent =
          `${runSpec.method}: pass ${iteration}, area error ${(meanError * 100).toFixed(2)}%`;
      },
    });
    if (controller.signal.aborted) return;
    const built = sceneFromResult(computed, runSpec);
    scene = built.scene;
    result = built.result;
    scratch = new Float64Array(Math.max(built.scene.a.length, built.scene.b.length));
  } catch (e) {
    if (controller.signal.aborted) return;
    els.status.textContent = `error: ${(e as Error).message}`;
    els.metrics.textContent = '—';
    scene = null;
    return;
  }

  resize(true);
  showMetrics(result);
  if (result.iteration) {
    const it = result.iteration;
    els.metrics.insertAdjacentHTML(
      'beforeend',
      `<div><span class="k">iterations</span><span class="${it.converged ? 'good' : 'bad'}">` +
        `${it.iterations}${it.converged ? ' (converged)' : ' (limit)'}</span></div>` +
        `<div><span class="k">fold retries</span><span>${it.foldRetries}</span></div>` +
        (it.overlaps === undefined
          ? ''
          : `<div><span class="k">overlaps</span><span class="${it.overlaps === 0 ? 'good' : 'bad'}">${it.overlaps}</span></div>`),
    );
  }
  await showVerdictState();
  const m = result.metrics;
  els.status.textContent =
    `${m.featureCount} features · ${m.vertexCount.toLocaleString()} vertices · ` +
    `transform ${m.runtimeMs.toFixed(1)} ms · total ${(performance.now() - t0).toFixed(0)} ms`;
}

function metric(k: string, v: string, cls = ''): string {
  return `<div><span class="k">${k}</span><span class="${cls}">${v}</span></div>`;
}

function showMetrics(r: CartogramResult): void {
  const m = r.metrics;
  const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
  const parts = [
    metric('area error mean', pct(m.areaError.mean), m.areaError.mean < 0.01 ? 'good' : 'bad'),
    metric('area error p90', pct(m.areaError.p90)),
    metric('area error max', pct(m.areaError.max)),
  ];
  if (m.topology) {
    parts.push(
      metric(
        'topology error',
        `${m.topology.error.toFixed(3)} (${m.topology.sharedEdges}/${m.topology.inputEdges})`,
        m.topology.error < 0.05 ? 'good' : 'bad',
      ),
    );
  }
  if (m.orientation) {
    parts.push(
      metric('orientation', m.orientation.mean.toFixed(3), m.orientation.mean > 0.9 ? 'good' : 'bad'),
    );
  }
  if (m.shape) {
    // The anti-blob guard: a method that rounds regions into circles fails here even
    // when its area error is perfect.
    // Watch the drift among features that actually rounded: growing regions round
    // while shrinking ones get ragged, so the all-feature mean cancels out and hides
    // exactly the blobbing a reviewer can see.
    const pos = m.shape.meanPositiveDrift;
    parts.push(
      metric('rounding (mean +drift)', `+${pos.toFixed(3)}`, pos <= 0.05 ? 'good' : 'bad'),
      metric('rounding (max)', `+${m.shape.maxCompactnessDrift.toFixed(3)}`,
        m.shape.maxCompactnessDrift <= 0.08 ? 'good' : 'bad'),
      metric('features rounder', `${(m.shape.fractionRounder * 100).toFixed(0)}%`,
        m.shape.fractionRounder < 0.7 ? 'good' : 'bad'),
      metric('drift, all features', m.shape.meanCompactnessDrift.toFixed(3)),
      metric('detail retention', m.shape.meanDetailRetention.toFixed(3),
        m.shape.meanDetailRetention > 0.9 ? 'good' : 'bad'),
    );
  }
  if (r.warnings.length) {
    parts.push(`<div class="note">${r.warnings.map((w) => `· ${w}`).join('<br>')}</div>`);
  }
  els.metrics.innerHTML = parts.join('');
}

// --- rendering ---------------------------------------------------------------

function options(t: number, role: DrawOptions['role']): DrawOptions {
  return {
    t,
    ghost: els.ghost.checked,
    adjacency: els.adjacency.checked,
    choropleth: els.choropleth.value as DrawOptions['choropleth'],
    hover,
    role,
  };
}

function render(): void {
  if (!scene) return;
  const t = effectiveT(scene, Number(els.morph.value));
  const side = els.layout.value === 'side';
  els.stage.classList.toggle('single', !side);
  // Dorling and Demers replace geometry, so there is nothing to interpolate.
  els.morph.disabled = !scene.morphable;
  els.play.disabled = !scene.morphable;
  els.captionB.firstChild!.textContent = side ? 'cartogram' : t === 0 ? 'original map' : 'cartogram';

  if (side) {
    const ctxA = els.canvasA.getContext('2d')!;
    draw(ctxA, scene, view, options(0, 'reference'), scratch);
  }
  const ctxB = els.canvasB.getContext('2d')!;
  draw(ctxB, scene, view, options(t, 'cartogram'), scratch);
}

function resize(refit = false): void {
  for (const c of [els.canvasA, els.canvasB]) {
    const r = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
  }
  if (scene && refit) view = fitView(els.canvasB, [scene.a, scene.b]);
  render();
}

// --- interaction -------------------------------------------------------------

function canvasPoint(c: HTMLCanvasElement, ev: MouseEvent): [number, number] {
  const r = c.getBoundingClientRect();
  return [((ev.clientX - r.left) / r.width) * c.width, ((ev.clientY - r.top) / r.height) * c.height];
}

for (const c of [els.canvasA, els.canvasB]) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  c.addEventListener('pointerdown', (ev) => {
    dragging = true;
    c.setPointerCapture(ev.pointerId);
    [lastX, lastY] = canvasPoint(c, ev);
  });
  c.addEventListener('pointerup', (ev) => {
    dragging = false;
    c.releasePointerCapture(ev.pointerId);
  });
  c.addEventListener('pointermove', (ev) => {
    const [x, y] = canvasPoint(c, ev);
    if (dragging) {
      view = { ...view, tx: view.tx + (x - lastX), ty: view.ty + (y - lastY) };
      lastX = x;
      lastY = y;
      render();
      return;
    }
    if (!scene) return;
    const isB = c === els.canvasB;
    const t = isB ? effectiveT(scene, Number(els.morph.value)) : 0;
    const coords = morph(scene, t, scratch);
    const found = pick(c.getContext('2d')!, geometryAt(scene, t), view, coords, x, y);
    if (found !== hover) {
      hover = found;
      render();
    }
    if (found === null) {
      els.tooltip.hidden = true;
    } else {
      const d = result!.diagnostics[found]!;
      const r = scene.ratios[found]!;
      els.tooltip.hidden = false;
      els.tooltip.innerHTML =
        `<strong>${scene.labels[found]}</strong><br>` +
        `value ${d.value.toLocaleString()}<br>` +
        `area ${r < 1 ? 'shrank' : 'grew'} ${r.toFixed(2)}×<br>` +
        `error ${(d.error * 100).toFixed(3)}%` +
        (d.compactnessDrift === undefined
          ? ''
          : `<br>rounding ${d.compactnessDrift >= 0 ? '+' : ''}${d.compactnessDrift.toFixed(3)}`);
      const stage = els.stage.getBoundingClientRect();
      els.tooltip.style.left = `${ev.clientX - stage.left + 14}px`;
      els.tooltip.style.top = `${ev.clientY - stage.top + 14}px`;
    }
  });
  c.addEventListener('pointerleave', () => {
    els.tooltip.hidden = true;
    hover = null;
    render();
  });
  c.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const [x, y] = canvasPoint(c, ev);
      const k = Math.exp(-ev.deltaY * 0.0015);
      view = { scale: view.scale * k, tx: x - (x - view.tx) * k, ty: y - (y - view.ty) * k };
      render();
    },
    { passive: false },
  );
}

els.play.addEventListener('click', () => {
  if (playing) {
    cancelAnimationFrame(playing);
    playing = 0;
    els.play.textContent = '▶ animate';
    return;
  }
  els.play.textContent = '⏸ stop';
  const start = performance.now();
  const tick = () => {
    // Ping-pong between map and cartogram: the transition is what makes a
    // distortion legible, per the survey's advice to show the reference map.
    const phase = ((performance.now() - start) / 2400) % 2;
    els.morph.value = String(phase < 1 ? phase : 2 - phase);
    render();
    playing = requestAnimationFrame(tick);
  };
  playing = requestAnimationFrame(tick);
});

// --- verdicts ----------------------------------------------------------------

async function showVerdictState(): Promise<void> {
  try {
    const all = (await (await fetch('/__verdicts')).json()) as Record<string, { verdict: string; notes?: string; savedAt: string }>;
    const v = all[runKey()];
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-verdict]'))) {
      b.classList.toggle('active', v?.verdict === b.dataset.verdict);
    }
    els.notes.value = v?.notes ?? '';
    els.verdictState.textContent = v ? `saved ${new Date(v.savedAt).toLocaleString()}` : 'no verdict yet';
  } catch {
    els.verdictState.textContent = 'verdict store unavailable';
  }
}

for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-verdict]'))) {
  b.addEventListener('click', async () => {
    if (!result) return;
    const m = result.metrics;
    await fetch('/__verdicts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: runKey(),
        dataset: els.dataset.value,
        attribute: els.attribute.value,
        method: els.method.value,
        fit: els.fit.value,
        projection: els.projection.value,
        missing: els.missing.value,
        verdict: b.dataset.verdict,
        notes: els.notes.value,
        // Store the metrics with the verdict so a later regression is attributable.
        metrics: {
          areaErrorMean: m.areaError.mean,
          areaErrorMax: m.areaError.max,
          topologyError: m.topology?.error,
          compactnessDrift: m.shape?.meanCompactnessDrift,
          detailRetention: m.shape?.meanDetailRetention,
          runtimeMs: m.runtimeMs,
        },
      }),
    });
    await showVerdictState();
  });
}

// --- wiring ------------------------------------------------------------------

function fillDatasets(): void {
  for (const group of ['real', 'synthetic'] as const) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const d of DATASETS.filter((x) => x.group === group)) {
      const o = document.createElement('option');
      o.value = d.url;
      o.textContent = d.label;
      og.append(o);
    }
    els.dataset.append(og);
  }
}

function fillAttributes(): void {
  const spec = DATASETS.find((d) => d.url === els.dataset.value)!;
  els.attribute.replaceChildren(
    ...spec.attributes.map((a) => {
      const o = document.createElement('option');
      o.value = a;
      o.textContent = a;
      return o;
    }),
  );
  if (spec.hasMissing && els.missing.value === 'error') els.missing.value = 'zero';
}

els.dataset.addEventListener('change', () => {
  fillAttributes();
  void run();
});
function syncMethodControls(): void {
  const m = els.method.value;
  els.fitRow.style.display = m === 'olson' ? '' : 'none';
  els.dcnParams.style.display = m === 'dcn' ? '' : 'none';
  els.dorlingParams.style.display = m === 'dorling' || m === 'demers' ? '' : 'none';
  els.flowParams.style.display = m === 'flow' ? '' : 'none';
}

for (const el of [
  els.attribute, els.missing, els.method, els.fit, els.projection,
  els.iterations, els.shapeAnchor, els.cutoff, els.damping, els.fill,
  els.grid, els.runs, els.blur,
]) {
  el.addEventListener('change', () => {
    syncMethodControls();
    void run();
  });
}
for (const el of [els.layout, els.choropleth, els.ghost, els.adjacency, els.morph]) {
  el.addEventListener('input', render);
}
window.addEventListener('resize', () => resize());

fillDatasets();
fillAttributes();
syncMethodControls();
void run();
