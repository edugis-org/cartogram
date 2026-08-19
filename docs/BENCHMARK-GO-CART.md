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
| nl-provinces | ours (grid 256) | 1347 | 1.00% | 6.4% | 0.000 | +0.041 | 1.06 | 0 |
| nl-provinces | ours (grid 512) | 5422 | 0.20% | 1.3% | 0.000 | +0.041 | 1.07 | 0 |
| nl-provinces | **go-cart-wasm** | 2053 | **0.03%** | 0.1% | 0.000 | +0.040 | 1.06 | 0 |
| nuts0 | ours (grid 256) | 4675 | 10.41% | 93.6% | 0.000 | +0.030 | 1.07 | 0 |
| nuts0 | ours (grid 512) | 19638 | 5.51% | 41.3% | 0.000 | +0.028 | 1.08 | 0 |
| nuts0 | **go-cart-wasm** | 23056 | **1.21%** | 43.2% | 0.000 | +0.033 | 1.12 | 2 |
| nuts2-20m | ours (grid 256) | 5148 | 22.14% | 99.1% | 0.000 | +0.044 | 1.15 | 0 |
| nuts2-20m | **ours (grid 512)** | 21293 | **9.11%** | 99.1% | 0.000 | +0.073 | 1.15 | 0 |
| nuts2-20m | go-cart-wasm | 2089 | 11.95% | 99.1% | 0.000 | +0.059 | 1.15 | 3 |
| world-110m | ours (grid 256) | 5199 | 17.28% | 100.0% | 0.000 | +0.064 | 1.26 | 5 |
| world-110m | **ours (grid 512)** | 22888 | **8.01%** | 100.0% | 0.000 | +0.063 | 1.27 | 12 |
| world-110m | go-cart-wasm | 35040 | 10.39% | 100.0% | 0.000 | +0.075 | 1.32 | 116 |

## What it says

**Their integrator is worth a lot on well-behaved maps.** On the Dutch provinces they
reach 0.03% area error where we reach 0.20% at grid 512 — seven times better, in
half the time. On NUTS 0 they reach 1.21% against our 5.51%. This is the cost of
replacing the paper's adaptive Runge–Kutta with a midpoint rule on a fixed geometric
schedule, and it is the single clearest thing to improve in this library.

**On hard maps the gap closes and reverses.** NUTS 2: 9.11% for us against 11.95% for
them. World countries: 8.01% against 10.39%. These are the datasets where many regions
are small relative to the grid, and where the guaranteed-one-cell allocation and the
value floor added here are doing real work.

**Runtime is not a straight win for either.** They are faster on the provinces (2.0 s
against 5.4 s) and dramatically faster on NUTS 2 (2.1 s against 21.3 s), but slower on
NUTS 0 (23.1 s against 19.6 s) and on the world map (35.0 s against 22.9 s). Their cost
clearly adapts to the data; ours is fixed by the grid the caller chooses. Comparing at
equal grid resolution is not possible — go-cart-wasm does not expose one.

**Shape and topology agree closely**, which is reassuring for both: topology error is
exactly 0.000 everywhere, rounding is within 0.02 of each other on every dataset, and
detail retention within 0.06. Two independent implementations of the same physics
producing the same shape behaviour is good evidence that neither is doing anything
strange.

**Self-intersections favour us**: 0 where they emit 2 and 3, and 12 against their 116 on
the world map. Not a claim about correctness — some of those are inherited from the
input — but our output is cleaner.

## Practical notes for anyone comparing

- **go-cart-wasm requires outer rings wound clockwise**, the pre-RFC-7946 convention.
  Given RFC-7946 winding it computes correctly — its reported area errors are fine — but
  emits empty geometry, complaining that every polygon in a region is a hole. Natural
  Earth already winds that way; the Dutch data does not. This library is
  winding-agnostic and needs no such preparation.
- It requires already-projected, equal-area coordinates and offers no projection step.
- It exposes no grid or tolerance parameter, so quality and runtime cannot be traded.

## Conclusion

For a browser application that wants the best flow cartogram and can afford a WASM
payload, go-cart-wasm is an excellent choice and is better than this library on
well-behaved data. What this library offers instead is one API across five methods, no
WASM and no runtime dependencies, an explicit quality/runtime dial, projection and
value handling built in, and the metric suite used to produce this very table.

The gap on the provinces and NUTS 0 is a fair measure of what the adaptive integrator
buys. Implementing it is the top of the list.
