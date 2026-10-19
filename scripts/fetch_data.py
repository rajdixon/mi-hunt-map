"""Download Michigan huntable-land layers as simplified GeoJSON.

Uses the same layers and filters as the DNR's MiHunt map (web map
18147285694d4ec7b0af058562b677da), saved in scripts/layers.json.
Run from the repo root:  python3 scripts/fetch_data.py
"""
import datetime
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
LAYERS = json.loads((ROOT / "scripts" / "layers.json").read_text())
MI_BBOX = "-90.42,41.69,-82.12,48.31"

# out file -> (MiHunt layer title, fields to keep, extra where clause)
SOURCES = {
    "state_forest": ("DNR Forestry - Huntable", ["UnitName", "County"], None),
    "state_wildlife": ("DNR Wildlife - Huntable", ["OfficialWLDProjectAreaName", "AreaType"], None),
    "state_parks": ("DNR Parks and Recreation - Huntable",
                    ["Facility", "HuntTrap", "HuntTrapRestrictions", "EarlyGoose", "Comments"], None),
    "hap": ("Hunter Access Program Lands",
            ["HAPID", "COUNTY", "HuntType", "HAPPermit", "HAPInfo", "SpecialComment", "acres"], None),
    "commercial_forest": ("Commercial Forest - Huntable", ["CountyName", "Acres", "FullLegalName"], None),
    "national_forest": ("US Forest Service - Huntable", ["Unit_Name", "Link"], None),
    # Reference layers for the hunt-rules panel (not drawn as huntable land)
    "counties": ("Counties", ["Name", "Peninsula"], None),
    "dmu": ("Deer Management Units", ["DeerManagementUnit", "MangementUnitName", "Year"], None),
}

OFFSET = 0.00008  # degrees, about 8 m: invisible at field zooms, cuts size a lot


def get(url, params, tries=4):
    # The DNR servers sometimes time out (504) or drop a request; wait and try again
    data = urllib.parse.urlencode(params).encode()
    for n in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=180) as r:
                out = json.load(r)
            if "error" in out:   # ArcGIS reports some failures inside a 200 response
                raise urllib.error.URLError(out["error"].get("message", "server error"))
            return out
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
            if n == tries - 1:
                raise
            wait = 30 * (n + 1)
            print(f"  {e}; trying again in {wait} s", flush=True)
            time.sleep(wait)


def get_features(url, base, chunk):
    """One batch of features; a batch that keeps timing out is split in half."""
    try:
        return get(url, {**base, "objectIds": ",".join(map(str, chunk)), "where": "1=1"})["features"]
    except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError):
        if len(chunk) <= 25:
            raise
        half = len(chunk) // 2
        return get_features(url, base, chunk[:half]) + get_features(url, base, chunk[half:])


def fetch(title, fields, extra):
    url = LAYERS[title]["url"].rstrip("/") + "/query"
    where = LAYERS[title]["where"] or "1=1"
    if extra:
        where = f"({where}) AND ({extra})"
    base = {
        "where": where, "outFields": ",".join(fields), "f": "geojson", "outSR": 4326,
        "geometry": MI_BBOX, "geometryType": "esriGeometryEnvelope", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "maxAllowableOffset": OFFSET, "geometryPrecision": 5,
    }
    ids = sorted(get(url, {**base, "returnIdsOnly": "true", "f": "json"})["objectIds"] or [])
    # Coded-value fields (e.g. state forest County/UnitName) come back as ints
    meta = get(url[:-len("/query")], {"f": "json"})
    domains = {f["name"]: {c["code"]: c["name"] for c in f["domain"]["codedValues"]}
               for f in meta["fields"] if (f.get("domain") or {}).get("type") == "codedValue"}
    feats = []
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for f in get_features(url, base, chunk):
            if not f.get("geometry"):
                continue
            props = f["properties"]
            for k, lookup in domains.items():
                if k in props:
                    props[k] = lookup.get(props[k], props[k])
            f["properties"] = {k: v for k, v in props.items() if k in fields}
            feats.append(f)
    return {"type": "FeatureCollection", "features": feats}


if __name__ == "__main__":
    failed = []
    for name, (title, fields, extra) in SOURCES.items():
        path = ROOT / "data" / f"{name}.geojson"
        try:
            fc = fetch(title, fields, extra)
        except Exception as e:
            # Keep last week's copy of this layer and still update the rest
            if not path.exists():
                raise
            print(f"::warning::{name}: download failed ({e}); keeping the old copy", flush=True)
            failed.append(name)
            continue
        # Refuse to overwrite good data with a partial download (service outage, filter change)
        if path.exists():
            before = len(json.loads(path.read_text())["features"])
            if len(fc["features"]) < before * 0.8:
                sys.exit(f"{name}: got {len(fc['features'])} features, had {before}. Not overwriting.")
        path.write_text(json.dumps(fc, separators=(",", ":")))
        print(f"{name:18} {len(fc['features']):6} features  {path.stat().st_size / 1e6:6.1f} MB")
    if len(failed) == len(SOURCES):
        sys.exit("Every layer failed to download; the DNR servers may be down.")
    if not failed:
        (ROOT / "data" / "meta.json").write_text(json.dumps({"updated": datetime.date.today().isoformat()}))
