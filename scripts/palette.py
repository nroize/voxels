"""Palette: voxel value -> (r, g, b, material). 0 is empty. The viewer reads the material to draw windows, water,
night lights and blossom in the shader (web/src/material.ts); keep the numbers in sync with MAT there."""

MAT = dict(
    plain=0,
    facade=1,      # plastered walls with punched windows and balcony bands (the White City)
    glass=2,       # curtain-wall towers
    stone=3,       # kurkar / limestone walls with small windows (Jaffa, old Rehovot)
    sea=4,
    water=5,       # pools, ponds, fountains
    foliage=6,
    lamp=7,        # lit at night
    bloom_purple=8,  # jacaranda: purple in April-June, green otherwise
    bloom_red=9,     # royal poinciana: red in May-August
    beacon=10,     # aviation lights on towers, red, blink at night
    citrus=11,     # orange fruit, Nov-Mar
    window=12,     # always-glass (small kiosks, greenhouses)
    site=13,       # an unfinished concrete frame: open floors
)


class Palette:
    def __init__(self):
        self.entries = [(0, 0, 0, 0)]
        self.index = {}

    def __call__(self, rgb, mat="plain"):
        m = MAT[mat] if isinstance(mat, str) else mat
        key = (int(rgb[0]), int(rgb[1]), int(rgb[2]), m)
        i = self.index.get(key)
        if i is None:
            i = len(self.entries)
            if i >= 65534:
                raise RuntimeError("palette full")
            self.entries.append(key)
            self.index[key] = i
        return i

    def mat_of(self):
        import numpy as np
        return np.array([e[3] for e in self.entries], np.uint8)


def shade(rgb, f):
    return tuple(max(0, min(255, round(c * f))) for c in rgb)


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
