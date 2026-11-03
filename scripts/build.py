"""OSM + Copernicus DSM -> a 1 m voxel diorama, written as streamable tiles to web/public/data/<city>/.

usage: uv run python scripts/build.py tlv            (after scripts/fetch.py tlv)

Pipeline:
 1. frame: UTM 36N around the centre, rotated to the dominant direction of the building walls
 2. 2D layers at 1 m: ground height, surface class, building bodies (bottom, top, roof profile, colours)
 3. building heights: OSM height / levels where tagged; elsewhere fitted from the DSM excess over the ground,
    the footprint and the tagged neighbours (calibrated on the tagged buildings, logged to report.json)
 4. objects as sparse voxels: trees, palms, lamps, rooftop solar heaters, cranes, beach umbrellas, bridges
 5. tiles (tiles.py): every 128 x 128 m node at 1 m, and 2, 4, 8 m levels downsampled from them
"""
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
import shapely
from rasterio import features as rf
from rasterio.transform import Affine
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely import LineString, Point, Polygon, box
from shapely.ops import polygonize, unary_union

import osm
import tiles
from cities import CITIES, FLOOR
from palette import Palette, hexrgb, mix, shade
from trees import Sprites

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
T0 = time.time()
REPORT = {}


def log(msg):
    print(f"[{time.time() - T0:6.1f}s] {msg}", flush=True)


def h32(*xs):
    """deterministic hash -> 0..1"""
    v = 2166136261
    for x in xs:
        for b in str(x).encode():
            v = ((v ^ b) * 16777619) & 0xFFFFFFFF
    return v / 2 ** 32


# ---------------------------------------------------------------- surface classes

SURF = {  # name: (colour, material)
    "urban": ((200, 192, 176), "plain"),
    "yard": ((170, 168, 120), "plain"),
    "sand": ((234, 216, 172), "plain"),
    "seabed": ((206, 190, 150), "plain"),
    "grass": ((128, 170, 82), "plain"),
    "park": ((116, 160, 74), "plain"),
    "wood": ((98, 132, 66), "plain"),
    "scrub": ((156, 154, 98), "plain"),
    "farmland": ((182, 164, 108), "plain"),
    "field": ((150, 162, 88), "plain"),
    "orchard": ((132, 132, 84), "plain"),
    "pitch": ((92, 156, 80), "plain"),
    "track": ((188, 94, 72), "plain"),
    "court": ((78, 126, 150), "plain"),
    "parking": ((128, 128, 130), "plain"),
    "plaza": ((216, 208, 192), "plain"),
    "sidewalk": ((190, 188, 182), "plain"),
    "footway": ((208, 200, 184), "plain"),
    "cycleway": ((170, 98, 86), "plain"),
    "road": ((84, 86, 90), "plain"),
    "major": ((74, 76, 80), "plain"),
    "motorway": ((66, 68, 72), "plain"),
    "mark": ((236, 234, 226), "plain"),
    "rail": ((126, 114, 102), "plain"),
    "steel": ((88, 84, 82), "plain"),
    "tram": ((150, 150, 148), "plain"),
    "construction": ((184, 152, 112), "plain"),
    "bare": ((200, 180, 140), "plain"),
    "rock": ((150, 146, 138), "plain"),
    "deck": ((150, 116, 84), "plain"),
    "cemetery": ((146, 152, 112), "plain"),
    "industrial": ((178, 176, 170), "plain"),
    "water": ((88, 146, 168), "water"),
    "pool": ((90, 200, 214), "water"),
    "platform": ((176, 172, 164), "plain"),
}
SURF_ID = {k: i + 1 for i, k in enumerate(SURF)}

SOIL, DEEP = (164, 128, 92), (128, 100, 76)

ROAD_W = {"motorway": 11, "trunk": 10, "primary": 12, "secondary": 10, "tertiary": 8.5, "unclassified": 7,
          "residential": 6.5, "living_street": 5, "service": 3.5, "motorway_link": 6, "trunk_link": 6,
          "primary_link": 6, "secondary_link": 6, "tertiary_link": 6, "busway": 7, "road": 6,
          "pedestrian": 6, "footway": 2.2, "path": 2, "cycleway": 2, "steps": 2, "track": 3, "bridleway": 2}
CAR = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
       "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "busway", "road"}
STREET_TREES = {"secondary", "tertiary", "unclassified", "residential", "living_street"}


def road_width(t):
    hw = t.get("highway")
    w = osm.number(t.get("width"))
    if w and 1 <= w <= 40:
        return w
    lanes = osm.number(t.get("lanes"))
    if lanes and hw in CAR:
        return lanes * 3.2 + 1
    w = ROAD_W.get(hw, 0)
    if t.get("oneway") == "yes" and hw in ("primary", "secondary", "tertiary", "trunk"):
        w *= 0.65
    if hw == "service" and t.get("service") == "parking_aisle":
        w = 5
    return w


def surface_class(t):
    lu, le, na, am = t.get("landuse"), t.get("leisure"), t.get("natural"), t.get("amenity")
    if t.get("water") in ("pool", "swimming_pool") or le == "swimming_pool":
        return "pool"
    if na == "water" or lu in ("reservoir", "basin") or t.get("waterway") in ("riverbank", "dock"):
        return "water"
    if na in ("beach", "sand"):
        return "sand"
    if le in ("pitch",):
        return "court" if t.get("surface") in ("asphalt", "concrete", "acrylic", "tartan") or t.get("sport") in ("tennis", "basketball", "padel") else "pitch"
    if le == "track":
        return "track"
    if le in ("park", "garden", "dog_park") or lu in ("village_green", "recreation_ground"):
        return "park"
    if lu in ("grass", "meadow", "flowerbed") or na in ("grassland",) or le in ("golf_course",):
        return "grass"
    if le == "playground":
        return "sand"
    if lu in ("forest",) or na == "wood":
        return "wood"
    if na in ("scrub", "heath"):
        return "scrub"
    if lu in ("orchard", "vineyard", "plant_nursery"):
        return "orchard"
    if lu in ("farmland", "farmyard", "greenhouse_horticulture"):
        return "field" if lu == "farmland" else "farmland"
    if lu == "cemetery" or am == "grave_yard":
        return "cemetery"
    if lu in ("construction", "brownfield", "greenfield"):
        return "construction"
    if na in ("bare_rock", "rock", "shingle"):
        return "rock"
    if lu in ("industrial", "railway", "garages", "depot") or am in ("fuel", "bus_station"):
        return "industrial"
    if am in ("parking", "parking_space") or t.get("parking"):
        return "parking"
    if t.get("place") == "square" or t.get("highway") == "pedestrian" or t.get("area:highway") in ("pedestrian", "footway"):
        return "plaza"
    if t.get("area:highway") in ("primary", "secondary", "tertiary", "residential", "unclassified", "service"):
        return "road"
    if t.get("railway") == "platform" or t.get("public_transport") == "platform":
        return "platform"
    if t.get("man_made") in ("pier", "breakwater", "groyne"):
        return "deck" if t.get("man_made") == "pier" else "rock"
    if t.get("leisure") in ("sports_centre", "stadium", "marina"):
        return "plaza"
    return None


SURF_ORDER = ["industrial", "farmland", "field", "orchard", "construction", "cemetery", "grass", "park", "scrub",
              "wood", "sand", "rock", "plaza", "parking", "pitch", "court", "track", "platform", "water", "pool", "deck"]


# ---------------------------------------------------------------- frame

def grid_angle(feats):
    """the dominant wall direction, degrees in (-45, 45], from building edges weighted by length"""
    hist = np.zeros(90)
    for f in feats:
        if "building" not in f["tags"] or not isinstance(f["geom"], Polygon):
            continue
        c = np.asarray(f["geom"].exterior.coords)
        d = np.diff(c, axis=0)
        L = np.hypot(d[:, 0], d[:, 1])
        a = np.degrees(np.arctan2(d[:, 0], -d[:, 1])) % 90  # bearing of the edge, x east, y south at theta 0
        np.add.at(hist, a.astype(int) % 90, L)
    sm = ndimage.gaussian_filter1d(hist, 2, mode="wrap")
    a = float(np.argmax(sm)) + 0.5
    return a - 90 if a > 45 else a


def rotate(frame, feats, theta):
    """features parsed at theta 0 -> the rotated frame, in place"""
    c, s, W, D = math.cos(math.radians(theta)), math.sin(math.radians(theta)), frame.W, frame.D
    m = [c, s, -s, c, W / 2 - c * W / 2 - s * D / 2, D / 2 + s * W / 2 - c * D / 2]
    gs = shapely.affinity.affine_transform  # noqa: F841 (kept for readability below)
    for f in feats:
        f["geom"] = shapely.affinity.affine_transform(f["geom"], m)
    frame.set_theta(theta)


# ---------------------------------------------------------------- rasters

def raster(shapes, D, W, fill=0, dtype=np.uint16, all_touched=False):
    shapes = [(g, v) for g, v in shapes if g is not None and not g.is_empty]
    if not shapes:
        return np.full((D, W), fill, dtype)
    return rf.rasterize(shapes, out_shape=(D, W), transform=Affine.identity(), fill=fill, dtype=dtype,
                        all_touched=all_touched)


def value_noise(D, W, cell, seed):
    rng = np.random.default_rng(seed)
    n = rng.random((D // cell + 2, W // cell + 2)).astype(np.float32)
    n = ndimage.zoom(n, cell, order=1)
    return n[:D, :W]


def sample_dem(frame, step=5):
    """Copernicus GLO-30 (a surface model: roofs and canopy included) sampled bilinearly on a `step` m grid"""
    D, W = frame.D, frame.W
    ys, xs = np.mgrid[0:D:step, 0:W:step].astype(float)
    lon, lat = frame.lonlat(xs + 0.5, ys + 0.5)
    out = np.full(xs.shape, np.nan, np.float32)
    for f in sorted(RAW.glob("Copernicus_DSM_COG_10_*.tif")):
        with rasterio.open(f) as ds:
            t = ds.transform
            col = (lon - t.c) / t.a - 0.5
            row = (lat - t.f) / t.e - 0.5
            inside = (col >= 0) & (col < ds.width - 1) & (row >= 0) & (row < ds.height - 1)
            if not inside.any():
                continue
            a = ds.read(1).astype(np.float32)
            out[inside] = ndimage.map_coordinates(a, [row[inside], col[inside]], order=1)
    if np.isnan(out).any():
        raise RuntimeError("DEM tiles do not cover the city: run scripts/fetch.py")
    return out


# ---------------------------------------------------------------- the build

class City:
    def __init__(self, key):
        self.key = key
        self.c = CITIES[key]
        self.out = ROOT / "web" / "public" / "data" / key
        self.pal = Palette()
        self.rng = np.random.default_rng(1)
        self.obj = [[], [], [], []]  # x, y, z (absolute voxel), palette
        self.labels = []

    def put(self, x, y, z, p):
        n = np.broadcast(np.asarray(x), np.asarray(y), np.asarray(z), np.asarray(p)).shape
        for i, a in enumerate((x, y, z, p)):
            self.obj[i].append(np.broadcast_to(np.asarray(a, np.int64), n).ravel())

    # ---- 1
    def load(self):
        c = self.c
        self.frame = osm.Frame(c["center"], c["W"], c["D"], 0.0)
        els = osm.load(RAW / f"{self.key}_osm.json")
        log(f"osm: {len(els)} elements")
        feats = osm.features(self.frame, els)
        theta = c["theta"] if c["theta"] is not None else grid_angle(feats)
        rotate(self.frame, feats, theta)
        log(f"frame: theta {theta:.1f} deg, {c['W']} x {c['D']} m")
        aoi = box(-60, -60, c["W"] + 60, c["D"] + 60)
        tree = shapely.STRtree([f["geom"] for f in feats])
        keep = tree.query(aoi, predicate="intersects")
        self.feats = [feats[i] for i in sorted(keep)]
        self.node_xy = {}
        for el in els:
            if el["type"] == "node":
                self.node_xy[el["id"]] = (el["lon"], el["lat"])
        log(f"osm: {len(self.feats)} features on the map")
        REPORT["theta"] = theta

    # ---- 2a terrain
    def terrain(self):
        W, D = self.c["W"], self.c["D"]
        step = 5
        dsm = sample_dem(self.frame, step)
        self.dsm5 = dsm
        fr = [f for f in self.feats if "building" in f["tags"] and not isinstance(f["geom"], (Point, LineString))]
        bm = raster([(f["geom"], 1) for f in fr], D, W, dtype=np.uint8)
        self.bmask = bm
        frac = bm[:D // step * step, :W // step * step].reshape(D // step, step, W // step, step).mean((1, 3))
        frac = np.pad(frac, ((0, dsm.shape[0] - frac.shape[0]), (0, dsm.shape[1] - frac.shape[1])), mode="edge")
        # the ground: the DSM where no building stands, then the lowest within ~150 m (trees and the blur of
        # roofs into the streets lift it), smoothed
        free = np.where(frac < 0.05, dsm, np.inf)
        g = ndimage.minimum_filter(free, size=31)
        bad = ~np.isfinite(g)
        if bad.any():
            idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
            g = g[tuple(idx)]
        g = ndimage.gaussian_filter(ndimage.maximum_filter(g, size=11), 6)  # an opening: hills keep their height
        g = np.minimum(g, dsm + 0.5)
        self.ground_m = ndimage.zoom(g, step, order=1)[:D, :W].astype(np.float32)
        self.dsm_m = ndimage.zoom(dsm, step, order=1)[:D, :W].astype(np.float32)
        log(f"terrain: {self.ground_m.min():.1f} .. {self.ground_m.max():.1f} m")

    # ---- 2b sea
    def sea(self):
        W, D = self.c["W"], self.c["D"]
        self.sea_mask = np.zeros((D, W), bool)
        if not self.c["sea"]:
            return
        lines = [f["geom"] for f in self.feats if f["tags"].get("natural") == "coastline" and isinstance(f["geom"], LineString)]
        frame = box(-50, -50, W + 50, D + 50)
        merged = unary_union(lines + [frame.exterior])
        polys = list(polygonize(merged))
        polys = [p for p in polys if p.within(frame.buffer(1))]
        votes = np.zeros(len(polys))
        tree = shapely.STRtree(polys)
        for ln in lines:
            cs = np.asarray(ln.coords)
            for a, b in zip(cs[:-1], cs[1:]):
                d = b - a
                L = np.hypot(*d)
                if L < 1:
                    continue
                # OSM coastlines have the land on the left: with y down, the right of travel is (-dy, dx)
                m = (a + b) / 2
                for sgn, v in ((1, 1), (-1, -1)):
                    p = Point(m[0] + sgn * -d[1] / L * 1.5, m[1] + sgn * d[0] / L * 1.5)
                    for i in tree.query(p, predicate="within"):
                        votes[i] += v * L
        sea = [p for p, v in zip(polys, votes) if v > 0]
        self.sea_mask = raster([(p, 1) for p in sea], D, W, dtype=np.uint8).astype(bool)
        log(f"sea: {self.sea_mask.mean() * 100:.1f}% of the map")

    # ---- 2c surface
    def surface(self):
        W, D = self.c["W"], self.c["D"]
        shapes = []
        areas = []
        for f in self.feats:
            g = f["geom"]
            if isinstance(g, (Point, LineString)):
                continue
            k = surface_class(f["tags"])
            if k and "building" not in f["tags"]:
                areas.append((SURF_ORDER.index(k), g.area, g, k))
        # by class order, then large under small
        for _, _, g, k in sorted(areas, key=lambda a: (a[0], -a[1])):
            shapes.append((g, SURF_ID[k]))
        # lines: waterways, breakwaters, footways, roads, rails
        sidewalks, paths, roads, rails, water = [], [], [], [], []
        self.bridges, self.street_lines, self.boulevards = [], [], []
        for f in self.feats:
            g, t = f["geom"], f["tags"]
            if not isinstance(g, LineString):
                if t.get("highway") == "pedestrian" and t.get("area") == "yes":
                    pass
                continue
            if t.get("tunnel") in ("yes", "building_passage", "culvert") or t.get("layer", "0").startswith("-") or t.get("location") == "underground":
                continue
            if t.get("waterway") in ("river", "stream", "canal", "drain", "ditch"):
                w = osm.number(t.get("width")) or {"river": 12, "canal": 8, "stream": 3}.get(t["waterway"], 1.5)
                water.append((g.buffer(w / 2, cap_style="flat"), SURF_ID["water"]))
            mm = t.get("man_made")
            if mm in ("breakwater", "groyne", "pier"):
                w = osm.number(t.get("width")) or {"breakwater": 8, "groyne": 5, "pier": 4}[mm]
                shapes.append((g.buffer(w / 2), SURF_ID["deck" if mm == "pier" else "rock"]))
            hw = t.get("highway")
            if hw:
                w = road_width(t)
                if not w:
                    continue
                bridge = t.get("bridge") in ("yes", "viaduct") and g.length > 25
                if bridge:
                    self.bridges.append((g, w, "road", t))
                    continue
                if hw in CAR:
                    roads.append((g, w, hw, t))
                    if hw not in ("motorway", "motorway_link", "trunk", "trunk_link", "service"):
                        sidewalks.append(g.buffer(w / 2 + 3.0))
                    if hw in STREET_TREES or (hw in ("primary", "secondary") and t.get("name", "").startswith("שדרות")):
                        self.street_lines.append((g, w, t))
                    if t.get("name", "").startswith("שדרות") or "Boulevard" in t.get("name:en", ""):
                        self.boulevards.append((g, w))
                else:
                    k = "cycleway" if hw == "cycleway" else "footway"
                    if t.get("footway") == "sidewalk":
                        k = "sidewalk"
                    paths.append((g.buffer(w / 2), SURF_ID[k]))
                    if (t.get("name", "").startswith("שדרות") or "Boulevard" in t.get("name:en", "")) and hw in ("footway", "pedestrian", "path", "cycleway"):
                        self.boulevards.append((g, w))
            rw = t.get("railway")
            if rw in ("rail", "light_rail", "tram", "subway", "narrow_gauge") and t.get("tunnel") is None:
                if t.get("bridge") in ("yes", "viaduct") and g.length > 25:
                    self.bridges.append((g, 4.5, "rail", t))
                    continue
                if rw == "subway":
                    continue
                rails.append((g, rw))
        shapes += [(g, SURF_ID["sidewalk"]) for g in sidewalks]
        shapes += paths
        shapes += water
        for g, rw in rails:
            shapes.append((g.buffer(2.4 if rw == "rail" else 3.2, cap_style="flat"), SURF_ID["rail" if rw == "rail" else "tram"]))
        rank = {"service": 0, "living_street": 1, "residential": 2, "unclassified": 2, "tertiary": 3,
                "secondary": 4, "primary": 5, "trunk": 6, "motorway": 7}
        for g, w, hw, t in sorted(roads, key=lambda r: rank.get(r[2].replace("_link", ""), 1)):
            k = "motorway" if hw.startswith(("motorway", "trunk")) else "major" if hw.startswith(("primary", "secondary")) else "road"
            shapes.append((g.buffer(w / 2), SURF_ID[k]))
        for g, rw in rails:  # the rails themselves
            for off in (-0.75, 0.75):
                o = g.offset_curve(off)
                if not o.is_empty:
                    shapes.append((o.buffer(0.45, cap_style="flat"), SURF_ID["steel"]))
        surf = raster(shapes, D, W, fill=SURF_ID["urban"], dtype=np.uint8)
        self.road_lines = roads
        # residential yards: the gaps between the blocks are small gardens
        resid = raster([(f["geom"], 1) for f in self.feats if f["tags"].get("landuse") == "residential"
                        and not isinstance(f["geom"], (Point, LineString))], D, W, dtype=np.uint8)
        n = value_noise(D, W, 7, 3)
        yard = (surf == SURF_ID["urban"]) & (resid > 0) & (n > 0.58)
        surf[yard] = SURF_ID["yard"]
        surf[self.sea_mask] = SURF_ID["seabed"]
        self.surf = surf
        self.markings(roads)
        log("surface: " + ", ".join(f"{k} {np.mean(surf == v) * 100:.1f}%" for k, v in SURF_ID.items() if np.mean(surf == v) > 0.01))

    def markings(self, roads):
        """dashed centre lines and zebra crossings (Israeli zebras are everywhere)"""
        D, W = self.surf.shape
        mk = SURF_ID["mark"]
        xs, ys = [], []
        for g, w, hw, t in roads:
            if hw not in ("primary", "secondary", "tertiary", "trunk") or t.get("oneway") == "yes":
                continue
            L = g.length
            s = np.arange(0, L, 0.5)
            s = s[(s % 8) < 3.5]
            p = shapely.line_interpolate_point(g, s)
            c = shapely.get_coordinates(p)
            xs.append(c[:, 0]); ys.append(c[:, 1])
        # zebras: crossing nodes on a car road, stripes along the road, alternating across it
        way_of = {}
        for g, w, hw, t in roads:
            pass
        crossings = [f for f in self.feats if isinstance(f["geom"], Point) and f["tags"].get("highway") == "crossing"
                     and f["tags"].get("crossing") not in ("unmarked", "no")]
        lines = [r[0] for r in roads]
        if lines and crossings:
            tree = shapely.STRtree(lines)
            for f in crossings:
                p = f["geom"]
                i = tree.nearest(p)
                g, w = roads[i][0], roads[i][1]
                if g.distance(p) > 2:
                    continue
                s = g.project(p)
                a, b = g.interpolate(max(0, s - 1)), g.interpolate(min(g.length, s + 1))
                d = np.array([b.x - a.x, b.y - a.y])
                if np.hypot(*d) < 0.1:
                    continue
                d /= np.hypot(*d)
                nrm = np.array([-d[1], d[0]])
                for u in np.arange(-w / 2 + 0.5, w / 2, 0.25):
                    if int(np.floor((u + w) / 1.0)) % 2:
                        continue
                    for v in np.arange(-1.5, 1.6, 0.5):
                        q = np.array([p.x, p.y]) + nrm * u + d * v
                        xs.append([q[0]]); ys.append([q[1]])
        if xs:
            x = np.concatenate(xs).astype(int); y = np.concatenate(ys).astype(int)
            ok = (x >= 0) & (x < W) & (y >= 0) & (y < D)
            x, y = x[ok], y[ok]
            road = np.isin(self.surf[y, x], [SURF_ID["road"], SURF_ID["major"], SURF_ID["motorway"]])
            self.surf[y[road], x[road]] = mk

    # ---- 3 buildings
    def buildings(self):
        W, D = self.c["W"], self.c["D"]
        bl, parts = [], []
        for f in self.feats:
            t, g = f["tags"], f["geom"]
            if isinstance(g, (Point, LineString)) or g.area < 4:
                continue
            if "building:part" in t and t["building:part"] != "no":
                parts.append(f)
            elif "building" in t and t["building"] not in ("no", "ruins", "demolished") and (
                    t["building"] != "construction" or osm.number(t.get("height")) or t.get("building:levels")):
                if t.get("location") == "underground" or t.get("layer", "0").startswith("-"):
                    continue
                bl.append(f)
        log(f"buildings: {len(bl)} outlines, {len(parts)} parts")
        allb = bl + parts
        nb = len(allb)
        # outlines first (large under small), then parts on top of them
        # parts by height, so where parts are stacked (a tower mapped floor-band by floor-band) the cell belongs to
        # the top one; bodies() then spans the whole stack
        ph = lambda f: osm.number(f["tags"].get("height")) or (osm.number(f["tags"].get("building:levels")) or 0) * FLOOR  # noqa: E731
        order = (sorted(range(len(bl)), key=lambda i: -bl[i]["geom"].area)
                 + sorted(range(len(bl), nb), key=lambda i: ph(allb[i])))
        bid = raster([(allb[i]["geom"], i + 1) for i in order], D, W, dtype=np.int32)
        self.bid, self.blist = bid, allb
        # per-building cells
        flat = bid.ravel()
        idx = np.flatnonzero(flat)
        lab = flat[idx]
        srt = np.argsort(lab, kind="stable")
        idx, lab = idx[srt], lab[srt]
        cuts = np.flatnonzero(np.diff(lab)) + 1
        groups = np.split(idx, cuts)
        heads = lab[np.r_[0, cuts]] if len(lab) else []
        cells = {int(h) - 1: g for h, g in zip(heads, groups)}
        self.cells = cells
        g1 = self.ground_m.ravel()
        dsm = self.dsm_m.ravel()
        info = []
        for i, f in enumerate(allb):
            t = f["tags"]
            cl = cells.get(i)
            area = len(cl) if cl is not None else 0
            gm = float(np.median(g1[cl])) if area else 0.0
            ex = float(np.percentile(dsm[cl], 90) - gm) if area else 0.0
            h, minh, src = self.tag_height(t)
            info.append(dict(h=h, minh=minh, src=src, area=area, ground=gm, excess=ex,
                             part=i >= len(bl), cx=f["geom"].centroid.x, cy=f["geom"].centroid.y))
        self.fit_heights(info, allb)
        self.binfo = info

    @staticmethod
    def tag_height(t):
        h = osm.number(t.get("height"))
        lv = osm.number(t.get("building:levels"))
        rl = osm.number(t.get("roof:levels")) or 0
        minh = osm.number(t.get("min_height"))
        if minh is None and t.get("building:min_level"):
            minh = (osm.number(t.get("building:min_level")) or 0) * FLOOR
        src = None
        if h and 1 < h < 500:
            src = "height"
        elif lv is not None and 0 < lv < 120:
            h = lv * FLOOR + rl * FLOOR * 0.7 + 1.0
            src = "levels"
        else:
            h = None
        return h, minh or 0.0, src

    def fit_heights(self, info, feats):
        """untagged buildings: log h ~ DSM excess, footprint and the tagged neighbours (fitted on the tagged)"""
        tagged = [i for i, b in enumerate(info) if b["src"] and not b["part"] and b["area"] >= 30]
        REPORT["tagged_outlines"] = len(tagged)
        REPORT["outlines"] = sum(1 for b in info if not b["part"])
        if len(tagged) < 30:
            log("heights: too few tagged buildings to fit, using a flat 4 storeys")
            coef, nbm = None, None
        pts = np.array([[info[i]["cx"], info[i]["cy"]] for i in tagged])
        logh = np.log(np.array([info[i]["h"] for i in tagged]))
        kd = cKDTree(pts)
        gmed = float(np.median(logh))

        def neighbours(x, y, self_i=None):
            d, j = kd.query([x, y], k=13, distance_upper_bound=250)
            j = [int(a) for a, dd in zip(np.atleast_1d(j), np.atleast_1d(d)) if np.isfinite(dd) and (self_i is None or tagged[int(a)] != self_i)]
            return float(np.median(logh[j[:12]])) if len(j) >= 3 else gmed

        def feats_of(b, nb):
            return [1.0, math.log(max(b["excess"], 0.5)), math.log(max(b["area"], 10)), nb]

        X = np.array([feats_of(info[i], neighbours(info[i]["cx"], info[i]["cy"], i)) for i in tagged])
        coef, *_ = np.linalg.lstsq(X, logh, rcond=None)
        pred = X @ coef
        err_floors = np.abs(np.exp(pred) - np.exp(logh)) / FLOOR
        ss = 1 - np.sum((pred - logh) ** 2) / np.sum((logh - logh.mean()) ** 2)
        REPORT["height_fit"] = dict(coef=[round(float(c), 3) for c in coef], r2_log=round(float(ss), 3),
                                    median_abs_err_floors=round(float(np.median(err_floors)), 2),
                                    p90_abs_err_floors=round(float(np.percentile(err_floors, 90)), 2))
        log(f"heights: fit on {len(tagged)} tagged outlines, R2(log) {ss:.2f}, median error "
            f"{np.median(err_floors):.2f} floors")
        n_est = 0
        for i, b in enumerate(info):
            t = feats[i]["tags"]
            if b["src"]:
                continue
            if b["part"]:
                b["h"] = None  # an untagged part takes its outline's height (below)
                continue
            kind = t.get("building", "yes")
            if kind in ("roof", "carport"):
                b["h"], b["minh"] = 3.6, 2.8
            elif kind in ("shed", "garage", "garages", "kiosk", "hut", "container", "toilets", "cabin", "service",
                          "transformer_tower", "guardhouse", "greenhouse") or b["area"] < 25:
                b["h"] = 3.0 if kind != "greenhouse" else 4.0
            else:
                lp = float(np.array(feats_of(b, neighbours(b["cx"], b["cy"]))) @ coef)
                h = math.exp(lp)
                if kind == "house":
                    h = min(h, 2 * FLOOR + 1)
                lv = int(np.clip(round((h - 1.0) / FLOOR), 1, 70))
                b["h"] = lv * FLOOR + 1.0
            b["src"] = "estimated"
            n_est += 1
        REPORT["estimated_outlines"] = n_est

    def bodies(self):
        """2D layers of the building bodies: lo/hi (voxel z), wall and roof palette, roof profile"""
        W, D = self.c["W"], self.c["D"]
        bid, info, feats = self.bid, self.binfo, self.blist
        self.base = int(math.floor(min(self.ground_m.min(), 0 if self.c["sea"] else 1e9))) - (7 if self.c["sea"] else 3)
        self.sea_z = -self.base  # z of the first voxel above sea level
        gz = np.round(self.ground_m - self.base).astype(np.int32)
        self.gz = gz
        lo = np.zeros((D, W), np.int32)
        hi = np.zeros((D, W), np.int32)
        wpal = np.zeros((D, W), np.int32)
        rpal = np.zeros((D, W), np.int32)
        radd = np.zeros((D, W), np.int32)
        # outlines that hold parts: untagged parts take the outline height, untagged outlines the lowest part
        ptree_idx = [i for i, b in enumerate(info) if b["part"]]
        if ptree_idx:
            ptree = shapely.STRtree([feats[i]["geom"].representative_point() for i in ptree_idx])
        self.has_parts = set()
        for i, b in enumerate(info):
            if b["part"] or not ptree_idx:
                continue
            inside = ptree.query(feats[i]["geom"], predicate="contains")
            if len(inside):
                self.has_parts.add(i)
                ph = [info[ptree_idx[j]]["h"] for j in inside if info[ptree_idx[j]]["h"]]
                for j in inside:
                    pj = info[ptree_idx[j]]
                    pj["outline"] = i
                    if not pj["h"]:
                        pj["h"] = b["h"]
                        pj["src"] = "outline"
                if b["src"] == "estimated" and ph:
                    b["h"] = min(ph)
        for b in info:
            if b["h"] is None:
                b["h"] = 4 * FLOOR + 1
        self.pilotis = 0
        flat = bid.ravel()
        for i, b in enumerate(info):
            cl = self.cells.get(i)
            if cl is None:
                continue
            t = feats[i]["tags"]
            g0 = int(round(b["ground"] - self.base)) if not b["part"] else int(round(info[b.get("outline", i)]["ground"] - self.base))
            wall, wmat, roof, rshape, rh = self.look(i, b, t)
            top = g0 + max(1, int(round(b["h"] - rh)))
            bot = g0 + int(round(b["minh"])) if b["minh"] > 0.5 else 0
            r, cc = np.divmod(cl, W)
            lo.flat[cl] = bot
            hi.flat[cl] = top
            wpal.flat[cl] = self.pal(wall, wmat)
            rpal.flat[cl] = self.pal(roof)
            b.update(top=top, g0=g0, wall=wall, wmat=wmat)
            if rshape and rh > 0.5:
                # a profile from the distance to the footprint edge: hipped / pyramidal / gabled / dome
                y0, y1, x0, x1 = r.min(), r.max() + 1, cc.min(), cc.max() + 1
                m = np.zeros((y1 - y0 + 2, x1 - x0 + 2), bool)
                m[r - y0 + 1, cc - x0 + 1] = True
                d = ndimage.distance_transform_edt(m)[r - y0 + 1, cc - x0 + 1]
                dm = max(d.max(), 1)
                if rshape in ("dome", "onion"):
                    prof = np.sqrt(np.clip(1 - (1 - d / dm) ** 2, 0, 1))
                else:
                    prof = np.clip(d / dm, 0, 1)
                radd.flat[cl] = np.round(rh * prof).astype(np.int32)
                b["roof"] = "pitched"
            # pilotis: the Bauhaus apartment blocks stand on columns, the ground floor open
            if (self.key == "tlv" and not b["part"] and t.get("building") in ("yes", "apartments", "residential")
                    and 3 <= (b["h"] - 1) / FLOOR <= 5 and 120 <= b["area"] <= 700 and h32(i, "pil") < 0.3
                    and bot == 0 and i not in self.has_parts):
                cy, cx = r.mean(), cc.mean()
                core = (np.abs(r - cy) < 2.5) & (np.abs(cc - cx) < 3.5)
                col = ((r % 4) == 0) & ((cc % 4) == 0)
                open_ = ~(core | col)
                lo.flat[cl[open_]] = g0 + 3
                self.pilotis += 1
        # stacked parts: each cell spans from the lowest part under it to the highest (the raster above kept one)
        plo = np.full((D, W), np.iinfo(np.int32).max, np.int32)
        phi = np.zeros((D, W), np.int32)
        for i, b in enumerate(info):
            if not b["part"] or "top" not in b:
                continue
            g = feats[i]["geom"]
            x0, y0, x1, y1 = (int(math.floor(v)) for v in g.bounds)
            x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1 + 1, W), min(y1 + 1, D)
            if x1 <= x0 or y1 <= y0:
                continue
            m = rf.rasterize([(g, 1)], out_shape=(y1 - y0, x1 - x0), transform=Affine.translation(x0, y0), dtype=np.uint8).astype(bool)
            bot = b["g0"] + int(round(b["minh"])) if b["minh"] > 0.5 else 0
            sl = (slice(y0, y1), slice(x0, x1))
            plo[sl] = np.where(m, np.minimum(plo[sl], bot), plo[sl])
            phi[sl] = np.where(m, np.maximum(phi[sl], b["top"]), phi[sl])
        stacked = phi > 0
        lo[stacked] = plo[stacked]
        hi[stacked] = np.maximum(hi[stacked], phi[stacked])
        self.lo, self.hi, self.wpal, self.rpal, self.radd = lo, hi, wpal, rpal, radd
        # building edges: flat roofs get a parapet in the wall colour; the roof colour shows only inside
        edge = np.zeros((D, W), bool)
        b = bid
        edge[:-1] |= b[:-1] != b[1:]; edge[1:] |= b[1:] != b[:-1]
        edge[:, :-1] |= b[:, :-1] != b[:, 1:]; edge[:, 1:] |= b[:, 1:] != b[:, :-1]
        edge &= b > 0
        self.edge = edge
        log(f"bodies: base {self.base} m, top {int((hi + radd).max()) + self.base} m a.s.l., {self.pilotis} on pilotis")

    def look(self, i, b, t):
        """wall colour and material, roof colour, roof shape and height for one building"""
        hh = lambda tag: h32(i, tag)  # noqa: E731
        kind = t.get("building") or t.get("building:part") or "yes"
        mat = (t.get("building:material") or t.get("building:facade:material") or "").lower()
        col = osm.colour(t.get("building:colour") or t.get("colour"))
        rcol = osm.colour(t.get("roof:colour"))
        rshape = t.get("roof:shape")
        rshape = rshape if rshape in ("gabled", "hipped", "pyramidal", "dome", "onion", "half-hipped", "gambrel",
                                      "mansard", "round", "cone") else None
        rh = osm.number(t.get("roof:height")) or 0
        if rshape and not rh:
            rh = min(6.0, max(1.5, math.sqrt(max(b["area"], 1)) * (0.5 if rshape in ("dome", "onion", "cone") else 0.3)))
        H = b["h"]
        cx, cy = b["cx"], b["cy"]
        old_jaffa = self.key == "tlv" and self.in_zone(cx, cy, "jaffa")
        wmat = "facade"
        if mat in ("glass", "mirror"):
            wmat = "glass"
        elif mat in ("stone", "sandstone", "limestone", "brick", "masonry"):
            wmat = "stone"
        elif kind in ("industrial", "warehouse", "garage", "garages", "shed", "roof", "carport", "hangar",
                      "service", "transformer_tower", "container", "parking", "kiosk", "hut"):
            wmat = "plain"
        elif kind == "greenhouse":
            wmat = "window"
        if kind == "construction":
            return (172, 170, 164), "site", (150, 148, 144), None, 0
        office = kind in ("office", "commercial", "hotel") or t.get("office")
        if wmat == "facade" and not mat and (H >= 80 or (H >= 45 and office)):
            wmat = "glass"
            col = mix(col, (110, 140, 160), 0.55) if col else None
        if col is None:
            if wmat == "window":
                col = (214, 224, 218)
            elif wmat == "plain":
                col = [(186, 184, 178), (204, 198, 186), (168, 168, 166), (214, 210, 200)][int(hh("w") * 4)]
            elif H >= 45 or wmat == "glass":
                if wmat != "glass" and hh("tw") < 0.25:
                    col = [(232, 230, 222), (218, 210, 192)][int(hh("t2") * 2)]
                    wmat = "facade"
                else:
                    wmat = "glass"
                    col = [(118, 148, 168), (96, 126, 148), (150, 168, 178), (106, 138, 138), (172, 182, 188),
                           (86, 104, 124), (130, 160, 176)][int(hh("w") * 7)]
            elif old_jaffa or t.get("historic") or wmat == "stone":
                wmat = "stone"
                col = [(214, 190, 150), (200, 176, 138), (226, 206, 170), (190, 168, 132)][int(hh("w") * 4)]
            elif t.get("building:architecture", "").lower() in ("bauhaus", "international_style", "modern"):
                col = (242, 240, 232)
            else:
                pal = ([((236, 233, 224), 30), ((232, 222, 198), 20), ((214, 212, 204), 14), ((230, 214, 170), 8),
                        ((220, 206, 176), 12), ((232, 206, 182), 5), ((190, 190, 186), 11)] if self.key == "tlv" else
                       [((218, 202, 168), 34), ((236, 233, 224), 28), ((232, 222, 198), 20), ((196, 194, 188), 10),
                        ((226, 210, 180), 8)])
                tot = sum(w for _, w in pal)
                u = hh("w") * tot
                for c, w in pal:
                    u -= w
                    if u <= 0:
                        col = c
                        break
                col = col or pal[0][0]
        if rcol is None:
            if rshape in ("gabled", "hipped", "half-hipped", "gambrel", "mansard", "pyramidal"):
                rcol = [(184, 92, 66), (170, 82, 60), (196, 108, 76)][int(hh("r") * 3)]
            elif rshape in ("dome", "onion", "round", "cone"):
                rcol = shade(col, 0.95)
            elif wmat == "window":
                rcol = (220, 228, 224)
            else:
                u = hh("r")
                rcol = ((228, 226, 220) if u < 0.2 else (112, 110, 108) if u < 0.32 else
                        [(182, 180, 174), (196, 192, 184), (166, 164, 160)][int(hh("r2") * 3)])
        return col, wmat, rcol, rshape, rh

    def in_zone(self, x, y, name):
        if not hasattr(self, "_zones"):
            self._zones = {}
            if self.key == "tlv":
                lonlat = {"jaffa": (34.7525, 32.0535, 420)}  # Old Jaffa and the port
                for k, (lon, lat, r) in lonlat.items():
                    zx, zy = self.frame.xy([lon], [lat])
                    self._zones[k] = (float(zx[0]), float(zy[0]), r)
        z = self._zones.get(name)
        return z is not None and math.hypot(x - z[0], y - z[1]) < z[2]

    # ---- 4 objects
    def roof_details(self):
        """parapets, stair rooms, solar water heaters (a dud shemesh on every roof), aviation lights"""
        W = self.c["W"]
        info, feats = self.binfo, self.blist
        panel = self.pal((78, 98, 128))
        tank = self.pal((236, 236, 232))
        beacon = self.pal((255, 40, 30), "beacon")
        n_sol = 0
        edge = self.edge
        for i, b in enumerate(info):
            cl = self.cells.get(i)
            if cl is None or b.get("roof") == "pitched" or i in self.has_parts:
                continue
            H = b["h"]
            r, c = np.divmod(cl, W)
            top = self.hi.flat[cl]
            e = edge.flat[cl]
            wall = self.pal(b["wall"], b["wmat"])
            if H >= 5 and b["area"] >= 30 and b["wmat"] != "window" and self.aligned(feats[i]["geom"]):
                self.put(c[e], r[e], top[e], self.pal(b["wall"]))  # parapet: plain, the facade's windows stop below it
            if H >= 70:  # the red lights on the corners of a tower
                for k in (np.argmin(r + c), np.argmax(r + c), np.argmin(r - c), np.argmax(r - c)):
                    self.put(c[k], r[k], top[k] + 1, beacon)
            if b["wmat"] in ("plain", "window") or b["area"] < 60 or H < 6:
                continue
            inner = ~e
            if b["area"] > 140:  # the stair and lift room
                cy, cx = np.median(r), np.median(c)
                m = (np.abs(r - cy) <= 1.5) & (np.abs(c - cx) <= 2) & inner
                for dz in range(3 if H < 45 else 5):
                    self.put(c[m], r[m], top[m] + dz, wall)
            if H > 48:
                continue
            # solar water heaters on a 3 m lattice: a tilted panel (one voxel) and the white tank behind it
            k = inner & (r % 3 == 0) & (c % 4 == 0)
            if b["area"] > 140:
                k &= ~((np.abs(r - np.median(r)) <= 2.5) & (np.abs(c - np.median(c)) <= 3))
            sel = np.flatnonzero(k)
            if not len(sel):
                continue
            rng = np.random.default_rng(i)
            sel = sel[rng.random(len(sel)) < (0.75 if feats[i]["tags"].get("building") in ("apartments", "residential", "yes") else 0.25)]
            sel = sel[:max(1, int(b["area"] / 70))]
            inside = set(cl.tolist())
            for j in sel:
                y, x, z = r[j], c[j], top[j]
                ok = all((yy * W + xx) in inside for yy, xx in ((y, x + 1), (y - 1, x), (y - 1, x + 1)))
                if not ok:
                    continue
                self.put([x, x + 1], [y, y], [z, z], panel)
                self.put([x, x + 1], [y - 1, y - 1], [z + 1, z + 1], tank)
                n_sol += 1
        log(f"roofs: {n_sol} solar water heaters")

    @staticmethod
    def aligned(g, tol=7.0):
        """walls within `tol` degrees of the voxel grid: a parapet on any other footprint is a zig-zag"""
        c = np.asarray(shapely.oriented_envelope(g).exterior.coords)
        d = c[1] - c[0]
        a = math.degrees(math.atan2(d[1], d[0])) % 90
        return min(a, 90 - a) < tol

    def trees(self):
        W, D = self.c["W"], self.c["D"]
        sp = Sprites(self.pal)
        self.sprites = sp
        trees = []  # x, y, kind
        surf, bid = self.surf, self.bid
        coast = None
        if self.sea_mask.any():
            coast = ndimage.distance_transform_edt(~self.sea_mask)
        rng = np.random.default_rng(11)
        tlv = self.key == "tlv"

        def street_kind(x, y, street=True):
            u = rng.random()
            if street and coast is not None and 0 <= int(y) < D and 0 <= int(x) < W and coast[int(y), int(x)] < 260:
                return "washingtonia" if u < 0.5 else "phoenix" if u < 0.65 else "ficus"
            if tlv:
                return ("ficus" if u < 0.42 else "poinciana" if u < 0.62 else "jacaranda" if u < 0.78 else
                        "washingtonia" if u < 0.84 else "broadleaf")
            return ("ficus" if u < 0.3 else "jacaranda" if u < 0.45 else "poinciana" if u < 0.55 else
                    "broadleaf" if u < 0.75 else "washingtonia" if u < 0.85 else "eucalyptus" if u < 0.92 else "pine")

        # 1. OSM trees and tree rows
        def osm_kind(t):
            s = (t.get("species", "") + t.get("genus", "") + t.get("taxon", "")).lower()
            if "washingtonia" in s:
                return "washingtonia"
            if "phoenix" in s or "palm" in s or t.get("leaf_type") == "palm":
                return "phoenix"
            if "ficus" in s or "sycomor" in s:
                return "ficus"
            if "delonix" in s:
                return "poinciana"
            if "jacaranda" in s:
                return "jacaranda"
            if "citrus" in s:
                return "citrus"
            if "pinus" in s:
                return "pine"
            if "cupressus" in s:
                return "cypress"
            if "eucalyptus" in s:
                return "eucalyptus"
            if t.get("leaf_type") == "needleleaved":
                return "pine"
            return None

        for f in self.feats:
            t, g = f["tags"], f["geom"]
            if t.get("natural") == "tree" and isinstance(g, Point):
                trees.append((g.x, g.y, osm_kind(t) or street_kind(g.x, g.y), 3))
            elif t.get("natural") == "tree_row" and isinstance(g, LineString):
                k = osm_kind(t) or street_kind(*g.coords[0])
                for s in np.arange(3, g.length, 7):
                    p = g.interpolate(s)
                    trees.append((p.x, p.y, k, 3))
        # 2. street trees along both kerbs, and the double rows of the boulevards
        for g, w, t in self.street_lines:
            if g.length < 20:
                continue
            for side in (-1, 1):
                o = g.offset_curve(side * (w / 2 + 1.3))
                if o.is_empty or o.geom_type != "LineString":
                    continue
                kind = street_kind(*o.coords[0])
                step = 9 if tlv else 11
                for s in np.arange(rng.uniform(2, step), o.length - 4, step):
                    if rng.random() < 0.3:
                        continue
                    p = o.interpolate(s + rng.uniform(-1, 1))
                    trees.append((p.x, p.y, kind if rng.random() < 0.7 else street_kind(p.x, p.y), 1))
        for g, w in self.boulevards:
            for side in (-1, 1):
                o = g.offset_curve(side * (w / 2 + 1.5))
                if o.is_empty or o.geom_type != "LineString":
                    continue
                for s in np.arange(2, o.length - 2, 6.5):
                    p = o.interpolate(s)
                    trees.append((p.x, p.y, "ficus" if rng.random() < 0.7 else "poinciana", 2))
        # 3. parks, woods, groves, yards: scattered by density
        dens = {SURF_ID["park"]: 1 / 110, SURF_ID["grass"]: 1 / 500, SURF_ID["wood"]: 1 / 35,
                SURF_ID["cemetery"]: 1 / 160, SURF_ID["scrub"]: 1 / 90, SURF_ID["yard"]: 1 / 160,
                SURF_ID["orchard"]: 0}
        dmap = np.zeros(256, np.float32)
        for k, v in dens.items():
            dmap[k] = v
        prob = dmap[surf] * (bid == 0)
        u = rng.random((D, W), dtype=np.float32)
        ys, xs = np.nonzero(u < prob)
        for x, y in zip(xs, ys):
            s = surf[y, x]
            if s == SURF_ID["scrub"] or (s == SURF_ID["yard"] and rng.random() < 0.55):
                k = "bush"
            elif s == SURF_ID["wood"]:
                k = "pine" if rng.random() < 0.5 else "eucalyptus" if rng.random() < 0.5 else "broadleaf"
            elif s == SURF_ID["cemetery"]:
                k = "cypress" if rng.random() < 0.6 else "pine"
            else:
                k = street_kind(x, y, False) if rng.random() < 0.7 else ("pine" if not tlv and rng.random() < 0.4 else "broadleaf")
            trees.append((x + 0.5, y + 0.5, k, 0))
        # orchards (the Rehovot citrus groves): rows 5 m apart, a tree every 4 m
        oy, ox = np.nonzero((surf == SURF_ID["orchard"]) & (bid == 0))
        m = (oy % 5 == 0) & (ox % 4 == 0)
        for x, y in zip(ox[m], oy[m]):
            trees.append((x + 0.5, y + 0.5, "citrus", 0))
        # keep one tree per 3 m cell (OSM first), never on a building, a road, rails or water
        bad = np.zeros(256, bool)
        for k in ("road", "major", "motorway", "mark", "rail", "steel", "tram", "water", "pool", "seabed", "pitch",
                  "court", "track", "parking"):
            bad[SURF_ID[k]] = True
        seen = set()
        kept = []
        for x, y, k, pri in sorted(trees, key=lambda t: -t[3]):
            xi, yi = int(x), int(y)
            if not (0 <= xi < W and 0 <= yi < D) or bid[yi, xi] or (bad[surf[yi, xi]] and pri < 3) or self.sea_mask[yi, xi]:
                continue
            cell = (xi // 3, yi // 3) if k not in ("citrus", "bush") else (xi // 2, yi // 2)
            if cell in seen:
                continue
            seen.add(cell)
            kept.append((xi, yi, k))
        counts = {}
        for xi, yi, k in kept:
            counts[k] = counts.get(k, 0) + 1
            dx, dy, dz, p = sp.get(k, int(h32(xi, yi) * 1000))
            self.put(xi + dx, yi + dy, self.gz[yi, xi] + dz, p)
        log(f"trees: {len(kept)} ({', '.join(f'{k} {v}' for k, v in sorted(counts.items(), key=lambda a: -a[1]))})")
        REPORT["trees"] = counts

    def street_lamps(self):
        W, D = self.c["W"], self.c["D"]
        pole, head = self.pal((112, 114, 118)), self.pal((255, 226, 168), "lamp")
        pts = [(f["geom"].x, f["geom"].y) for f in self.feats if isinstance(f["geom"], Point)
               and f["tags"].get("highway") == "street_lamp"]
        for g, w, hw, t in self.road_lines:
            if hw not in CAR or g.length < 25 or hw.startswith("motorway"):
                continue
            for k, side in enumerate((-1, 1)):
                o = g.offset_curve(side * (w / 2 + 0.6))
                if o.is_empty or o.geom_type != "LineString":
                    continue
                for s in np.arange(8 + k * 15, o.length - 5, 30):
                    p = o.interpolate(s)
                    pts.append((p.x, p.y))
        self.lamps = []
        for x, y in pts:
            xi, yi = int(x), int(y)
            if not (0 <= xi < W and 0 <= yi < D) or self.bid[yi, xi]:
                continue
            z = self.gz[yi, xi]
            self.put(xi, yi, np.arange(z, z + 6), pole)
            self.put(xi, yi, z + 6, head)
            self.lamps.append((xi, yi, z + 6))
        log(f"lamps: {len(self.lamps)}")

    def beach(self):
        """rows of sunshades on the beaches, and the lifeguard huts on stilts"""
        if not self.sea_mask.any():
            return
        D, W = self.surf.shape
        d = ndimage.distance_transform_edt(~self.sea_mask)
        sand = (self.surf == SURF_ID["sand"]) & (self.bid == 0)
        rng = np.random.default_rng(5)
        cols = [(40, 110, 190), (236, 236, 230), (232, 120, 50), (240, 200, 60), (200, 60, 60), (60, 160, 150)]
        pole = self.pal((240, 240, 236))
        ys, xs = np.nonzero(sand & (d > 14) & (d < 50) & (np.arange(D)[:, None] % 6 == 0) & (np.arange(W)[None, :] % 5 == 0))
        n = 0
        for x, y in zip(xs, ys):
            if rng.random() > 0.35:
                continue
            z = self.gz[y, x]
            c = self.pal(cols[rng.integers(len(cols))])
            self.put(x, y, [z, z + 1], pole)
            dx, dy = np.meshgrid([-1, 0, 1], [-1, 0, 1])
            self.put(x + dx.ravel(), y + dy.ravel(), z + 2, c)
            n += 1
        # lifeguard huts: every ~350 m along the beach, 25 m from the water
        hut, band, stilt = self.pal((244, 244, 240)), self.pal((40, 100, 170)), self.pal((150, 120, 90))
        ys, xs = np.nonzero(sand & (np.abs(d - 25) < 0.6))
        placed = []
        for x, y in zip(xs, ys):
            if any(math.hypot(x - a, y - b) < 350 for a, b in placed):
                continue
            placed.append((x, y))
            z = self.gz[y, x]
            for sx in (-1, 2):
                for sy in (-1, 2):
                    self.put(x + sx, y + sy, np.arange(z, z + 3), stilt)
            gx, gy = np.meshgrid(np.arange(-1, 3), np.arange(-1, 3))
            for dz in range(3):
                self.put(x + gx.ravel(), y + gy.ravel(), z + 3 + dz, band if dz == 1 else hut)
        log(f"beach: {n} sunshades, {len(placed)} lifeguard huts")

    def cranes(self):
        """tower cranes over the construction sites (the Tel Aviv skyline is never without them)"""
        yel, blk, cw = self.pal((232, 184, 40)), self.pal((60, 60, 60)), self.pal((170, 170, 166))
        n = 0
        for f in self.feats:
            t, g = f["tags"], f["geom"]
            if isinstance(g, (Point, LineString)) or g.area < 900:
                continue
            if not (t.get("landuse") == "construction" or t.get("building") == "construction"):
                continue
            for k in range(1 if g.area < 5000 else 2):
                p = g.representative_point() if k == 0 else g.centroid
                x, y = int(p.x) + k * 9, int(p.y)
                if not (0 <= x < self.c["W"] - 2 and 0 <= y < self.c["D"] - 2):
                    continue
                z0 = self.gz[y, x]
                H = int(40 + h32(f["id"], k) * 50) + (60 if self.key == "tlv" and g.area > 4000 else 0)
                zz = np.arange(z0, z0 + H)
                for dx in (0, 1):
                    for dy in (0, 1):
                        self.put(x + dx, y + dy, zz, yel)
                ang = h32(f["id"], "a", k) * 2 * math.pi
                for s in range(-10, 42):
                    jx, jy = x + round(math.cos(ang) * s), y + round(math.sin(ang) * s)
                    self.put(jx, jy, z0 + H, yel)
                    if s < -6:
                        self.put(jx, jy, z0 + H - 1, cw)
                self.put([x, x + 1], [y, y], z0 + H + 1, yel)
                self.put([x, x + 1], [y, y], z0 + H + 2, yel)
                self.put(x, y, z0 + H - 2, blk)
                n += 1
        log(f"cranes: {n}")

    def bridge_decks(self):
        W, D = self.c["W"], self.c["D"]
        top, side, rail = self.pal((86, 88, 92)), self.pal((176, 172, 164)), self.pal((150, 152, 156))
        ballast = self.pal(SURF["rail"][0])
        for g, w, kind, t in self.bridges:
            L = g.length
            poly = g.buffer(w / 2 + 0.5, cap_style="flat")
            mn = poly.bounds
            x0, y0 = max(0, int(mn[0])), max(0, int(mn[1]))
            x1, y1 = min(W, int(mn[2]) + 1), min(D, int(mn[3]) + 1)
            if x1 <= x0 or y1 <= y0:
                continue
            yy, xx = np.mgrid[y0:y1, x0:x1]
            pts = shapely.points(xx.ravel() + 0.5, yy.ravel() + 0.5)
            inside = shapely.contains(poly, pts)
            if not inside.any():
                continue
            pts, xs, ys = pts[inside], xx.ravel()[inside], yy.ravel()[inside]
            s = shapely.line_locate_point(g, pts)
            dist = shapely.distance(g, pts)
            ramp = np.clip(np.minimum(s, L - s) / 35, 0, 1)
            lift = 1 + np.round((5 if L > 60 else 2) * ramp).astype(int)
            gend = np.array([self.gz[min(D - 1, max(0, int(q.y))), min(W - 1, max(0, int(q.x)))] for q in (g.interpolate(0), g.interpolate(L))])
            z = (gend.mean() + lift).astype(int)
            pal = ballast if kind == "rail" else top
            self.put(xs, ys, z, pal)
            self.put(xs, ys, z - 1, side)
            e = dist > w / 2 - 0.3
            self.put(xs[e], ys[e], z[e] + 1, rail)
            # piers every 25 m
            for sp_ in np.arange(20, L - 10, 25):
                p = g.interpolate(sp_)
                px, py = int(p.x), int(p.y)
                if 0 <= px < W and 0 <= py < D:
                    zz = int(gend.mean() + 1 + (5 if L > 60 else 2) * min(1, min(sp_, L - sp_) / 35))
                    self.put(px, py, np.arange(self.gz[py, px], zz - 1), side)
        log(f"bridges: {len(self.bridges)}")

    def fountains(self):
        water, rim = self.pal(SURF["pool"][0], "water"), self.pal((222, 214, 198))
        for f in self.feats:
            t, g = f["tags"], f["geom"]
            if t.get("amenity") != "fountain":
                continue
            c = g if isinstance(g, Point) else g.centroid
            r = 3 if isinstance(g, Point) else max(2, min(12, math.sqrt(g.area / math.pi)))
            x0, y0 = int(c.x), int(c.y)
            R = int(r) + 1
            for dy in range(-R, R + 1):
                for dx in range(-R, R + 1):
                    x, y = x0 + dx, y0 + dy
                    if not (0 <= x < self.c["W"] and 0 <= y < self.c["D"]) or self.bid[y, x]:
                        continue
                    d = math.hypot(dx, dy)
                    if d <= r - 1:
                        self.surf[y, x] = SURF_ID["pool"]
                    elif d <= r:
                        self.put(x, y, self.gz[y, x], rim)

    # ---- 5 labels and camera views
    def make_labels(self):
        W, D = self.c["W"], self.c["D"]
        cand = []
        bidx = {f["id"]: i for i, f in enumerate(self.blist)}
        for f in self.feats:
            t, g = f["tags"], f["geom"]
            name = t.get("name:en") or t.get("name")
            if not name:
                continue
            p = g.representative_point() if not isinstance(g, Point) else g
            if not (20 < p.x < W - 20 and 20 < p.y < D - 20):
                continue
            score = 0
            if t.get("wikidata"):
                score += 3
            if t.get("wikipedia"):
                score += 2
            kind = (t.get("tourism") or t.get("historic") or t.get("amenity") or t.get("leisure") or t.get("place")
                    or t.get("building") or t.get("natural") or t.get("railway") or t.get("landuse") or "")
            if kind in ("museum", "attraction", "monument", "theatre", "place_of_worship", "university", "square",
                        "park", "station", "beach", "marketplace", "clock", "castle", "fort",
                        "arts_centre", "hospital", "college", "neighbourhood", "quarter", "suburb", "garden", "zoo"):
                score += 2
            if "highway" in t or kind in ("yes", "apartments", "house", "bus_stop", "parking", "bench", "restaurant",
                                         "cafe", "fast_food", "bar", "pub", "shop", "atm", "pharmacy", "bank",
                                         "toilets", "kindergarten", "school", "residential", "commercial",
                                         "retail", "construction", "dentist", "doctors", "clinic", "townhall", "fuel",
                                         "bicycle_rental", "car_rental", "ice_cream", "post_office", "police", "grass",
                                         "tree", "pitch", "playground", "fountain", "shelter", "waste_basket",
                                         "drinking_water", "recycling", "charging_station", "library",
                                         "community_centre", "social_facility", "dog_park", "telephone",
                                         "parking_entrance", "vending_machine", "taxi", "car_wash", "nightclub"):
                if not t.get("wikidata"):
                    continue
            if t.get("place") in ("city", "town", "suburb") and not t.get("wikidata"):
                continue
            if kind in ("memorial", "plaque", "stone", "information", "artwork", "bust", "yes") and not t.get("wikipedia"):
                continue
            if score < 3 and t.get("place") not in ("neighbourhood", "quarter", "suburb"):
                continue
            i = bidx.get(f["id"])
            xi, yi = int(p.x), int(p.y)
            z = int(self.hi[yi, xi] + self.radd[yi, xi]) if self.bid[yi, xi] else int(self.gz[yi, xi])
            if i is not None and i in getattr(self, "binfo_top", {}):
                z = self.binfo_top[i]
            if not isinstance(g, (Point, LineString)) and g.area > 200:
                score += min(3, math.log10(g.area) - 2)
            hb = 0
            if self.bid[yi, xi]:
                hb = self.binfo[self.bid[yi, xi] - 1]["h"]
                score += min(3, hb / 40)
            cand.append(dict(name=name, he=t.get("name:he") or t.get("name"), kind=kind, x=round(p.x, 1),
                             y=round(p.y, 1), z=z, score=round(score, 2),
                             height=round(hb) if hb > 30 else None, wikidata=t.get("wikidata"),
                             place=bool(t.get("place"))))
        # one label per name (the highest scoring), then the best 160
        best = {}
        for c in cand:
            k = c["name"]
            if k not in best or c["score"] > best[k]["score"]:
                best[k] = c
        labs = sorted(best.values(), key=lambda c: -c["score"])[:160]
        self.labels = [{k: v for k, v in c.items() if v is not None} for c in labs]
        log(f"labels: {len(self.labels)} (top: {', '.join(c['name'] for c in labs[:8])})")

    def views(self):
        """camera presets: the overview and the best-scoring landmarks, looked at from the south-west"""
        W, D = self.c["W"], self.c["D"]
        v = {"overview": dict(label="Overview", target=[W / 2, 0, D / 2], pos=[W / 2 - W * 0.35, max(W, D) * 0.55, D / 2 + D * 0.7])}
        by_name = {l["name"]: l for l in self.labels}
        for name, dist, ang in self.c.get("views", []):
            names = name.split("|")
            name = names[0]
            lab = next((by_name[n] for n in names if n in by_name), None) or next(
                (l for l in map(self.find_label, names) if l), None)
            if not lab:
                log(f"views: no label '{name}'")
                continue
            a = math.radians(ang)
            key = "".join(ch for ch in name.lower() if ch.isalnum())[:24]
            v[key] = dict(label=name, target=[lab["x"], lab["z"] * 0.5, lab["y"]],
                          pos=[lab["x"] + dist * math.sin(a), lab["z"] * 0.5 + dist * 0.6, lab["y"] - dist * math.cos(a)])
        n = len(v)
        for lab in self.labels:
            if lab.get("place") or n >= 14:
                continue
            z = lab["z"] + self.base
            dist = 180 + min(300, lab["z"] * 1.5)
            key = "".join(ch for ch in lab["name"].lower() if ch.isalnum())[:24]
            if key in v:
                continue
            v[key] = dict(label=lab["name"], target=[lab["x"], lab["z"] * 0.6, lab["y"]],
                          pos=[lab["x"] - dist * 0.6, lab["z"] + dist * 0.55, lab["y"] + dist * 0.8])
            n += 1
        self.view_list = v

    def find_label(self, name):
        """a named feature that did not make the label list (a street, a square): the middle of its longest piece
        on the map (a street is many OSM ways)"""
        frame = box(0, 0, self.c["W"], self.c["D"])
        parts = [f["geom"].intersection(frame) for f in self.feats if name in (f["tags"].get("name:en"), f["tags"].get("name"))]
        parts = [g for p in parts if not p.is_empty for g in getattr(p, "geoms", [p])]
        if not parts:
            return None
        if all(isinstance(g, LineString) for g in parts):
            merged = shapely.line_merge(unary_union(parts))
            g = max(getattr(merged, "geoms", [merged]), key=lambda x: x.length)
            p = g.interpolate(0.5, normalized=True)
        else:
            p = max(parts, key=lambda x: x.area).representative_point()
        x, y = int(np.clip(p.x, 0, self.c["W"] - 1)), int(np.clip(p.y, 0, self.c["D"] - 1))
        return dict(name=name, x=p.x, y=p.y, z=int(self.gz[y, x]))

    # ---- 6 tiles
    def export(self):
        o = self.obj
        ox, oy, oz, op = (np.concatenate(a) if a else np.zeros(0, np.int64) for a in o)
        W, D = self.c["W"], self.c["D"]
        ok = (ox >= 0) & (ox < W) & (oy >= 0) & (oy < D) & (oz >= 0)
        ox, oy, oz, op = ox[ok], oy[ok], oz[ok], op[ok]
        log(f"objects: {len(ox) / 1e6:.1f} M voxels")
        # surface palette: class colour; the sea by depth
        spal_of = np.zeros(256, np.int32)
        for k, i in SURF_ID.items():
            spal_of[i] = self.pal(*SURF[k])
        spal = spal_of[self.surf]
        sea = self.sea_mask
        top_water = np.zeros_like(self.gz)
        wpal_sea = np.zeros_like(self.gz)
        if sea.any():
            dist = ndimage.distance_transform_edt(sea)
            depth = np.clip(np.round(1 + dist / 22), 1, 7).astype(np.int32)
            self.gz[sea] = self.sea_z - depth[sea]
            shallow, deep = (120, 204, 200), (34, 100, 150)
            lv = np.clip(depth - 1, 0, 6)
            seapal = np.array([self.pal(mix(shallow, deep, k / 6), "sea") for k in range(7)], np.int32)
            foam = self.pal((236, 244, 240), "sea")
            wpal_sea = np.where(sea, seapal[lv], 0)
            wpal_sea[sea & (dist <= 1.5)] = foam
            top_water[sea] = self.sea_z
        layers = dict(gz=self.gz, spal=spal, lo=self.lo, hi=np.where(self.bid > 0, self.hi, 0), wpal=self.wpal,
                      rpal=self.rpal, radd=self.radd, edge=self.edge, wtop=top_water, wsea=wpal_sea)
        soil, deep_ = self.pal(SOIL), self.pal(DEEP)
        info = tiles.export(layers, (ox, oy, oz, op), self.out / "tiles", soil, deep_, log)
        return info

    def write_meta(self, tinfo):
        meta = dict(
            city=self.key, name=self.c["name"], name_he=self.c["name_he"], W=self.c["W"], D=self.c["D"],
            H=int(tinfo["H"]), base=self.base, sea_z=self.sea_z if self.c["sea"] else None,
            theta=self.frame.theta, center=list(self.c["center"]), floor=FLOOR,
            tiles=dict(N=tiles.N, levels=tinfo["levels"]),
            palette=[list(e) for e in self.pal.entries],
            lamps=[list(map(int, l)) for l in self.lamps[::1]],
            labels=self.labels, views=self.view_list,
            sources=dict(osm=time.strftime("%Y-%m-%d", time.localtime((RAW / f"{self.key}_osm.json").stat().st_mtime)),
                         dem="Copernicus GLO-30"),
            report=REPORT,
        )
        (self.out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
        log(f"meta: {len(self.pal.entries)} palette entries")


def main(key):
    c = City(key)
    c.load()
    c.terrain()
    c.sea()
    c.surface()
    c.buildings()
    c.bodies()
    c.roof_details()
    c.fountains()
    c.trees()
    c.street_lamps()
    c.beach()
    c.cranes()
    c.bridge_decks()
    c.make_labels()
    c.views()
    c.out.mkdir(parents=True, exist_ok=True)
    tinfo = c.export()
    c.write_meta(tinfo)
    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data" / f"{key}_report.json").write_text(json.dumps(REPORT, indent=1, ensure_ascii=False))
    log("done")


if __name__ == "__main__":
    for k in sys.argv[1:] or list(CITIES):
        REPORT.clear()
        T0 = time.time()
        main(k)
