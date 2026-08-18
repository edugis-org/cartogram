# Literature & prior art — cartogram algorithms

## 0. Taxonomy

Cartograms trade **area accuracy** against **shape fidelity** and **topology preservation**.
Four families (Nusrat & Kobourov, *State of the Art in Cartograms*, EuroVis/CGF 2016 — the
canonical survey; **read [`STAR-2016-REVIEW.md`](STAR-2016-REVIEW.md) first**, it is a
detailed read of that paper with its metrics, its recommendations, and what has superseded it):

| Family | Contiguity | Shape | Typical cost |
|---|---|---|---|
| Contiguous (diffusion, rubber-sheet) | preserved | recognizable, warped | medium–high |
| Non-contiguous (Olson) | broken | **exact** | O(V) |
| Dorling / Demers (circles, squares) | broken | abstract | O(n log n) w/ index |
| Mosaic / gridded (hex, rectangular) | preserved | abstract | combinatorial |

## 1. Contiguous, diffusion-based

### Gastner & Newman (2004) — "Diffusion-based method for producing density-equalizing maps", PNAS 101(20):7499–7504
The reference method. Rasterize the density (value/area) onto a regular grid, let it
diffuse (solve the linear diffusion equation ∂ρ/∂t = ∇²ρ) until uniform, and advect
every map vertex along the induced velocity field **v = −∇ρ/ρ**. Diffusion solved with
FFT (cosine transform) on the grid; vertices integrated with an ODE solver.
Cost: O(G log G) per timestep on the grid + O(V) advection. Grid size is a user knob and
is independent of feature count ⇒ **near-linear in features**, which is exactly the
performance property we need.
Downside: needs a "sea" of padding around the map, can be slow to converge, and the
original integrator is fragile.

### Gastner, Seguy & More (2018) — "Fast flow-based algorithm for creating density-equalizing map projections", PNAS 115(10):E2156–E2164 ([arXiv:1802.07625](https://arxiv.org/pdf/1802.07625), [PNAS](https://www.pnas.org/doi/full/10.1073/pnas.1712674115))
The modern replacement, and our **primary target**. Same physics, but:
- integrates the *flow* (a proper velocity field) with an adaptive Runge–Kutta (Heun)
  integrator with step-size control, instead of naive Euler;
- non-uniform "blur"/smoothing schedule that anneals down, avoiding artefacts;
- handles the grid entirely in Fourier space with FFTW cosine transforms;
- seconds instead of minutes; markedly better shape preservation.
Reference implementation: [`Flow-Based-Cartograms/go_cart`](https://github.com/Flow-Based-Cartograms/go_cart) (C, unmaintained),
succeeded by [`mgastner/cartogram-cpp`](https://github.com/mgastner/cartogram-cpp) (C++, actively developed).
**Licence caution: these are GPL/AGPL.** Read for algorithm, do not copy code into a permissive library.

### Follow-ups worth reading
- Gastner et al., *Smooth pycnophylactic interpolation produced by density-equalising map projections* ([arXiv:2207.00663](https://arxiv.org/pdf/2207.00663)) — same machinery, mass-preserving interpolation.
- Sun (2013), "A fast, free-form rubber-sheet algorithm for contiguous area cartograms", IJGIS.
- Keim, North & Panse (2004), **CartoDraw**; Keim et al. (2005), **RecMap** (rectangular cartograms).

### Duncan & Gastner (2025/26) — "Topology-Preserving Line Densification for Creating Contiguous Cartograms", [arXiv:2511.08121](https://arxiv.org/pdf/2511.08121), accepted CaGIS
**Required reading before implementing any warp-based method.** Boundaries are polylines with
finitely many vertices; warping only the existing vertices lets long straight edges bend through
their neighbours, producing overlapping or disconnected regions. Fix: topology-preserving
densification of boundary lines *before* advection. Reports better accuracy and speed than
alternatives at comparable shape fidelity. Becomes an explicit pipeline stage for us (F18/F19).

## 2. Contiguous, force/rubber-sheet based

### Dougenik, Chrisman & Niemeyer (1985) — "An algorithm to construct continuous area cartograms", The Professional Geographer 37(1):75–81
Every region becomes a force field: a circle of radius proportional to √(desired area)
centred on its centroid pushes or pulls nearby vertices, with the effect decaying with
distance. Iterate ~10–30 times. Simple, robust, no grid, easy to make deterministic.
Naive form is O(n·V) per iteration; with a **quadtree / Barnes–Hut cutoff** it becomes
O(V log n), which meets the near-linear requirement. This is our **best "default"
mid-quality method** and by far the cheapest contiguous one to implement first.
Widely reimplemented: R `cartogram::cartogram_cont`, Python `cartogram`, `d3-cartogram`.

**Known failure mode — circular blobbing.** The force kernel is radially symmetric about
each region's centroid, so every vertex is pushed along the radius: iterate too long, or with
too little distance decay, and regions relax towards circles, smoothing away coastline detail.
This is the single most common visible defect in force-based cartograms and violates our F20a.
Mitigations: distance decay with a hard cutoff, step damping, a shape-anchoring term, and
stopping on area error rather than running to convergence. Sun (2020) addresses this
explicitly ("avoids extreme shape deformation") and is the reason we follow it over DCN 1985.

Diffusion/flow methods are structurally less prone to this: they warp a *global field* rather
than pushing each polygon towards its own centroid, so shape detail is transported rather than
averaged away — another reason GSM2018 is the quality target.

### Sun (2020) — "Applying forces to generate cartograms: a fast and flexible transformation framework", CaGIS 47(5)
The modern, hardened member of the DCN family: a force-based space-transformation framework with
a stated **topological-integrity guarantee**, fast convergence, and explicit avoidance of extreme
shape deformation; pitched as a robust alternative to diffusion. Implementation
[F4Carto](https://sunsp.net/download/programs/F4Carto_Documentation.pdf), code/data on
[Harvard Dataverse](https://doi.org/10.7910/DVN/6ST8NQ). **Follow this for M3 rather than
DCN 1985 unmodified.**

### Dorling (1996) — *Area Cartograms: Their Use and Creation*, CATMOG 59
The standard reference monograph; also the origin of the circle cartogram below.

## 3. Non-contiguous

### Olson (1976) — "Noncontiguous area cartograms", The Professional Geographer 28(4):371–380
Scale each polygon about its own centroid by √(target area / actual area). Exact areas,
**exact shapes**, broken adjacency, whitespace between regions. O(V), one pass, no
iteration. Trivially correct — an ideal baseline, unit-test oracle, and a genuinely useful
output mode.

## 4. Dorling & Demers

### Dorling (1996) circle cartogram
Replace each region with a circle of area ∝ value, placed at the region centroid, then
run a repulsion/attraction relaxation so circles don't overlap but keep neighbours close.
Implement with a quadtree-accelerated collision pass (as in `d3-force`'s `forceCollide`) ⇒
O(n log n) per iteration. **Demers** variant uses squares. Shape is fully abstracted away,
but relative geography stays legible.

## 5. Mosaic / gridded (out of v1 scope, listed for completeness)
- Cano et al. (2015), "Mosaic drawings and cartograms", CGF (EuroVis).
- Eppstein, van Kreveld et al., rectangular/rectilinear cartograms; **Tilegrams**; **carto­gram hexmaps**.
- Speckmann & van Kreveld, *Rectangular cartograms* — provably area-correct, poor shape.

## 6. Evaluation literature

- **Nusrat & Kobourov (2016)**, *The State of the Art in Cartograms*, Computer Graphics Forum 35(3) — taxonomy + the standard quantitative measure set (statistical/area error, topology, relative orientation, shape via Hamming distance) and a review of user studies.
- **Nusrat, Alam & Kobourov (2018)**, "Evaluating cartogram effectiveness", IEEE TVCG — task-based user study; establishes that *recognizability*, not just area error, drives task performance. Directly motivates our human review harness.
- **Duncan & Gastner (2024)**, "Comparative evaluation of the web-based contiguous cartogram generation tool go-cart.io", PLOS ONE 19(5):e0298192 ([arXiv:2201.04272](https://arxiv.org/abs/2201.04272)) — usability study of web cartogram tools covering both *generation* and *analysis* tasks. Design reference for our review harness (M2).
- **Alam, Kobourov & Veeramoni (2015)**, "Quantitative measures for cartogram generation techniques", CGF — defines the metrics we will implement.
- Tobler (2004), "Thirty five years of computer cartograms", Annals AAG — historical context.

## 7. Existing code to reuse or study

| Project | Lang / licence | Use to us |
|---|---|---|
| [`riatelab/go-cart-wasm`](https://github.com/riatelab/go-cart-wasm) | C→WASM, JS wrapper (GPL-ish, check) | Browser flow-based cartograms **today**. Candidate optional peer-dependency backend; benchmark/quality oracle for our TS port. |
| [`Flow-Based-Cartograms/go_cart`](https://github.com/Flow-Based-Cartograms/go_cart) | C, AGPL | Reference implementation of GSM2018. Read-only reference. |
| [`mgastner/cartogram-cpp`](https://github.com/mgastner/cartogram-cpp) | C++, AGPL | Current state of the art; source of edge-case handling (holes, exclaves, projection). Read-only reference. |
| [`go-cart-io/cartogram-web`](https://github.com/go-cart-io/cartogram-web) / [go-cart.io](https://go-cart.io/about) | web app | UX reference for our review harness. |
| [`emeeks/d3-cartogram`](https://github.com/emeeks/d3-cartogram) | JS, BSD | Dougenik-style + TopoJSON arc warping in JS. Closest existing prior art to our contiguous fallback; good structural reference, but d3/TopoJSON-coupled and unmaintained. |
| `d3-geo`, `d3-quadtree`, `d3-force` | JS, ISC | Projection, spatial index, Dorling relaxation primitives. Reusable directly. |
| `topojson-client` / `topojson-server` | JS, BSD | Arc extraction for shared-border preservation (F18). |
| R `cartogram` (Jeworutzki), `cartogramR` ([CRAN](https://cran.rstudio.com/web/packages/cartogramR/index.html)) | R, GPL | Behavioural reference & cross-check for Dougenik and GSM outputs. |
| `fft.js` / `pocketfft`-style TS ports | MIT | DCT-II/DCT-III needed by the diffusion solver. May need to write the cosine transform on top of a real FFT. |

## 8. Consequence for our design

0. **Densify boundaries** (Duncan & Gastner 2025) before any warp — not optional.
1. **Olson** first — trivial, gives us the pipeline, metrics and harness for free.
2. **Dougenik–Chrisman–Niemeyer + quadtree** second — first contiguous result, cheap, near-linear.
3. **Dorling/Demers** third — reuses the quadtree from step 2.
4. **Gastner–Seguy–More** last and biggest — needs DCT, an adaptive integrator, and careful
   grid/blur scheduling. It is the quality target; the earlier methods are what we compare against.
5. Shared-border integrity comes from warping a **global displacement field** (methods 1/4 apply the
   same transform to identical coordinates by construction) or from **arc-level deduplication**
   (method 2), never from per-polygon independent movement.
