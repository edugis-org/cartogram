#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { cartogram } from './index.ts';
import type { CartogramOptions, MethodName, MissingPolicy, ProjectionName } from './types.ts';

const USAGE = `cartogram-ts - turn GeoJSON into a cartogram

Usage:
  cartogram-ts <input.geojson> --value <property> [options]

Options:
  --value <prop>        property holding the cartogram variable (required)
  --method <name>       identity | olson | dcn                 (default olson)
  --fit <total|max>     olson: preserve total area, or keep the largest region
                                                              (default total)
  --iterations <n>      dcn: maximum iterations                (default 60)
  --target-error <x>    dcn: stop at this mean error           (default 0.02)
  --cutoff <x>          dcn: influence radius, in region radii (default 5)
  --damping <x>         dcn: step size multiplier              (default 1)
  --shape-anchor <x>    dcn: anti-blob strength, 0..1          (default 0.25)
  --densify <x|off>     vertex spacing before warping          (default auto)
  --projection <name>   auto | none | laea | cylindrical-equal-area (default auto)
  --missing <policy>    error | zero | mean | drop             (default error)
  --negative <policy>   error | clamp                          (default error)
  --no-unproject        keep output in the projected plane
  -o, --out <file>      write GeoJSON here (default: stdout)
  --quiet               do not print the metrics report
`;

function main(argv: string[]): number {
  const args = parse(argv);
  const input = args.positional[0];
  if (!input || args.flags.help) {
    process.stderr.write(USAGE);
    return input ? 0 : 1;
  }
  const value = args.options.value;
  if (!value) {
    process.stderr.write('error: --value is required\n\n' + USAGE);
    return 1;
  }

  const fc = JSON.parse(readFileSync(input, 'utf8'));
  const num = (k: string): number | undefined =>
    args.options[k] === undefined ? undefined : Number(args.options[k]);

  const options = {
    value,
    method: (args.options.method ?? 'olson') as MethodName,
    fit: args.options.fit ?? 'total',
    ...(num('iterations') !== undefined ? { iterations: num('iterations') } : {}),
    ...(num('target-error') !== undefined ? { targetError: num('target-error') } : {}),
    ...(num('cutoff') !== undefined ? { cutoff: num('cutoff') } : {}),
    ...(num('damping') !== undefined ? { damping: num('damping') } : {}),
    ...(num('shape-anchor') !== undefined ? { shapeAnchor: num('shape-anchor') } : {}),
    ...(args.options.densify !== undefined
      ? { densify: args.options.densify === 'off' ? false : Number(args.options.densify) }
      : {}),
    projection: (args.options.projection ?? 'auto') as ProjectionName,
    missing: (args.options.missing ?? 'error') as MissingPolicy,
    negative: (args.options.negative ?? 'error') as 'error' | 'clamp',
    unproject: !args.flags['no-unproject'],
  } as CartogramOptions;

  const result = cartogram(fc, options);
  const json = JSON.stringify(result.featureCollection);
  if (args.options.out) writeFileSync(args.options.out, json);
  else process.stdout.write(json + '\n');

  if (!args.flags.quiet) {
    const m = result.metrics;
    const lines = [
      `input      ${input}`,
      `method     ${options.method}`,
      `features   ${m.featureCount}   vertices ${m.vertexCount}`,
      `runtime    ${m.runtimeMs.toFixed(1)} ms`,
      `area error mean ${pct(m.areaError.mean)}  median ${pct(m.areaError.median)}  ` +
        `p90 ${pct(m.areaError.p90)}  max ${pct(m.areaError.max)}`,
    ];
    if (result.iteration) {
      const it = result.iteration;
      lines.push(
        `iterations ${it.iterations} ${it.converged ? '(converged)' : '(stopped at limit)'}` +
          `, ${it.foldRetries} fold retries`,
      );
    }
    if (m.densification) {
      lines.push(`densify    +${m.densification.inserted} vertices at spacing ${m.densification.spacing.toFixed(1)}`);
    }
    if (m.topology) lines.push(`topology   error ${m.topology.error.toFixed(4)} ` +
      `(${m.topology.sharedEdges}/${m.topology.inputEdges} adjacencies kept)`);
    if (m.shape) lines.push(
      `shape      compactness drift mean ${m.shape.meanCompactnessDrift.toFixed(4)} ` +
      `max ${m.shape.maxCompactnessDrift.toFixed(4)}, ` +
      `${pct(m.shape.fractionRounder)} of features rounder, ` +
      `detail retention ${m.shape.meanDetailRetention.toFixed(4)}`,
    );
    for (const w of result.warnings) lines.push(`warning    ${w}`);
    process.stderr.write(lines.join('\n') + '\n');
  }
  return 0;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(3)}%`;
}

function parse(argv: string[]) {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const flags: Record<string, boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-o') options.out = argv[++i] ?? '';
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '--no-unproject' || a === '--quiet') flags[a.replace(/^--/, '')] = true;
    else if (a.startsWith('--')) options[a.slice(2)] = argv[++i] ?? '';
    else positional.push(a);
  }
  return { positional, options, flags };
}

process.exitCode = main(process.argv.slice(2));
