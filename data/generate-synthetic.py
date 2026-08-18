#!/usr/bin/env python3
"""Generate deterministic synthetic GeoJSON test datasets for cartogram-ts.

Every feature carries a numeric `value` property (the cartogram variable) plus
`id` and `name`. Coordinates are plain planar numbers in a lon/lat-plausible
range so the files are valid GeoJSON and also usable with `project: 'none'`.
Deterministic: fixed seed, no wall-clock input.
"""
import json, math, os, random

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "synthetic")
os.makedirs(OUT, exist_ok=True)
random.seed(20260818)


def write(name, features):
    fc = {"type": "FeatureCollection", "features": features}
    path = os.path.join(OUT, name + ".geojson")
    with open(path, "w") as fh:
        json.dump(fc, fh)
    verts = sum(len(r) for f in features for poly in polys(f["geometry"]) for r in poly)
    print(f"{name:28s} features={len(features):6d} vertices={verts:7d}")


def polys(geom):
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def feature(fid, name, geom, value):
    return {"type": "Feature", "id": fid,
            "properties": {"id": fid, "name": name, "value": value},
            "geometry": geom}


def ring(points):
    """Close a ring."""
    return points + [points[0]]


def densify(points, n_per_edge):
    """Subdivide each edge into n_per_edge segments -- controls level of detail."""
    out = []
    for i in range(len(points) - 1):
        (x0, y0), (x1, y1) = points[i], points[i + 1]
        for k in range(n_per_edge):
            t = k / n_per_edge
            out.append([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])
    out.append(points[-1])
    return out


# 1. Regular square grid -------------------------------------------------------
def grid(cols, rows, detail=1, name="grid"):
    feats = []
    for j in range(rows):
        for i in range(cols):
            box = ring([[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]])
            if detail > 1:
                box = densify(box, detail)
            # value: smooth radial bump + corner spike -> exercises both mild and
            # extreme rescaling in one dataset
            cx, cy = cols / 2, rows / 2
            d = math.hypot(i + .5 - cx, j + .5 - cy) / max(cx, cy)
            v = 1 + 40 * math.exp(-4 * d * d)
            if i == 0 and j == 0:
                v = 500          # deliberate outlier
            feats.append(feature(f"c{i}-{j}", f"cell {i},{j}",
                                 {"type": "Polygon", "coordinates": [box]}, round(v, 4)))
    write(name, feats)


# 2. Hexagonal tessellation ----------------------------------------------------
def hexgrid(cols, rows, name="hex"):
    feats, r = [], 1.0
    w, h = math.sqrt(3) * r, 1.5 * r
    for j in range(rows):
        for i in range(cols):
            cx = i * w + (w / 2 if j % 2 else 0)
            cy = j * h
            pts = [[cx + r * math.sin(math.pi / 3 * k), cy + r * math.cos(math.pi / 3 * k)]
                   for k in range(6)]
            v = 1 + 20 * abs(math.sin(i * .7) * math.cos(j * .5))
            feats.append(feature(f"h{i}-{j}", f"hex {i},{j}",
                                 {"type": "Polygon", "coordinates": [ring(pts)]}, round(v, 4)))
    write(name, feats)


# 3. Concentric rings (polygons with holes) ------------------------------------
def rings(n=8, seg=64, name="rings"):
    feats = []
    for k in range(n):
        r_out, r_in = (k + 1) * 2.0, k * 2.0
        outer = [[r_out * math.cos(2 * math.pi * s / seg), r_out * math.sin(2 * math.pi * s / seg)]
                 for s in range(seg)]
        coords = [ring(outer)]
        if k > 0:                                    # hole
            inner = [[r_in * math.cos(-2 * math.pi * s / seg), r_in * math.sin(-2 * math.pi * s / seg)]
                     for s in range(seg)]
            coords.append(ring(inner))
        feats.append(feature(f"r{k}", f"ring {k}",
                             {"type": "Polygon", "coordinates": coords}, round(1 + k * k, 4)))
    write(name, feats)


# 4. Archipelago: multipolygons with far-flung islands -------------------------
def archipelago(n=20, name="archipelago"):
    feats = []
    for k in range(n):
        parts = []
        for p in range(random.randint(1, 4)):
            cx, cy = random.uniform(-40, 40), random.uniform(-30, 30)
            rad = random.uniform(.3, 2.5)
            seg = random.randint(6, 24)
            pts = [[cx + rad * math.cos(2 * math.pi * s / seg) * random.uniform(.8, 1.2),
                    cy + rad * math.sin(2 * math.pi * s / seg) * random.uniform(.8, 1.2)]
                   for s in range(seg)]
            parts.append([ring(pts)])
        feats.append(feature(f"a{k}", f"isle {k}",
                             {"type": "MultiPolygon", "coordinates": parts},
                             round(random.uniform(1, 1000), 4)))
    write(name, feats)


# 5. Degenerate / adversarial shapes -------------------------------------------
def degenerate(name="degenerate"):
    feats = [
        feature("sliver", "sliver polygon",
                {"type": "Polygon", "coordinates": [ring([[0, 0], [10, 0], [10, .001], [0, .001]])]}, 100),
        feature("spiky", "spiky star",
                {"type": "Polygon", "coordinates": [ring(
                    [[math.cos(2 * math.pi * k / 40) * (3 if k % 2 else .3),
                      math.sin(2 * math.pi * k / 40) * (3 if k % 2 else .3)] for k in range(40)])]}, 50),
        feature("dup", "duplicate vertices",
                {"type": "Polygon", "coordinates": [ring([[20, 0], [20, 0], [24, 0], [24, 4], [24, 4], [20, 4]])]}, 10),
        feature("tiny", "tiny square with huge value",
                {"type": "Polygon", "coordinates": [ring([[30, 0], [30.01, 0], [30.01, .01], [30, .01]])]}, 9999),
        feature("zero", "zero-valued region",
                {"type": "Polygon", "coordinates": [ring([[35, 0], [40, 0], [40, 5], [35, 5]])]}, 0),
        feature("missing", "missing value", {"type": "Polygon",
                "coordinates": [ring([[45, 0], [50, 0], [50, 5], [45, 5]])]}, None),
        feature("negative", "negative value", {"type": "Polygon",
                "coordinates": [ring([[55, 0], [60, 0], [60, 5], [55, 5]])]}, -20),
    ]
    write(name, feats)


# 6. Level-of-detail ladder: same map, increasing vertex count -----------------
def lod_ladder():
    for detail, tag in ((1, "1e2"), (8, "1e3"), (64, "1e4"), (512, "1e5")):
        grid(5, 5, detail=detail, name=f"lod-{tag}")


if __name__ == "__main__":
    grid(10, 10)
    grid(40, 40, name="grid-large")
    hexgrid(20, 20)
    rings()
    archipelago()
    degenerate()
    lod_ladder()
