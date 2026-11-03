"""Streamable voxel tiles for the viewer (web/src/stream.ts), a quadtree of levels s = 1, 2, 4, 8 m.

A node holds N x N cells of s metres (spanning N * s m) plus a 1-cell apron on each side, for face culling and AO
at the node edge. File tiles/{s}/{tx}_{ty}.bin, gzip of:
  counts  uint16[(N+2)^2]   runs per column (row-major, row 0 = the map's top edge)
  ground  uint8 [(N+2)^2]   ground level in metres above the base (the facade shader counts floors from it)
  runs    uint16[3 * sum]   (z0, len, palette) per run, z in cells of the level, bottom -> top

Level-1 nodes are composed from the 2D layers (ground, surface, building bodies, water) and the sparse object
voxels (trees, lamps, rooftops...). Coarser levels are downsampled from them: a cell is solid when at least a
quarter of its block is (3/8 at s = 2) and wears the colour of the block's topmost voxel, so roofs stay roofs and
streets stay streets from above.
"""
import gzip
import multiprocessing as mp
import os

import numpy as np

N = 128
LEVELS = (1, 2, 4, 8)
_G = {}


def column_runs(vol):
    """vol (H, R, C) -> counts (R*C,), runs (n, 3) bottom -> top, row-major columns"""
    H = vol.shape[0]
    cols = vol.reshape(H, -1).T
    n = cols.shape[0]
    b = np.zeros((n, H + 1), bool)
    b[:, 0] = True
    b[:, 1:H] = cols[:, 1:] != cols[:, :-1]
    b[:, H] = True
    fi = np.flatnonzero(b)
    ci, zi = fi // (H + 1), fi % (H + 1)
    same = ci[:-1] == ci[1:]
    c, z0, z1 = ci[:-1][same], zi[:-1][same], zi[1:][same]
    v = cols[c, z0]
    k = v != 0
    c, z0, z1, v = c[k], z0[k], z1[k], v[k]
    counts = np.bincount(c, minlength=n).astype(np.uint16)
    return counts, np.stack([z0, z1 - z0, v], 1).astype(np.uint16)


def downsample(vol, s):
    H, R, C = vol.shape
    Hs = -(-H // s)
    v = np.pad(vol, ((0, Hs * s - H), (0, 0), (0, 0)))
    blk = v.reshape(Hs, s, R // s, s, C // s, s)
    need = 3 if s == 2 else s ** 3 // 4
    occ = (blk != 0).sum((1, 3, 5), dtype=np.int32)
    col = np.zeros((Hs, R // s, C // s), np.uint16)
    for dz in range(s - 1, -1, -1):  # the topmost voxel of the block
        layer = blk[:, dz]
        for dy in range(s):
            for dx in range(s):
                x = layer[:, :, dy, :, dx]
                col = np.where((col == 0) & (x != 0), x, col)
    res = np.where(occ >= need, col, 0)
    # a thin surface (a road, a flat roof) in the bottom layer of a block that is too sparse to keep: the solid
    # block under it wears its colour instead of showing the soil below
    up = np.zeros_like(col)
    up[:-1] = np.where(res[1:] == 0, col[1:], 0)
    return np.where((res != 0) & (up != 0), up, res).astype(np.uint16)


def write(path, counts, ground, runs):
    with gzip.GzipFile(path, "wb", compresslevel=6, mtime=0) as fh:
        fh.write(counts.tobytes() + ground.tobytes() + runs.tobytes())
    return path.stat().st_size


def _window(a, r0, c0, S, fill=0):
    D, W = a.shape
    out = np.full((S, S), fill, a.dtype)
    rr0, rr1, cc0, cc1 = max(r0, 0), min(r0 + S, D), max(c0, 0), min(c0 + S, W)
    if rr0 < rr1 and cc0 < cc1:
        out[rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0] = a[rr0:rr1, cc0:cc1]
    return out


def compose(tx, ty):
    """the level-1 volume over node (tx, ty) and its apron"""
    L, (ox, oy, oz, op), starts, nx, soil, deep = (_G[k] for k in ("L", "obj", "starts", "nx", "soil", "deep"))
    S = N + 2
    r0, c0 = ty * N - 1, tx * N - 1
    w = {k: _window(v, r0, c0, S) for k, v in L.items()}
    # the objects of this node and its 8 neighbours, cut to the window
    sel = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            k = (ty + dy) * nx + (tx + dx)
            if 0 <= tx + dx < nx and 0 <= k < len(starts) - 1:
                sel.append(np.arange(starts[k], starts[k + 1]))
    sel = np.concatenate(sel) if sel else np.zeros(0, np.int64)
    x, y, z, p = ox[sel] - c0, oy[sel] - r0, oz[sel], op[sel]
    k = (x >= 0) & (x < S) & (y >= 0) & (y < S)
    x, y, z, p = x[k], y[k], z[k], p[k]
    g, hi, radd = w["gz"], w["hi"], w["radd"]
    Ht = int(max(g.max(), (hi + radd).max(), w["wtop"].max(), z.max() + 1 if len(z) else 0)) + 1
    Z = np.arange(Ht, dtype=np.int32)[:, None, None]
    vol = np.where(Z < g - 4, deep, np.where(Z < g - 1, soil, 0)).astype(np.uint16)
    vol = np.where(Z == g - 1, w["spal"], vol)
    vol = np.where((Z >= g) & (Z < w["wtop"]), w["wsea"], vol)
    inb = hi > 0
    vol = np.where(inb & (Z >= w["lo"]) & (Z < hi), w["wpal"], vol)
    vol = np.where(inb & ~w["edge"] & (Z == hi - 1) & (radd == 0), w["rpal"], vol)
    vol = np.where(inb & (Z >= hi - 1) & (Z < hi + radd) & (radd > 0), w["rpal"], vol)
    vol = vol.astype(np.uint16)
    if len(z):
        free = vol[z, y, x] == 0
        vol[z[free], y[free], x[free]] = p[free]
    return vol, g


def _l1(job):
    tx, ty, out = job
    vol, g = compose(tx, ty)
    top = int(np.nonzero(vol.reshape(vol.shape[0], -1).any(1))[0].max()) + 1 if vol.any() else 1
    vol = vol[:top]
    counts, runs = column_runs(vol)
    size = write(out / "1" / f"{tx}_{ty}.bin", counts, np.clip(g, 0, 255).astype(np.uint8), runs)
    core = vol[:, 1:-1, 1:-1]
    return tx, ty, size, len(runs), {s: downsample(core, s) for s in LEVELS[1:]}, top


def export(L, obj, out, soil, deep, log):
    D, W = L["gz"].shape
    ox, oy, oz, op = obj
    nx, ny = -(-W // N), -(-D // N)
    order = np.argsort((oy // N) * nx + ox // N, kind="stable")
    ox, oy, oz, op = ox[order], oy[order], oz[order], op[order]
    tid = (oy // N) * nx + ox // N
    starts = np.searchsorted(tid, np.arange(nx * ny + 1))
    H = int(max(L["gz"].max(), (L["hi"] + L["radd"]).max(), oz.max() if len(oz) else 0)) + 3
    Hc = -(-H // 8) * 8
    _G.update(L=L, obj=(ox, oy, oz, op.astype(np.uint16)), starts=starts, nx=nx, soil=soil, deep=deep)
    for s in LEVELS:
        (out / str(s)).mkdir(parents=True, exist_ok=True)
        for f in (out / str(s)).glob("*.bin"):
            f.unlink()
    coarse = {s: np.zeros((Hc // s, ny * N // s, nx * N // s), np.uint16) for s in LEVELS[1:]}
    jobs = [(tx, ty, out) for ty in range(ny) for tx in range(nx)]
    tot = runs = 0
    ctx = mp.get_context("fork")
    with ctx.Pool(max(1, (os.cpu_count() or 2) - 1)) as pool:
        for i, (tx, ty, size, nr, pieces, top) in enumerate(pool.imap_unordered(_l1, jobs, chunksize=2)):
            tot += size
            runs += nr
            for s, a in pieces.items():
                n = N // s
                coarse[s][:a.shape[0], ty * n:(ty + 1) * n, tx * n:(tx + 1) * n] = a
            if (i + 1) % 100 == 0:
                log(f"tiles level 1: {i + 1}/{len(jobs)}")
    info = dict(levels=[dict(s=1, nx=nx, ny=ny)], H=H)
    log(f"tiles level 1: {nx}x{ny} nodes, {runs / 1e6:.1f} M runs, {tot / 2 ** 20:.1f} MB gz")
    g = L["gz"]
    for s in LEVELS[1:]:
        vs = coarse[s]
        _, Ds, Ws = vs.shape
        snx, sny = -(-Ws // N), -(-Ds // N)
        gs = np.clip(g[::s, ::s], 0, 255).astype(np.uint8)
        stot = sruns = 0
        for ty in range(sny):
            for tx in range(snx):
                r0, c0 = ty * N - 1, tx * N - 1
                win = np.zeros((vs.shape[0], N + 2, N + 2), np.uint16)
                rr0, rr1, cc0, cc1 = max(r0, 0), min(r0 + N + 2, Ds), max(c0, 0), min(c0 + N + 2, Ws)
                win[:, rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0] = vs[:, rr0:rr1, cc0:cc1]
                gw = _window(gs, r0, c0, N + 2)
                top = int(np.nonzero(win.reshape(win.shape[0], -1).any(1))[0].max()) + 1 if win.any() else 1
                counts, rr = column_runs(win[:top])
                stot += write(out / str(s) / f"{tx}_{ty}.bin", counts, gw, rr)
                sruns += len(rr)
        info["levels"].append(dict(s=s, nx=snx, ny=sny))
        log(f"tiles level {s}: {snx}x{sny} nodes, {sruns / 1e6:.2f} M runs, {stot / 2 ** 20:.1f} MB gz")
    return info
