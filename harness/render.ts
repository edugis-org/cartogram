import type { FlatGeometry } from '../src/geometry/flat.ts';
import { ringRange } from '../src/geometry/flat.ts';

export interface View {
  scale: number;
  tx: number;
  ty: number;
}

export interface Scene {
  /** Index structure of the input geometry. */
  geomA: FlatGeometry;
  /** Index structure of the output. Differs when a method replaces geometry. */
  geomB: FlatGeometry;
  /** Projected input coordinates. */
  a: Float64Array;
  /** Projected cartogram coordinates. */
  b: Float64Array;
  /**
   * Can the two sides be interpolated vertex by vertex? False for methods that
   * replace geometry outright (Dorling, Demers), where a morph would be meaningless.
   */
  morphable: boolean;
  /** Per-feature cartographic error, for the choropleth. */
  errors: Float64Array;
  /** Per-feature output/input area ratio, for the grew/shrank choropleth. */
  ratios: Float64Array;
  /** Adjacency pairs of the *input* map, as [i, j] feature indices. */
  adjacency: [number, number][];
  labels: string[];
}

export interface DrawOptions {
  /** Morph position: 0 = original map, 1 = cartogram. */
  t: number;
  ghost: boolean;
  adjacency: boolean;
  choropleth: 'none' | 'error' | 'ratio';
  hover: number | null;
  /**
   * Which pane this is. The cartogram is the thing being judged, so it gets the
   * strong outline; the reference map and the ghost stay quiet. Getting this the
   * wrong way round makes every method look alike, because what you actually see is
   * the original in both panes.
   */
  role: 'cartogram' | 'reference';
}

/** Fit a coordinate array into the canvas with a small margin. */
export function fitView(canvas: HTMLCanvasElement, coords: Float64Array[]): View {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of coords) {
    for (let i = 0; i < c.length; i += 2) {
      if (c[i]! < minX) minX = c[i]!;
      if (c[i]! > maxX) maxX = c[i]!;
      if (c[i + 1]! < minY) minY = c[i + 1]!;
      if (c[i + 1]! > maxY) maxY = c[i + 1]!;
    }
  }
  const w = canvas.width;
  const h = canvas.height;
  const pad = 0.04 * Math.min(w, h);
  const scale = Math.min((w - 2 * pad) / (maxX - minX || 1), (h - 2 * pad) / (maxY - minY || 1));
  return {
    scale,
    tx: w / 2 - ((minX + maxX) / 2) * scale,
    // Screen y grows downward; map y grows upward.
    ty: h / 2 + ((minY + maxY) / 2) * scale,
  };
}

/**
 * Diverging colour ramp for the choropleth. Deliberately not a rainbow: one hue for
 * "too small", one for "too big", light neutral in the middle, so a reviewer can see
 * at a glance which way a region is wrong.
 */
function divergingColor(v: number, alpha = 0.85): string {
  const t = Math.max(-1, Math.min(1, v));
  if (t >= 0) {
    const k = t;
    return `rgba(${Math.round(247 - 60 * k)}, ${Math.round(247 - 140 * k)}, ${Math.round(247 - 60 * k)}, ${alpha})`;
  }
  const k = -t;
  return `rgba(${Math.round(247 - 150 * k)}, ${Math.round(247 - 70 * k)}, ${Math.round(247 - 10 * k)}, ${alpha})`;
}

function featureFill(scene: Scene, f: number, mode: DrawOptions['choropleth']): string {
  if (mode === 'none') return 'rgba(148, 163, 184, 0.22)';
  if (mode === 'error') {
    // Error is unsigned; show magnitude only, on the "too big" side of the ramp.
    return divergingColor(Math.min(1, scene.errors[f]! * 8));
  }
  const r = scene.ratios[f]!;
  // log ratio, so growing 2x and shrinking 2x are equally far from neutral.
  const l = r > 0 ? Math.log2(r) : -4;
  return divergingColor(Math.max(-1, Math.min(1, l / 3)));
}

function tracePath(
  ctx: CanvasRenderingContext2D,
  g: FlatGeometry,
  f: number,
  coords: Float64Array,
  view: View,
): void {
  ctx.beginPath();
  for (let p = g.featStart[f]!; p < g.featStart[f + 1]!; p++) {
    for (let r = g.polyStart[p]!; r < g.polyStart[p + 1]!; r++) {
      const [s, e] = ringRange(g, r);
      for (let v = s; v < e; v++) {
        const x = coords[2 * v]! * view.scale + view.tx;
        const y = view.ty - coords[2 * v + 1]! * view.scale;
        if (v === s) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
  }
}

/** Interpolated coordinates for the morph slider. Allocation is reused by the caller. */
export function morph(scene: Scene, t: number, out: Float64Array): Float64Array {
  const { a, b } = scene;
  if (!scene.morphable) return t < 0.5 ? a : b;
  if (t <= 0) out.set(a);
  else if (t >= 1) out.set(b);
  else for (let i = 0; i < a.length; i++) out[i] = a[i]! + (b[i]! - a[i]!) * t;
  return out;
}

/**
 * Morph position to actually draw the cartogram pane at.
 *
 * Methods that replace geometry cannot be morphed, and their slider is disabled -- but
 * a disabled slider keeps whatever value it had under the previous method. Left alone,
 * a slider parked below the midpoint made Dorling and Demers render the *original map*
 * instead of the symbols. The cartogram pane always shows the cartogram; only the
 * reference pane, which asks for t = 0 explicitly, shows the input.
 */
export function effectiveT(scene: Scene, slider: number): number {
  return scene.morphable ? slider : 1;
}

/** Which index structure describes the coordinates `morph` returns for this t. */
export function geometryAt(scene: Scene, t: number): FlatGeometry {
  if (scene.morphable) return t <= 0 ? scene.geomA : scene.geomB;
  return t < 0.5 ? scene.geomA : scene.geomB;
}

export function draw(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: View,
  opts: DrawOptions,
  scratch: Float64Array,
): void {
  const { canvas } = ctx;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const coords = morph(scene, opts.t, scratch);
  const g = geometryAt(scene, opts.t);

  // Ghost: where the region used to be. Kept faint and dashed so it reads as a
  // reference rather than competing with the shape being judged.
  if (opts.ghost && opts.t > 0 && opts.role === 'cartogram') {
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.30)';
    ctx.setLineDash([3, 3]);
    for (let f = 0; f < scene.geomA.featCount; f++) {
      tracePath(ctx, scene.geomA, f, scene.a, view);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  if (opts.role === 'cartogram') {
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = 'rgba(241, 245, 249, 0.92)';
  } else {
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
  }
  for (let f = 0; f < g.featCount; f++) {
    tracePath(ctx, g, f, coords, view);
    ctx.fillStyle = featureFill(scene, f, opts.choropleth);
    ctx.fill('evenodd');
    ctx.stroke();
  }

  if (opts.hover !== null && opts.hover >= 0 && opts.hover < g.featCount) {
    tracePath(ctx, g, opts.hover, coords, view);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fbbf24';
    ctx.stroke();
  }

  // Adjacency graph of the *input* map drawn over the *current* geometry: any edge
  // whose endpoints have drifted apart is a contiguity break you can see.
  if (opts.adjacency) {
    const cx = new Float64Array(g.featCount);
    const cy = new Float64Array(g.featCount);
    const n = new Float64Array(g.featCount);
    for (let f = 0; f < g.featCount; f++) {
      const vStart = g.ringStart[g.polyStart[g.featStart[f]!]!]!;
      const vEnd = g.ringStart[g.polyStart[g.featStart[f + 1]!]!]!;
      let sx = 0;
      let sy = 0;
      let count = 0;
      for (let v = vStart; v < vEnd; v++) {
        sx += coords[2 * v]!;
        sy += coords[2 * v + 1]!;
        count++;
      }
      cx[f] = count > 0 ? sx / count : 0;
      cy[f] = count > 0 ? sy / count : 0;
      n[f] = count;
    }
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
    ctx.beginPath();
    for (const [i, j] of scene.adjacency) {
      ctx.moveTo(cx[i]! * view.scale + view.tx, view.ty - cy[i]! * view.scale);
      ctx.lineTo(cx[j]! * view.scale + view.tx, view.ty - cy[j]! * view.scale);
    }
    ctx.stroke();
  }
}

/** Feature under the cursor, or null. Uses the browser's own point-in-path test. */
export function pick(
  ctx: CanvasRenderingContext2D,
  g: FlatGeometry,
  view: View,
  coords: Float64Array,
  px: number,
  py: number,
): number | null {
  for (let f = g.featCount - 1; f >= 0; f--) {
    tracePath(ctx, g, f, coords, view);
    if (ctx.isPointInPath(px, py, 'evenodd')) return f;
  }
  return null;
}
