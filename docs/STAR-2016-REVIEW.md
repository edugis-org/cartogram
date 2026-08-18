# Deep read: Nusrat & Kobourov, *The State of the Art in Cartograms* (CGF 35(3), 2016)

Sources: [arXiv:1605.08485](https://arxiv.org/abs/1605.08485) ·
[author PDF](https://www2.cs.arizona.edu/~kobourov/star.pdf) ·
[Wiley](https://onlinelibrary.wiley.com/doi/abs/10.1111/cgf.12932)

This is the field's reference survey. Below: what it says, what it prescribes, whether its
"best" method satisfies our requirements, what has surpassed it, and where it is incomplete.

---

## 1. What the paper is

A STAR (state-of-the-art report) covering value-by-area cartograms: history, algorithms
1973–2015, quality metrics, task taxonomies, and user studies. It explicitly excludes
choropleths, graduated-symbol maps and travel-distance maps.

### 1.1 The three design dimensions

Everything in the paper is organized around three axes that **cannot all be maximized at once**:

1. **Statistical accuracy** — do areas match the data?
2. **Geographical accuracy** — do shapes and relative positions still look like the map?
3. **Topological accuracy** — are region adjacencies preserved?

Their central conclusion is stated flatly: **there is no "perfect" cartogram.** Any method
trades one axis against the others.

### 1.2 Four primary types (plus variants)

| Type | Statistical | Contiguous | Geography (shape) | Topology |
|---|---|---|---|---|
| Rubber map (Tobler 1973) | not accurate | yes | distorted | preserved |
| **Diffusion (Gastner–Newman 2004)** | **almost exact** | yes | distorted but recognizable | preserved |
| Dorling (circles) | exact | no | not preserved | not preserved |
| Rectangular | depends | yes | not preserved | depends |
| Non-contiguous (Olson 1976) | exact | no | **exactly preserved** | not preserved |
| Rectilinear | exact | yes | not preserved | preserved |
| Table cartogram | exact | yes | not preserved | depends |

Variants also covered: circular-arc, mosaic (Cano et al. 2015), table cartograms.

### 1.3 Algorithms covered (by year)

1973 Tobler rubber map · 1976 Olson non-contiguous · 1978 Kadmon–Shlomi polyfocal ·
1985 Dougenik–Chrisman–Niemeyer rubber sheet · 1986 Tobler pseudo-cartogram ·
1990 Torguson polygon zipping · 1996 Dorling circles + cellular automata ·
1997 Kocmoud constraint-based · 2004 Gastner–Newman diffusion; Heilmann RecMap;
Keim CartoDraw · 2005–2007 van Kreveld–Speckmann rectangular cartograms ·
2012 Buchin evolutionary rectangular · 2013 Sun fast rubber-sheet; Inoue–Shimizu
triangulation; Sagar morphology-based · 2015 Cano mosaic cartograms.

---

## 2. The metrics it standardizes (implement these verbatim)

**Average cartographic error** over regions `V`, with `o(v)` = achieved (normalized) area
and `w(v)` = desired value:

```
(1/|V|) · Σ_v  |o(v) − w(v)| / max{o(v), w(v)}
```

**Maximum cartographic error**: same expression, `max` over `v` instead of the mean.

Note the denominator is `max{o,w}`, **not** `w`. This bounds each term in [0,1] and stops a
single tiny region from dominating. Naive implementations divide by `w` and report
incomparable numbers — this is the most common cross-paper inconsistency.

**Topological error**, on adjacency edge sets `E_c` (cartogram) and `E_m` (map):

```
1 − |E_c ∩ E_m| / |E_c ∪ E_m|
```

i.e. one minus the Jaccard index of the adjacency graphs.

**Shape error** — no single winner; the paper lists four candidates:
- **Hamming distance / symmetric difference**: fraction of area in exactly one of the two
  polygons (after normalizing scale/position);
- **turning-function** distance (Arkin et al.);
- **Fourier-descriptor** distance (Keim et al.);
- **aspect-ratio** of the bounding box (crude but cheap).

**Complexity / readability**: polygonal complexity (corner count per region), plus runtime.

---

## 3. "Best steps to create a cartogram" per the paper

The paper does not give a single recipe — it gives a **selection procedure**, and that is
its actual prescription:

1. **Start from the task, not the algorithm.** "The choice of cartogram should depend on
   what needs to be shown and what visualization tasks viewers are expected to perform."
   Their task-based study (Nusrat et al. 2015) found:
   - *find adjacency* → rectangular cartograms best
   - *recognize / locate regions* → non-contiguous best (shape is exact)
   - *summarize, big picture* → Dorling best
   - **most tasks overall → contiguous diffusion best**
   Subjective preference ranked contiguous first (most helpful, best conveys magnitude),
   Dorling second (elegant, entertaining, easy).
2. **Default to the diffusion method** (Gastner–Newman 2004) unless the task says otherwise.
   The paper credits its dominance to near-zero area error *with* recognizable shapes,
   plus available software (Worldmapper).
3. **Decide the axis you will sacrifice explicitly** — statistical, geographical or
   topological — because you must sacrifice one.
4. **Evaluate quantitatively** with the metrics in §2, and the paper calls for this to be
   standardized across algorithms (it wasn't, and largely still isn't).
5. **Design the presentation, not just the geometry.** Concrete recommendations:
   show the original reference map alongside; design a real legend (Stevens' power law:
   people systematically *underestimate* area differences, so area alone under-reports
   magnitude); add labels; add interactive linking/brushing between map and cartogram.

---

## 4. Does the paper's "best" cartogram fit our requirements?

Their recommended default is **contiguous diffusion**. Against `docs/REQUIREMENTS.md`:

| Our requirement | Diffusion verdict |
|---|---|
| F12 known method from literature | ✅ it *is* the canonical method |
| "keep shape as much as possible" | ✅ best of the contiguous family, and the paper's user study confirms recognizability; but shapes *are* distorted — Olson is the only exact-shape option, at the cost of contiguity |
| F18 shared borders not torn | ✅ by construction: a single global displacement field, identical coordinates map identically |
| N1 near-linear in feature count | ✅ **structurally**. Cost is `O(V)` vertex advection + `O(G log G)` grid work, where grid size `G` is a user knob independent of feature count. This is precisely why we picked it. |
| F1/F2 any valid GeoJSON, any LOD | ⚠️ **partly**. The 2016 paper is silent on holes, exclaves, MultiPolygons, and on long straight edges — see §5.3; all three are real failure modes on our NUTS and archipelago datasets. |
| F6 projection | ⚠️ paper assumes a planar map already; equal-area projection is our problem to solve. |
| N3 browser TS, permissive licence | ⚠️ paper is method-only; every reference implementation is GPL/AGPL. We implement from the paper. |
| F11 determinism | ✅ deterministic given fixed grid and step schedule. |

**Conclusion: yes, diffusion fits — with caveats we already planned for.** The paper also
validates our multi-method plan: since no cartogram is universally best and the best type is
*task-dependent*, a library that ships Olson + DCN + Dorling + diffusion behind one API is the
correct product shape, not scope creep. Our M1→M5 order (Olson first, diffusion last) also
matches the paper's own difficulty ordering.

One direct correction to our plan from the paper: our requirements said "mean area error"
loosely. Use the **`max{o,w}` denominator** formula in §2 so our numbers are comparable to
the literature.

---

## 5. Has anything surpassed it?

### 5.1 Yes — for the algorithm, decisively

**Gastner, Seguy & More (2018), PNAS 115:E2156** — the flow-based method. Published *two
years after* the survey, so the STAR's central recommendation (the 2004 diffusion method) is
**out of date on its own terms**. GSM2018 is same-physics but seconds instead of minutes,
with better shape fidelity and a proper adaptive integrator. Anything written after 2018 that
still recommends Gastner–Newman 2004 is citing the wrong paper. This is why our M5 targets
GSM2018, not the 2004 algorithm.

**Sun (2020), "Applying forces to generate cartograms: a fast and flexible transformation
framework", CaGIS** (implementation: [F4Carto](https://sunsp.net/download/programs/F4Carto_Documentation.pdf),
[data/code on Harvard Dataverse](https://doi.org/10.7910/DVN/6ST8NQ)). A force-based
framework that *guarantees topological integrity*, converges fast, and explicitly avoids
extreme shape deformation — pitched as a robust alternative to diffusion. Directly relevant
to our M3 (Dougenik-style forces): it is the modern, hardened version of that family, and
worth following instead of DCN 1985 straight.

**Duncan & Gastner (2025/2026), "Topology-Preserving Line Densification for Creating
Contiguous Cartograms", [arXiv:2511.08121](https://arxiv.org/pdf/2511.08121), accepted in
CaGIS.** The most operationally important recent paper for us. Problem: boundaries are
polylines with finitely many vertices, so a warp field applied only at existing vertices can
make regions overlap or disconnect — long straight edges bend "through" their neighbours.
Fix: **densify boundary lines before warping**, in a topology-preserving way. Reported
better accuracy *and* speed than alternatives at comparable shape fidelity.
**This must be a step in our pipeline, not an afterthought** — our synthetic `grid`,
`hex` and `degenerate` datasets are exactly the long-straight-edge case that breaks without it.

### 5.2 Yes — for evaluation

**Nusrat, Alam & Kobourov (2018), IEEE TVCG**, "Evaluating cartogram effectiveness" — the
full task-based user study the STAR only previews.

**Duncan & Gastner (2024), PLOS ONE 19:e0298192**,
[comparative evaluation of go-cart.io](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0298192)
([arXiv:2201.04272](https://arxiv.org/abs/2201.04272)) — usability study of web cartogram
tools on generation *and* analysis tasks. This is the closest thing to a design reference
for our M2 human-review harness, and it is post-STAR.

### 5.3 No — nobody has replaced the survey itself

There is **no newer comprehensive cartogram survey**. Searching 2020–2026 turns up applied
papers, tools and single-method advances that all still cite the 2016 STAR as the framework.
So: use the STAR for taxonomy, metrics and task guidance; use GSM2018 + Sun 2020 +
Duncan & Gastner 2025 for what to actually implement.

---

## 6. Is the paper complete?

Complete *for its stated scope and date*, and still the best entry point. But there are real
gaps, some inherent, some just age:

**Age-related (unavoidable):**
- Misses **GSM2018** entirely — its headline algorithmic recommendation is superseded.
- Misses the last decade of hexmaps/**tilegrams**, which are what practitioners actually
  ship in newsrooms now; mosaic cartograms get only Cano 2015.
- Misses modern web/WASM delivery, which changes the practical calculus for a browser library.

**Scope gaps the paper itself admits:**
- Excludes choropleth, graduated-symbol and distance cartograms.
- Draws only on peer-reviewed sources — newspaper/blog practice not captured.
- "Limited evaluation of newer techniques (post-2004)" — by their own words.
- MAUP effects on cartogram design not addressed.
- Task taxonomies acknowledged as still developing.

**Gaps that matter specifically for building a library:**
- **No shared benchmark.** No standard dataset + metric suite, so published numbers are not
  comparable across papers. (We are building that for ourselves in `data/` + `metrics/`.)
- **Shape metric unresolved.** Four candidate measures listed, none endorsed; Hamming
  distance is sensitive to normalization choices the paper doesn't pin down.
- **Silent on messy real geometry**: holes, exclaves, MultiPolygons, slivers, gaps and
  overlaps in source data, antimeridian. Every one of these appears in our NUTS/world data.
- **Silent on projection.** Assumes planar input; area-proportionality is meaningless without
  an equal-area projection step, which is a first-class correctness issue for lon/lat GeoJSON.
- **Silent on discretization** — the exact hole that Duncan & Gastner 2025 later fills.
- **No complexity/performance analysis worth the name.** Runtime is listed as a metric but
  scaling behaviour is not analysed, which is the single property we most need (N1).
- **No software or licensing view.** Not the authors' job, but it is decisive for us: the
  quality implementations are GPL/AGPL.

---

## 7. Actions taken into our plan

1. Adopt the STAR metric definitions **verbatim** (`max{o,w}` denominator; adjacency Jaccard;
   Hamming distance for shape) in `src/metrics/`.
2. Add a **topology-preserving line densification** stage before any warping method
   (Duncan & Gastner 2025). New pipeline step, ahead of M3 and required by M5.
3. Follow **Sun 2020 / F4Carto** for the force-based method rather than DCN 1985 unmodified —
   same family, topology guarantees, better convergence.
4. Keep **GSM2018**, not Gastner–Newman 2004, as the M5 target.
5. Build the human review harness (M2) along the lines of the go-cart.io evaluation
   (Duncan & Gastner 2024) — generation *and* analysis tasks, not just eyeballing.
6. Keep the multi-method API: the STAR's "no perfect cartogram" plus its task-dependence
   result is the justification.
7. Ship the reference map + legend guidance in docs/examples — the paper's presentation
   recommendations are cheap and materially improve interpretation.
