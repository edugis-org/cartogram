# Reading the metrics

Cartograms are read by eye, not measured. The metrics exist to catch failures and
regressions, not to be minimized for their own sake — and several of them sit far below
anything a reader can perceive long before the algorithm stops improving them.

## Area error is quadratic in what you see

Area error is reported as `|achieved − wanted| / max(achieved, wanted)`
(Nusrat & Kobourov 2016). What a reader actually sees is a *length*, and length goes as
the square root of area. Worked from a real run of the Dutch provinces:

| reported area error | linear scale error | on a 30 km region | on screen at 600 px / 300 km |
|---:|---:|---:|---:|
| 0.2% | 0.1% | 30 m | 0.06 px |
| 0.75% (mean of that run) | 0.4% | 110 m | 0.2 px |
| 6% (worst region, Zeeland) | 3.1% | 906 m | 1.8 px |
| 25% | 12% | 3.6 km | 7 px |
| 100% | — | region is at best half or twice its due size | obvious |

Human area judgement is far coarser than this. It is among the least accurate visual
encodings (Cleveland & McGill), the just-noticeable difference for area comparisons is
on the order of 10–20%, and Stevens' power law says people *underestimate* area
differences rather than exaggerating them — which is why the survey recommends legends.

**Practical thresholds:**

- **mean area error below ~2%** — invisible. Improving it further is arithmetic, not
  cartography.
- **max area error above ~20%** — visible: some region is plainly the wrong size. This
  is the number worth watching, and on hard datasets it is where the real failures live
  (NUTS 2 at grid 256 reports a mean of 11% but a max of 93%: a handful of dense urban
  regions never reach their due size, and *that* is what a reader notices).
- **rounding (mean +drift)** — a region turning into a disc is visible at +0.05 and
  obvious at +0.1, long before area error says anything is wrong.
- **self-intersections** — any non-zero count is a rendering defect, visible as knots or
  holes wherever a boundary crosses itself. Some are inherited from the input.
- **topology error** — anything above 0 on a contiguous method means the map has torn.

## A max of exactly 100% usually means missing data

If the maximum area error sits at 100% on a dataset with gaps, look at the
missing-value policy before looking at the algorithm. Under `missing: 'zero'` a region
with no data is told its target share is zero. It cannot then be anything other than
100% wrong, whatever size it comes out — the error is `|achieved − 0| / achieved = 1` by
definition — and it still occupies space, so it drifts about being pushed by its
neighbours.

On NUTS 3, 181 of the 1514 regions have no Eurostat population (the United Kingdom),
and every one of them reports exactly 100%. The mean error is 35.3% under `zero` and
27.1% under `drop`, and the no-data regions occupy 3.2% of the map under `zero` and none
at all under `drop`. `drop` is the honest policy for genuinely unknown values; `zero`
belongs to values that really are zero.

## What this means for tuning

Two hours were spent taking the flow method from 0.198% to 0.174% mean area error on the
Dutch provinces, via an analytic velocity field that doubled the runtime. The difference
is roughly a twentieth of a pixel. It was not worth it, and the analytic gradient is
therefore available but not the default.

Time is better spent on: the maximum error rather than the mean, the shape metrics, grid
resolution where regions are smaller than a cell, and — above all — looking at the map.
That is what the review harness is for.
