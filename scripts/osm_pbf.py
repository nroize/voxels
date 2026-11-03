"""Cut a city out of the Geofabrik extract (israel-and-palestine-latest.osm.pbf in data/raw) into the same JSON as
Overpass `out geom` (scripts/fetch.py), for when the public Overpass servers are too busy for the query.

usage: uv run python scripts/osm_pbf.py tlv rehovot
"""
import json
import sys
import time

import osmium

from cities import CITIES
from fetch import RAW, bbox

KEYS = ("building", "building:part", "landuse", "leisure", "natural", "water", "waterway", "amenity", "man_made",
        "tourism", "historic", "place", "public_transport", "aeroway", "highway", "railway", "barrier", "area:highway")
NODE_KEYS = tuple(k for k in KEYS if k not in ("barrier",))


def interesting(tags, keys=KEYS):
    return any(k in tags for k in keys)


def convert(pbf, boxes):
    """boxes: {city: (s, w, n, e)} -> {city: [elements]}"""
    t0 = time.time()
    rels = []
    for o in osmium.FileProcessor(str(pbf), osmium.osm.RELATION):
        if o.tags.get("type") in ("multipolygon", "building") and interesting(o.tags):
            rels.append(dict(type="relation", id=o.id, tags=dict(o.tags),
                             members=[(m.type, m.ref, m.role) for m in o.members]))
    need = {ref for r in rels for (t, ref, _) in r["members"] if t == "w"}
    print(f"pbf: {len(rels)} relations, {len(need)} member ways ({time.time() - t0:.0f}s)", flush=True)

    def inside(b, lon, lat):
        return b[0] <= lat <= b[2] and b[1] <= lon <= b[3]

    out = {k: [] for k in boxes}
    wgeom = {}
    for o in osmium.FileProcessor(str(pbf)).with_locations():
        if o.is_node():
            if not interesting(o.tags, NODE_KEYS):
                continue
            lon, lat = o.location.lon, o.location.lat
            for k, b in boxes.items():
                if inside(b, lon, lat):
                    out[k].append(dict(type="node", id=o.id, lat=lat, lon=lon, tags=dict(o.tags)))
        elif o.is_way():
            want = interesting(o.tags)
            if not want and o.id not in need:
                continue
            geom, ids = [], []
            for n in o.nodes:
                ids.append(n.ref)
                geom.append(dict(lat=n.lat, lon=n.lon) if n.location.valid() else None)
            if o.id in need:
                wgeom[o.id] = geom
            if not want:
                continue
            for k, b in boxes.items():
                if any(p and inside(b, p["lon"], p["lat"]) for p in geom):
                    out[k].append(dict(type="way", id=o.id, tags=dict(o.tags), nodes=ids, geometry=geom))
    for r in rels:
        mem = [dict(type="way" if t == "w" else "node" if t == "n" else "relation", ref=ref, role=role,
                    geometry=wgeom.get(ref)) for t, ref, role in r["members"]]
        for k, b in boxes.items():
            if any(m["geometry"] and any(p and inside(b, p["lon"], p["lat"]) for p in m["geometry"]) for m in mem):
                out[k].append(dict(type="relation", id=r["id"], tags=r["tags"], members=mem))
    print(f"pbf: done in {time.time() - t0:.0f}s", flush=True)
    return out


if __name__ == "__main__":
    keys = sys.argv[1:] or list(CITIES)
    res = convert(RAW / "israel-and-palestine-latest.osm.pbf", {k: bbox(CITIES[k]) for k in keys})
    for k, els in res.items():
        p = RAW / f"{k}_osm.json"
        p.write_text(json.dumps({"elements": els}))
        print(f"{k}: {len(els)} elements, {p.stat().st_size / 2 ** 20:.0f} MB")
