"""Download (and cache in data/raw) what one city is built from:
- OpenStreetMap, everything the voxelizer reads, via Overpass `out geom` over the city's bounding box
- Copernicus GLO-30 (the 30 m surface model, 2011-15), the 1-degree tiles under the city

usage: uv run python scripts/fetch.py tlv [--force]
"""
import json
import math
import sys
import time
from pathlib import Path

import requests

from cities import CITIES

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
UA = {"User-Agent": "tlv-voxels/0.1 (voxel diorama of Tel Aviv and Rehovot)"}
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]


def bbox(c, margin=150):
    lat, lon = c["center"]
    r = math.hypot(c["W"], c["D"]) / 2 + margin
    dlat, dlon = r / 111_320, r / (111_320 * math.cos(math.radians(lat)))
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon


def query(b):
    bb = ",".join(f"{v:.5f}" for v in b)
    keys = ["building", "building:part", "landuse", "leisure", "natural", "water", "waterway", "amenity",
            "man_made", "tourism", "historic", "place", "public_transport", "aeroway"]
    parts = [f'nwr["{k}"]({bb});' for k in keys]
    parts += [f'way["highway"]({bb});', f'node["highway"]({bb});', f'way["railway"]({bb});',
              f'way["barrier"]({bb});', f'way["area:highway"]({bb});']
    return f"[out:json][timeout:300][maxsize:2000000000];({''.join(parts)});out geom;"


def fetch_osm(key, c, force):
    out = RAW / f"{key}_osm.json"
    if out.exists() and not force:
        print(f"osm: cached {out.name} ({out.stat().st_size / 2 ** 20:.0f} MB)")
        return
    # the whole box in one query times out on the public servers: a grid of cells, merged by element id
    s, w, n, e = bbox(c)
    k = 4
    seen = {}
    for i in range(k):
        for j in range(k):
            cell = (s + (n - s) * i / k, w + (e - w) * j / k, s + (n - s) * (i + 1) / k, w + (e - w) * (j + 1) / k)
            part = RAW / f"{key}_osm_{i}{j}.json"
            if not part.exists() or force:
                part.write_bytes(overpass(query(cell), f"cell {i * k + j + 1}/{k * k}"))
            for el in json.loads(part.read_bytes())["elements"]:
                seen[(el["type"], el["id"])] = el
    out.write_text(json.dumps({"elements": list(seen.values())}))
    print(f"osm: {len(seen)} elements, {out.stat().st_size / 2 ** 20:.0f} MB")


def overpass(q, what):
    for attempt in range(4):
        for url in OVERPASS:
            print(f"osm: {what} from {url} ...", flush=True)
            try:
                r = requests.post(url, data={"data": q}, headers=UA, timeout=900)
                r.raise_for_status()
                if not r.content.lstrip().startswith(b"{"):
                    raise RuntimeError(r.content[:300])
                return r.content
            except Exception as e:  # noqa: BLE001 - try the next mirror
                print(f"osm: failed: {str(e)[:200]}")
        time.sleep(30 * (attempt + 1))
    sys.exit("osm: every Overpass mirror failed")


def fetch_dem(c):
    s, w, n, e = bbox(c)
    for lat in range(math.floor(s), math.floor(n) + 1):
        for lon in range(math.floor(w), math.floor(e) + 1):
            name = f"Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM"
            out = RAW / f"{name}.tif"
            if out.exists():
                print(f"dem: cached {out.name}")
                continue
            url = f"https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif"
            print(f"dem: {url}")
            r = requests.get(url, headers=UA, timeout=300)
            r.raise_for_status()
            out.write_bytes(r.content)


if __name__ == "__main__":
    RAW.mkdir(parents=True, exist_ok=True)
    keys = [a for a in sys.argv[1:] if not a.startswith("-")] or list(CITIES)
    for k in keys:
        fetch_osm(k, CITIES[k], "--force" in sys.argv)
        fetch_dem(CITIES[k])
