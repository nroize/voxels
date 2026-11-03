"""OSM `out geom` JSON -> shapely geometry in the map frame (metres; x = column to the right, y = row downwards).

The frame: UTM 36N around the city centre, rotated `theta` degrees clockwise so that the street grid is axis-aligned.
"""
import json
import math

import numpy as np
from pyproj import Transformer
from shapely import LineString, MultiPolygon, Point, Polygon, make_valid
from shapely.ops import linemerge, polygonize, unary_union

TO_UTM = Transformer.from_crs("EPSG:4326", "EPSG:32636", always_xy=True)
TO_LL = Transformer.from_crs("EPSG:32636", "EPSG:4326", always_xy=True)


class Frame:
    def __init__(self, center, W, D, theta=0.0):
        self.lat, self.lon = center
        self.E0, self.N0 = TO_UTM.transform(self.lon, self.lat)
        self.W, self.D = W, D
        self.set_theta(theta)

    def set_theta(self, theta):
        self.theta = theta
        t = math.radians(theta)
        self.c, self.s = math.cos(t), math.sin(t)

    def enu(self, lon, lat):
        e, n = TO_UTM.transform(np.asarray(lon, float), np.asarray(lat, float))
        return e - self.E0, n - self.N0

    def from_enu(self, e, n):
        """east/north metres -> map x (right), y (down)"""
        x = e * self.c - n * self.s   # the right axis points at bearing 90 + theta
        u = e * self.s + n * self.c   # the up axis points at bearing theta
        return x + self.W / 2, self.D / 2 - u

    def xy(self, lon, lat):
        return self.from_enu(*self.enu(lon, lat))

    def lonlat(self, x, y):
        x, u = np.asarray(x, float) - self.W / 2, self.D / 2 - np.asarray(y, float)
        e, n = x * self.c + u * self.s, -x * self.s + u * self.c
        return TO_LL.transform(e + self.E0, n + self.N0)


def load(path):
    with open(path) as fh:
        return json.load(fh)["elements"]


def _coords(frame, geom):
    lon = [p["lon"] for p in geom if p]
    lat = [p["lat"] for p in geom if p]
    x, y = frame.xy(lon, lat)
    return list(zip(x.tolist(), y.tolist()))


def _poly(ring):
    if len(ring) < 4:
        return None
    p = Polygon(ring)
    if not p.is_valid:
        p = make_valid(p)
        p = MultiPolygon([g for g in getattr(p, "geoms", [p]) if isinstance(g, Polygon)]) if not isinstance(p, (Polygon, MultiPolygon)) else p
    return p if not p.is_empty else None


def _multipolygon(frame, el):
    outer, inner = [], []
    for m in el.get("members", []):
        if m.get("type") != "way" or not m.get("geometry"):
            continue
        ls = LineString(_coords(frame, m["geometry"])) if len(m["geometry"]) > 1 else None
        if ls is None:
            continue
        (inner if m.get("role") == "inner" else outer).append(ls)

    def rings(lines):
        if not lines:
            return None
        return unary_union(list(polygonize(linemerge(lines) if len(lines) > 1 else lines)))

    o = rings(outer)
    if o is None or o.is_empty:
        return None
    i = rings(inner)
    g = o.difference(i) if i is not None and not i.is_empty else o
    return make_valid(g) if not g.is_valid else g


AREA_KEYS = ("building", "building:part", "landuse", "leisure", "amenity", "area:highway", "natural", "water",
             "tourism", "historic", "man_made", "place", "aeroway", "public_transport")


def is_area(tags):
    if tags.get("area") == "yes":
        return True
    if tags.get("area") == "no":
        return False
    if tags.get("natural") in ("coastline", "tree_row", "cliff", "ridge"):
        return False
    if tags.get("man_made") in ("breakwater", "groyne", "pier", "embankment") and tags.get("area") != "yes":
        return None  # closed piers are areas, open ones lines: decided by the ring
    if "highway" in tags and "area:highway" not in tags:
        return tags.get("highway") == "pedestrian" and tags.get("area") == "yes"
    if "barrier" in tags and not any(k in tags for k in AREA_KEYS):
        return False
    if "railway" in tags and not any(k in tags for k in AREA_KEYS):
        return False
    if "waterway" in tags and tags.get("waterway") not in ("riverbank", "dock"):
        return False
    return any(k in tags for k in AREA_KEYS)


def features(frame, elements):
    """-> list of dict(id, kind, tags, geom) where geom is a Point, LineString or (Multi)Polygon in the map frame"""
    out = []
    for el in elements:
        tags = el.get("tags", {})
        t = el["type"]
        g = None
        if t == "node":
            x, y = frame.xy([el["lon"]], [el["lat"]])
            g = Point(float(x[0]), float(y[0]))
        elif t == "way":
            geom = el.get("geometry")
            if not geom or len(geom) < 2:
                continue
            pts = _coords(frame, geom)
            closed = el["nodes"][0] == el["nodes"][-1] and len(pts) >= 4
            area = is_area(tags)
            if area is None:
                area = closed
            g = _poly(pts) if (closed and area) else LineString(pts)
        elif t == "relation":
            if tags.get("type") in ("multipolygon", "building") or tags.get("type") is None:
                g = _multipolygon(frame, el)
        if g is None or g.is_empty:
            continue
        out.append(dict(id=f"{t[0]}{el['id']}", tags=tags, geom=g, nodes=el.get("nodes")))
    return out


def number(v, default=None):
    """'12', '12.5 m', '12;14', '40 ft' -> float metres"""
    if v is None:
        return default
    s = str(v).split(";")[0].strip().lower().replace(",", ".")
    ft = s.endswith("ft") or s.endswith("'")
    s = s.rstrip("m'ft ").strip()
    try:
        x = float(s)
    except ValueError:
        return default
    return x * 0.3048 if ft else x


def colour(v):
    """OSM colour tag -> (r, g, b) or None"""
    if not v:
        return None
    v = v.strip().lower().split(";")[0]
    named = {
        "white": (238, 236, 230), "black": (40, 40, 42), "grey": (150, 150, 150), "gray": (150, 150, 150),
        "darkgrey": (90, 90, 92), "darkgray": (90, 90, 92), "lightgrey": (200, 200, 198), "lightgray": (200, 200, 198),
        "silver": (190, 192, 196), "red": (176, 64, 50), "darkred": (120, 40, 34), "brown": (130, 90, 60),
        "beige": (222, 205, 170), "cream": (238, 228, 200), "yellow": (226, 196, 90), "orange": (220, 130, 60),
        "blue": (70, 110, 170), "lightblue": (150, 185, 215), "darkblue": (40, 60, 100), "green": (90, 140, 80),
        "darkgreen": (50, 85, 50), "pink": (225, 170, 170), "tan": (205, 175, 130), "sand": (215, 195, 150),
        "ivory": (240, 236, 220), "maroon": (110, 40, 40), "gold": (205, 170, 70), "terracotta": (190, 100, 70),
        "teal": (60, 130, 130), "turquoise": (80, 180, 175), "purple": (120, 80, 140), "olive": (120, 120, 60),
    }
    if v in named:
        return named[v]
    if v.startswith("#"):
        h = v[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        try:
            return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            return None
    return None
