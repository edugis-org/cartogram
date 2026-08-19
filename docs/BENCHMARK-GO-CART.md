# Our flow method against go-cart-wasm

[`go-cart-wasm`](https://github.com/riatelab/go-cart-wasm) is the authors' own C
implementation of Gastner, Seguy & More (2018), compiled to WebAssembly. It is the
honest oracle for this library's headline method: the same algorithm family, written by
the people who devised it, with the adaptive Runge–Kutta integrator that our
implementation deliberately does not have.

Run it with `npm run bench:go-cart`.

Both implementations receive the **same planar input**, projected once by us, and both
outputs are scored with the **same metrics** — ours — so nothing depends on whose
definition of "area error" is being quoted.

| dataset | implementation | ms | area err | max err | topology | rounding | detail | self-int |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| nl-provinces | ours (grid 256) | 1337 | 0.75% | 6.0% | 0.000 | +0.041 | 1.06 | 0 |
| nl-provinces | ours (grid 512) | 7012 | 0.20% | 1.7% | 0.000 | +0.041 | 1.07 | 0 |
| nl-provinces | **go-cart-wasm** | 2010 | **0.03%** | 0.1% | 0.000 | +0.040 | 1.06 | 0 |
| nuts0 | ours (grid 256) | 2829 | 4.43% | 90.4% | 0.000 | +0.028 | 1.08 | 0 |
| nuts0 | ours (grid 512) | 14082 | 2.44% | 65.3% | 0.000 | +0.027 | 1.08 | 0 |
| nuts0 | **go-cart-wasm** | 23477 | **1.21%** | 43.2% | 0.000 | +0.033 | 1.12 | 2 |
| nuts2-20m | ours (grid 256) | 4620 | 11.10% | 93.1% | 0.000 | +0.059 | 1.18 | 1 |
| nuts2-20m | **ours (grid 512)** | 17750 | **3.04%** | 76.6% | 0.000 | +0.069 | 1.16 | 1 |
| nuts2-20m | go-cart-wasm | 2204 | 11.95% | 99.1% | 0.000 | +0.059 | 1.15 | 3 |
| world-110m | ours (grid 256) | 5020 | 14.01% | 100.0% | 0.000 | +0.059 | 1.26 | 5 |
| world-110m | **ours (grid 512)** | 25017 | **5.76%** | 100.0% | 0.000 | +0.062 | 1.27 | 18 |
| world-110m | go-cart-wasm | 35324 | 10.39% | 100.0% | 0.000 | +0.075 | 1.32 | 116 |

Measured after implementing the adaptive integrator and taking region density from exact
polygon areas. The earlier figures, for reference, were 0.20 / 5.51 / 9.11 / 8.01 percent
for the four datasets at grid 512.

## What it says

**They remain ahead on well-behaved maps.** On the Dutch provinces they reach 0.03%
area error against our 0.20%, and on NUTS 0 1.21% against our 2.44%. Our figure on the
provinces will not improve with more integration: tightening the step tolerance from
0.02 to 0.002 cells, the error target from 1% to 0.02%, and raising the pass count all
leave it at 0.15–0.20%. Something other than the integrator sets that floor, and the
likeliest candidate is the velocity field, which we obtain by central differences on the
diffused grid and sample bilinearly, where go_cart takes it analytically from sine and
cosine transforms of the gradient. That is the next thing to try.

**On hard maps we are now well ahead.** NUTS 2: 3.04% for us against 11.95% for them.
World countries: 5.76% against 10.39%. These are the maps full of regions smaller than a
grid cell, where the guaranteed-one-cell allocation, the value floor, and taking density
from exact polygon areas are all doing real work.

**Compare like for like on the grid.** go-cart-wasm is fixed at 512, so only the
"ours (grid 512)" rows are a fair speed comparison. In the review harness, where the
flow method defaults to grid 256, go-cart looks about ten times slower on NUTS 0 (25 s
against 2 s) — but a quarter of that gap is simply that our method is doing a quarter of
the grid work at 256.

**Runtime is not a straight win for either.** They are faster on the provinces (2.0 s
against 7.0 s) and dramatically faster on NUTS 2 (2.2 s against 17.8 s), but slower on
NUTS 0 (23.5 s against 14.1 s) and on the world map (35.3 s against 25.0 s). Their cost varies far more with
the data than ours does: on NUTS 2, with 334 regions, go-cart takes about 2 s, while on
NUTS 0, with only 37, it takes 23 s. The likely reason is the shape of the data rather
than its size — NUTS 0 spans from the Azores to Réunion, so the fixed 512 grid is mostly
empty ocean with a few tiny islands in it, and their convergence test has to work hard.
Ours is set by the grid the caller chooses and barely moves with the data. Comparing at
equal grid resolution is not possible — go-cart-wasm does not expose one.

**Shape and topology agree closely**, which is reassuring for both: topology error is
exactly 0.000 everywhere, rounding is within 0.02 of each other on every dataset, and
detail retention within 0.06. Two independent implementations of the same physics
producing the same shape behaviour is good evidence that neither is doing anything
strange.

**Self-intersections favour us**: 0 or 1 where they emit 2 and 3, and 18 against their
116 on the world map. Not a claim about correctness — some of those are inherited from the
input — but our output is cleaner.

## The comparison is at equal grid resolution

go_cart's own header settles what it is doing, and it turns out to match this library's
defaults closely:

```c
#define L (512)            /* Maximum dimension of the FFT lattice is L x L. */
#define MAX_PERMITTED_AREA_ERROR (0.01)
#define PADDING (1.5)
#define BLUR_WIDTH (5e0)
#define MIN_POP_FAC (0.2)  /* Replace area 0 by the minimum times this. */
```

So its grid is **512, fixed at compile time**, its target error 1% and its padding 1.5 —
the same as our defaults, arrived at independently. Its blur is 5 cells against our 4,
and it floors zero-valued regions much as we do, though at a far more generous 0.2 of
the minimum.

That matters for reading the table above: the "ours (grid 512)" rows are a like-for-like
comparison, not a handicap. The remaining gap on well-behaved maps is therefore
attributable to the **integrator**, not to resolution — which is exactly what makes the
adaptive Runge–Kutta the thing worth implementing.

## Using go-cart-wasm through this library

```ts
import initGoCart from 'go-cart-wasm';
import { goCartCartogram } from '@edugis/cartogram/go-cart';

const goCart = await initGoCart();
const result = goCartCartogram(featureCollection, { goCart, value: 'population' });
```

`go-cart-wasm` is an **optional peer dependency**: install it only if you want this
backend, and no WebAssembly is pulled in otherwise. The wrapper returns the identical
`CartogramResult` the built-in methods return — same diagnostics, same metrics — so the
two are directly interchangeable and comparable. It also supplies what go-cart-wasm
does not have on its own: an equal-area projection step, missing- and negative-value
policies, ring rewinding, and per-feature diagnostics.

## Practical notes for anyone comparing

- **go-cart-wasm requires outer rings wound clockwise**, the pre-RFC-7946 convention.
  Given RFC-7946 winding it computes correctly — its reported area errors are fine — but
  emits empty geometry, complaining that every polygon in a region is a hole. Natural
  Earth already winds that way; the Dutch data does not. This library is
  winding-agnostic and needs no such preparation.
- It requires already-projected, equal-area coordinates and offers no projection step.
- **It exposes no grid or tolerance parameter**, so quality and runtime cannot be traded.
  `L` is `#define`d to 512 in the C and compiled into the WebAssembly; changing it means
  rebuilding the WASM with the Emscripten toolchain, which is outside what this library
  can offer.

## Conclusion

For a browser application that wants the best flow cartogram and can afford a WASM
payload, go-cart-wasm is an excellent choice and is better than this library on
well-behaved data. What this library offers instead is one API across five methods, no
WASM and no runtime dependencies, an explicit quality/runtime dial, projection and
value handling built in, and the metric suite used to produce this very table.

The adaptive integrator has since been implemented. It helped, and it also showed that
it was not the whole story: the remaining gap on well-behaved maps survives any amount of
extra integration, so the next suspect is the finite-difference velocity field rather than
the stepping.
