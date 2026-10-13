"""Find public hunting land that no public road touches ("possibly landlocked").

Joins the public land in data/ (state forest, game and wildlife areas, state
parks, national forest) with land you can also walk across (Commercial Forest
and Hunter Access Program) into blocks. A block is reachable if any public
road from the Michigan Geographic Framework (Act 51 roads: state highways,
county roads, city streets) touches it. Public pieces of the other blocks go to
data/landlocked.geojson. Some of those can still be reached by water, a trail
or an easement; the app says so.

Needs shapely (pip install shapely). Takes about 20-40 minutes statewide, one
road query per block. Run from the repo root:  python3 scripts/landlocked.py
"""
import json
import math
import pathlib
import sys
import time
import urllib.parse
import urllib.request

from shapely import STRtree
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
ROADS = "https://portal1-geo.sabu.mtu.edu/server/rest/services/Hosted/All_Roads__v17a_/FeatureServer/0/query"
PUBLIC = {"state_forest": ("State Forest", "UnitName"), "state_wildlife": ("State Game & Wildlife Area", "OfficialWLDProjectAreaName"),
          "state_parks": ("State Park", "Facility"), "national_forest": ("National Forest", "Unit_Name")}
WALKABLE = ["commercial_forest", "hap"]
M = 1 / 111_000          # about a metre, in degrees
JOIN_M = 10              # pieces this close count as one block (survey slivers, section lines)
ROAD_M = 20              # a road centreline this close touches the land (right of way is ~10 m each side)
ACRES_PER_DEG2 = 111_000 ** 2 * 0.000247105


def load(name):
    return json.loads((DATA / f"{name}.geojson").read_text())["features"]


def post(params):
    body = urllib.parse.urlencode(params).encode()
    for i in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(ROADS, data=body), timeout=180) as r:
                out = json.load(r)
            if "error" in out:
                raise RuntimeError(out["error"])
            return out
        except Exception as e:  # flaky university server: back off and retry
            err = e
            time.sleep(5 * (i + 1))
    raise err


def touches_road(block):
    g = block.buffer(ROAD_M * M).simplify(8 * M)
    rings = []
    for p in getattr(g, "geoms", [g]):
        rings.append(list(map(list, p.exterior.coords)))
        rings += [list(map(list, h.coords)) for h in p.interiors]
    out = post({"where": "legalsyste > 0", "geometry": json.dumps({"rings": rings, "spatialReference": {"wkid": 4326}}),
                "geometryType": "esriGeometryPolygon", "inSR": 4326, "spatialRel": "esriSpatialRelIntersects",
                "returnCountOnly": "true", "f": "json"})
    return out["count"] > 0


def main():
    # The national forest layer reaches into Wisconsin, where Michigan's road data stops
    michigan = STRtree([shape(f["geometry"]).buffer(0) for f in load("counties")])
    in_mi = lambda g: len(michigan.query(g.representative_point(), predicate="intersects")) > 0
    public = []
    for name, (kind, field) in PUBLIC.items():
        for f in load(name):
            g = shape(f["geometry"]).buffer(0)
            if not g.is_empty and in_mi(g):
                public.append((name, kind, (f["properties"] or {}).get(field), g))
    walk = [g for n in WALKABLE for f in load(n) if in_mi(g := shape(f["geometry"]).buffer(0))]
    merged = unary_union([g.buffer(JOIN_M * M) for *_, g in public] + [g.buffer(JOIN_M * M) for g in walk])
    blocks = list(getattr(merged, "geoms", [merged]))
    # Only blocks with public land in them matter
    tree = STRtree(blocks)
    owner = [int(tree.query(g.representative_point(), predicate="intersects")[0]) for *_, g in public]
    todo = sorted(set(owner))
    print(f"{len(public)} public pieces, {len(blocks)} blocks, {len(todo)} to check", flush=True)

    reach, t0 = {}, time.time()
    for n, i in enumerate(todo, 1):
        reach[i] = touches_road(blocks[i])
        if n % 100 == 0:
            print(f"  {n}/{len(todo)}  {time.time() - t0:.0f}s  {sum(not v for v in reach.values())} landlocked so far", flush=True)

    feats = []
    for (name, kind, unit, g), i in zip(public, owner):
        if reach[i]:
            continue
        acres = g.area * ACRES_PER_DEG2 * math.cos(math.radians(g.centroid.y))
        if acres < 5:      # slivers from the boundary data, and pieces too small to hunt
            continue
        feats.append({"type": "Feature", "properties": {"kind": kind, "unit": unit, "acres": round(acres, 1)},
                      "geometry": mapping(g.simplify(4 * M))})
    path = DATA / "landlocked.geojson"
    if path.exists() and len(feats) < 0.5 * len(load("landlocked")):
        sys.exit(f"Only {len(feats)} landlocked pieces, had {len(load('landlocked'))}. Not overwriting.")
    fc = {"type": "FeatureCollection", "features": feats}
    path.write_text(json.dumps(fc, separators=(",", ":")))
    print(f"landlocked: {len(feats)} pieces, {sum(f['properties']['acres'] for f in feats):.0f} acres, "
          f"{path.stat().st_size / 1e3:.0f} KB, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
