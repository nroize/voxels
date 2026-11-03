"""What the viewer needs to find and pick things (web/src/search.ts, web/src/inspect.ts):

- buildings.json  one row per building (an outline with its parts): OSM id, name, address, height and where it came
                  from, levels, the bounding box in map metres, base and top voxel z
- tiles/b/{tx}_{ty}.bin  gzip of uint16[N * N]: the building of each 1 m column of a level-1 node (0: none), so a
                  click can be turned into a building, and a building cut out of the voxel tiles
- search.json     streets (merged centre lines), OSM addresses, and named places

OSM has addresses for only a fraction of the buildings; the viewer interpolates the others along the street from
the numbers that are mapped (search.ts).
"""
import gzip
import json
import math
import re

import numpy as np
import shapely
from shapely import LineString, Point, Polygon, box
from shapely.ops import unary_union

import tiles
from cities import FLOOR

STRIP = re.compile(r"^(שדרות|שד'|רחוב|רח'|דרך)\s+")


def groups(city):
    """building index (into city.blist) -> group id (1-based). Parts join their outline; parts with no outline
    (Azrieli Sarona is mapped as eleven stacked parts and nothing else) join the parts they overlap"""
    info, feats = city.binfo, city.blist
    parent = list(range(len(info)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, b in enumerate(info):
        if b["part"] and "outline" in b:
            parent[find(i)] = find(b["outline"])
    # and anything floating (a crown mapped as its own building) joins what it overlaps
    loose = [i for i, b in enumerate(info) if (b["part"] and "outline" not in b) or (not b["part"] and b["minh"] > 0.5)]
    if loose:
        allg = [f["geom"] for f in feats]
        tree = shapely.STRtree(allg)
        for i in loose:
            g = allg[i]
            for k in tree.query(g, predicate="intersects"):
                if k != i and g.intersection(allg[k]).area > 1:
                    parent[find(i)] = find(int(k))
    gid = np.zeros(len(info) + 1, np.int32)
    ids = {}
    for i in range(len(info)):
        r = find(i)
        if r not in ids:
            ids[r] = len(ids) + 1
        gid[i + 1] = ids[r]
    if len(ids) >= 65535:
        raise RuntimeError("too many buildings for uint16 ids")
    return gid, ids


def export(city, log):
    W, D = city.c["W"], city.c["D"]
    gid_of, roots = groups(city)
    graster = gid_of[city.bid]
    # id tiles
    out = city.out / "tiles" / "b"
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*.bin"):
        f.unlink()
    N = tiles.N
    nx, ny = -(-W // N), -(-D // N)
    for ty in range(ny):
        for tx in range(nx):
            a = np.zeros((N, N), np.uint16)
            blk = graster[ty * N:(ty + 1) * N, tx * N:(tx + 1) * N]
            a[:blk.shape[0], :blk.shape[1]] = blk
            if a.any():
                with gzip.GzipFile(out / f"{tx}_{ty}.bin", "wb", compresslevel=9, mtime=0) as fh:
                    fh.write(a.tobytes())
    # the registry
    top3 = city.hi + city.radd
    members = {}
    for i, b in enumerate(city.binfo):
        members.setdefault(int(gid_of[i + 1]), []).append(i)
    addr_nodes = address_nodes(city, graster)
    rows = [None] * (len(roots) + 1)
    for g, mem in members.items():
        cells = [city.cells[i] for i in mem if i in city.cells]
        if not cells:
            rows[g] = None
            continue
        cl = np.concatenate(cells)
        r, c = np.divmod(cl, W)
        # the named one, else the largest outline (a tower over its floating crown), else the largest part
        named = [i for i in mem if city.blist[i]["tags"].get("name")]
        outl = [i for i in mem if not city.binfo[i]["part"]]
        root = city.blist[max(named or outl or mem, key=lambda i: (not city.binfo[i]["part"], city.binfo[i]["area"]))]
        t = root["tags"]
        name = t.get("name:en") or t.get("name") or next((city.blist[i]["tags"].get("name") for i in mem if city.blist[i]["tags"].get("name")), None)
        he = t.get("name:he") or (t.get("name") if t.get("name") != name else None)
        bi = city.binfo[mem[0] if city.binfo[mem[0]].get("top") is not None else mem[0]]
        rb = city.binfo[next((i for i in mem if not city.binfo[i]["part"]), mem[0])]
        street, num = t.get("addr:street"), t.get("addr:housenumber")
        if not (street and num) and g in addr_nodes:
            street, num = addr_nodes[g]
        lv = max((l for l in (osm_levels(city.blist[i]["tags"]) for i in mem) if l), default=None)  # the tallest part's
        rows[g] = dict(
            osm=root["id"], name=name, he=he if he != name else None, kind=t.get("building") or t.get("building:part"),
            addr=f"{street} {num}" if street and num else None,
            h=round(max(city.binfo[i]["h"] for i in mem), 1), src=rb["src"], levels=lv,
            box=[int(c.min()), int(r.min()), int(c.max()) + 1, int(r.max()) + 1],
            z0=int(min(city.binfo[i].get("g0", 0) for i in mem)), z1=int(top3.flat[cl].max()) + 3,
        )
    # compact: a list of lists, keys once
    keys = ["osm", "name", "he", "kind", "addr", "h", "src", "levels", "box", "z0", "z1"]
    table = [None if r is None else [r[k] for k in keys] for r in rows]
    (city.out / "buildings.json").write_text(json.dumps(dict(keys=keys, rows=table), ensure_ascii=False, separators=(",", ":")))
    city.groups = (gid_of, graster, rows)
    log(f"buildings.json: {len(roots)} buildings, {sum(1 for r in rows if r and r['addr'])} with an address")
    search_index(city, graster, rows, log)


def osm_levels(t):
    try:
        return int(float(t.get("building:levels")))
    except (TypeError, ValueError):
        return None


def address_nodes(city, graster):
    """addresses mapped on nodes (entrances, shops) -> the building they stand in"""
    W, D = city.c["W"], city.c["D"]
    out = {}
    for f in city.feats:
        t, g = f["tags"], f["geom"]
        if not isinstance(g, Point) or not (t.get("addr:street") and t.get("addr:housenumber")):
            continue
        x, y = int(g.x), int(g.y)
        if 0 <= x < W and 0 <= y < D and graster[y, x]:
            out.setdefault(int(graster[y, x]), (t["addr:street"], t["addr:housenumber"]))
    return out


def search_index(city, graster, rows, log):
    W, D = city.c["W"], city.c["D"]
    frame = box(0, 0, W, D)
    # streets: every named way merged by its Hebrew name, with the English one where any piece has it
    by = {}
    for f in city.feats:
        t, g = f["tags"], f["geom"]
        if "highway" not in t or not isinstance(g, LineString) or not t.get("name"):
            continue
        s = by.setdefault(t["name"], dict(en=None, lines=[]))
        s["en"] = s["en"] or t.get("name:en")
        s["lines"].append(g)
    streets = []
    for he, s in by.items():
        g = unary_union(s["lines"]).intersection(frame)
        if g.is_empty:
            continue
        g = shapely.line_merge(g) if g.geom_type == "MultiLineString" else g
        lines = [l for l in getattr(g, "geoms", [g]) if isinstance(l, LineString) and l.length > 5]
        if not lines:
            continue
        lines = [[[round(x, 1), round(y, 1)] for x, y in l.simplify(1.0).coords] for l in sorted(lines, key=lambda l: -l.length)]
        streets.append(dict(he=he, en=s["en"], lines=lines))
    # addresses: buildings, and nodes outside any building
    addrs = []
    for g, r in enumerate(rows):
        if r and r["addr"]:
            x0, y0, x1, y1 = r["box"]
            st, num = r["addr"].rsplit(" ", 1)
            p = centroid_of(graster, g, r["box"])
            addrs.append([st, num, round(p[0], 1), round(p[1], 1), g])
    for f in city.feats:
        t, p = f["tags"], f["geom"]
        if isinstance(p, Point) and t.get("addr:street") and t.get("addr:housenumber") and 0 <= p.x < W and 0 <= p.y < D:
            gg = int(graster[int(p.y), int(p.x)])
            if not gg:
                addrs.append([t["addr:street"], t["addr:housenumber"], round(p.x, 1), round(p.y, 1), 0])
    # places: everything named that is not a road, one per name and spot
    places, seen = [], set()
    for f in city.feats:
        t, g = f["tags"], f["geom"]
        name = t.get("name")
        if not name or "highway" in t or t.get("natural") == "coastline":
            continue
        p = g if isinstance(g, Point) else g.representative_point() if not isinstance(g, LineString) else g.interpolate(0.5, normalized=True)
        if not (0 <= p.x < W and 0 <= p.y < D):
            continue
        key = (name, round(p.x / 50), round(p.y / 50))
        if key in seen:
            continue
        seen.add(key)
        kind = (t.get("amenity") or t.get("tourism") or t.get("leisure") or t.get("shop") and "shop" or t.get("historic")
                or t.get("place") or t.get("railway") or t.get("landuse") or t.get("natural") or t.get("building") or "")
        gg = int(graster[int(p.y), int(p.x)])
        places.append([t.get("name:en") or name, name if t.get("name:en") else None, kind, round(p.x, 1), round(p.y, 1), gg])
    (city.out / "search.json").write_text(json.dumps(dict(streets=streets, addrs=addrs, places=places), ensure_ascii=False, separators=(",", ":")))
    log(f"search.json: {len(streets)} streets, {len(addrs)} addresses, {len(places)} places")


def centroid_of(graster, g, bx):
    x0, y0, x1, y1 = bx
    ys, xs = np.nonzero(graster[y0:y1, x0:x1] == g)
    if not len(xs):
        return (x0 + x1) / 2, (y0 + y1) / 2
    # the cell nearest the mean, so an L-shaped block's point is on the block
    mx, my = xs.mean(), ys.mean()
    k = np.argmin((xs - mx) ** 2 + (ys - my) ** 2)
    return x0 + xs[k] + 0.5, y0 + ys[k] + 0.5
