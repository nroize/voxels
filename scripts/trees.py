"""Voxel sprites for the trees of the coastal plain: (dx, dy, dz, palette) arrays, z up from the ground voxel.

Kinds follow what lines the streets of Tel Aviv and Rehovot: figs, royal poinciana and jacaranda (which flower, see
MAT bloom_* in palette.py), Washingtonia and date palms, citrus in the Rehovot groves, pines, cypresses and eucalyptus.
"""
import numpy as np

from palette import shade

TRUNK = (112, 92, 72)
KINDS = ("ficus", "poinciana", "jacaranda", "broadleaf", "washingtonia", "phoenix", "citrus", "pine", "cypress",
         "eucalyptus", "bush")


def _noise(rng, shape, scale):
    """smooth-ish noise in 0..1 on a small 3D grid"""
    from scipy import ndimage
    n = rng.random(tuple(max(2, s // scale + 2) for s in shape))
    z = [s / (n.shape[i] - 1) * 1.0001 for i, s in enumerate(shape)]
    n = ndimage.zoom(n, [shape[i] / n.shape[i] for i in range(3)], order=1)
    return n[:shape[0], :shape[1], :shape[2]]


def _blob(rng, r, rz, cz, thr, colours, pal, mat="foliage", bloom=None, bloom_frac=0.0, fruit=None, fruit_frac=0.0,
          flat_top=False):
    """an ellipsoid crown with ragged edges; shaded darker underneath (baked, as MagicaVoxel diorama renders do)"""
    R, RZ = int(np.ceil(r)) + 1, int(np.ceil(rz)) + 1
    dz, dy, dx = np.mgrid[-RZ:RZ + 1, -R:R + 1, -R:R + 1]
    d = (dx / r) ** 2 + (dy / r) ** 2 + (dz / rz) ** 2
    nz = _noise(rng, d.shape, 2)
    keep = d + (nz - 0.5) * 0.9 < thr
    if flat_top:
        keep &= dz <= RZ * 0.55
    z, y, x = dz[keep], dy[keep], dx[keep]
    n = nz[keep]
    t = (z + RZ) / (2 * RZ)  # 0 at the bottom of the crown, 1 at the top
    k = np.clip((t * 0.6 + n * 0.6) * len(colours), 0, len(colours) - 1).astype(int)
    out = np.array([pal(shade(colours[i], 0.82 + 0.3 * tt), mat) for i, tt in zip(k, t)], np.int64) if len(k) else np.zeros(0, np.int64)
    if bloom is not None:
        b = (rng.random(len(z)) < bloom_frac * (0.4 + t)) & (t > 0.35)
        out[b] = pal(bloom[0], bloom[1])
    if fruit is not None:
        f = rng.random(len(z)) < fruit_frac
        out[f] = pal(fruit, "citrus")
    return x, y, z + int(round(cz)), out


def _trunk(h, pal, colour=TRUNK, thick=False):
    z = np.arange(h)
    if not thick:
        return np.zeros(h, int), np.zeros(h, int), z, np.full(h, pal(colour))
    x = np.tile([0, 1, 0, 1], h); y = np.tile([0, 0, 1, 1], h)
    return x, y, np.repeat(z, 4), np.full(4 * h, pal(colour))


def _cat(*parts):
    xs, ys, zs, ps = zip(*parts)
    x, y, z, p = (np.concatenate(a).astype(np.int64) for a in (xs, ys, zs, ps))
    # one voxel per cell: the later part (crown) wins over the trunk
    key = (x + 64) * 1_000_000 + (y + 64) * 1000 + z
    _, idx = np.unique(key[::-1], return_index=True)
    idx = len(key) - 1 - idx
    return x[idx], y[idx], z[idx], p[idx]


def _palm(rng, h, pal, frond=(96, 132, 62), length=4, droop=2, skirt=True, thick=False, trunk=(140, 118, 92)):
    parts = [_trunk(h, pal, trunk, thick)]
    if skirt:
        sk = [(dx, dy, dz) for dz in (h - 3, h - 2) for dx in (-1, 0, 1) for dy in (-1, 0, 1)]
        parts.append(tuple(np.array(a) for a in zip(*sk)) + (np.full(len(sk), pal((158, 136, 96))),))
    fx, fy, fz, fp = [], [], [], []
    for a in range(8):
        ang = a * np.pi / 4 + rng.uniform(-0.25, 0.25)
        L = length + rng.integers(0, 2)
        for i in range(1, L + 1):
            t = i / L
            fx.append(round(np.cos(ang) * i)); fy.append(round(np.sin(ang) * i))
            fz.append(h + round(1 - droop * t * t * 1.5))
            fp.append(pal(shade(frond, 0.85 + 0.3 * (1 - t) + rng.uniform(-0.05, 0.05)), "foliage"))
    for dz in (h, h + 1):  # the heart of the crown
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if abs(dx) + abs(dy) < 2 or dz == h:
                    fx.append(dx); fy.append(dy); fz.append(dz); fp.append(pal(shade(frond, 0.9), "foliage"))
    parts.append((np.array(fx), np.array(fy), np.array(fz), np.array(fp)))
    return _cat(*parts)


def sprite(kind, rng, pal):
    if kind == "ficus":
        h, r = rng.uniform(7, 11), rng.uniform(3.5, 5.5)
        c = _blob(rng, r, r * 0.72, h * 0.62, 1.0, [(46, 82, 44), (58, 96, 50), (72, 112, 58)], pal)
        return _cat(_trunk(int(h * 0.45), pal, thick=r > 4.8), c)
    if kind == "poinciana":
        h, r = rng.uniform(6, 8), rng.uniform(4, 6)
        c = _blob(rng, r, r * 0.38, h * 0.78, 1.0, [(80, 124, 54), (96, 142, 62), (112, 156, 70)], pal,
                  bloom=((214, 64, 38), "bloom_red"), bloom_frac=0.55)
        return _cat(_trunk(int(h * 0.7), pal), c)
    if kind == "jacaranda":
        h, r = rng.uniform(7, 10), rng.uniform(3, 4.5)
        c = _blob(rng, r, r * 0.6, h * 0.68, 0.9, [(76, 118, 62), (88, 132, 70), (100, 146, 78)], pal,
                  bloom=((146, 112, 206), "bloom_purple"), bloom_frac=0.6)
        return _cat(_trunk(int(h * 0.5), pal), c)
    if kind == "broadleaf":
        h, r = rng.uniform(5, 9), rng.uniform(2.5, 4)
        c = _blob(rng, r, r * 0.8, h * 0.62, 1.0, [(66, 108, 52), (82, 126, 60), (98, 140, 66)], pal)
        return _cat(_trunk(int(h * 0.45), pal), c)
    if kind == "washingtonia":
        return _palm(rng, int(rng.uniform(12, 20)), pal)
    if kind == "phoenix":
        return _palm(rng, int(rng.uniform(5, 10)), pal, frond=(112, 136, 76), length=5, droop=3, skirt=False,
                     thick=True, trunk=(128, 104, 78))
    if kind == "citrus":
        r = rng.uniform(1.6, 2.2)
        c = _blob(rng, r, r * 0.9, 2.3, 1.05, [(44, 84, 40), (54, 98, 46), (66, 112, 52)], pal,
                  fruit=(240, 150, 36), fruit_frac=0.07)
        return _cat(_trunk(1, pal), c)
    if kind == "pine":
        h, r = rng.uniform(10, 15), rng.uniform(3, 4.5)
        c = _blob(rng, r, r * 0.45, h * 0.82, 1.0, [(48, 78, 52), (58, 92, 58), (70, 104, 64)], pal, flat_top=False)
        return _cat(_trunk(int(h * 0.78), pal, (104, 80, 62)), c)
    if kind == "cypress":
        h = rng.uniform(8, 13)
        c = _blob(rng, 1.4, h * 0.45, h * 0.52, 1.0, [(40, 70, 46), (50, 82, 52)], pal)
        return _cat(_trunk(2, pal), c)
    if kind == "eucalyptus":
        h, r = rng.uniform(14, 20), rng.uniform(4, 6)
        c = _blob(rng, r, r * 0.7, h * 0.72, 0.85, [(106, 128, 92), (120, 140, 100), (136, 152, 112)], pal)
        return _cat(_trunk(int(h * 0.6), pal, (212, 204, 186), thick=True), c)
    if kind == "bush":
        r = rng.uniform(0.9, 1.6)
        return _blob(rng, r, r * 0.7, 0.6, 1.1, [(70, 110, 52), (86, 124, 58)], pal)
    raise KeyError(kind)


class Sprites:
    """a handful of variants of each kind, built once"""

    def __init__(self, pal, variants=8, seed=7):
        rng = np.random.default_rng(seed)
        self.v = {k: [sprite(k, rng, pal) for _ in range(variants)] for k in KINDS}

    def get(self, kind, i):
        vs = self.v[kind]
        return vs[i % len(vs)]
