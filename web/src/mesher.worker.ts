// Fetches, unzips and greedy-meshes one tile (scripts/tiles.py), with ambient occlusion baked per vertex.
// Data axes: x = column (right), y = row (down the map), z = up. Positions go out in three.js axes (x, z, y),
// in metres from the node's corner. A tile is N x N cells of s metres plus a 1-cell apron.

export interface MeshRequest { key: string; url: string; N: number; s: number }
export type MeshReply =
  | { type: 'mesh'; key: string; pos: Int16Array; attr: Uint8Array; pal: Uint16Array; index: Uint32Array; quads: number; top: number }
  | { type: 'error'; key: string; error: string };

const post = (m: MeshReply, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: MeshReply, t: Transferable[]): void }).postMessage(m, transfer);

async function fetchGzip(url: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

self.onmessage = async (e: MessageEvent<MeshRequest>) => {
  const m = e.data;
  try {
    const buf = await fetchGzip(m.url);
    const out = mesh(buf, m.N, m.s);
    post({ type: 'mesh', key: m.key, ...out }, [out.pos.buffer, out.attr.buffer, out.pal.buffer, out.index.buffer]);
  } catch (err) {
    post({ type: 'error', key: m.key, error: String(err) });
  }
};

class Quads {
  cap = 1 << 14;
  pos = new Int16Array(this.cap * 12);
  attr = new Uint8Array(this.cap * 16); // per vertex: normal, ao, ground, flip
  pal = new Uint16Array(this.cap * 4);
  n = 0;
  grow() {
    this.cap *= 2;
    const g = <T extends Int16Array | Uint8Array | Uint16Array>(a: T, k: number) => {
      const b = new (a.constructor as new (n: number) => T)(this.cap * k); b.set(a); return b;
    };
    this.pos = g(this.pos, 12); this.attr = g(this.attr, 16); this.pal = g(this.pal, 4);
  }
}

// face directions: [axis, sign]; axis 0 = x, 1 = y (row), 2 = z (up)
const DIRS: [number, number][] = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];

export function mesh(buf: ArrayBuffer, N: number, s: number) {
  const S = N + 2, SS = S * S;
  const counts = new Uint16Array(buf, 0, SS);
  const ground = new Uint8Array(buf, SS * 2, SS);
  let nr = 0;
  for (let i = 0; i < SS; i++) nr += counts[i];
  const runs = new Uint16Array(buf.slice(SS * 3, SS * 3 + nr * 6));
  let H = 0;
  for (let k = 0; k < nr; k++) H = Math.max(H, runs[k * 3] + runs[k * 3 + 1]);
  const Hz = H + 2; // one empty layer below and above
  const vol = new Uint16Array(SS * Hz);
  for (let i = 0, k = 0; i < SS; i++) {
    for (let e = k + counts[i]; k < e; k++) {
      const z0 = runs[k * 3], len = runs[k * 3 + 1], v = runs[k * 3 + 2];
      for (let z = z0; z < z0 + len; z++) vol[i + SS * (z + 1)] = v;
    }
  }
  const q = new Quads();
  const st = [1, S, SS];
  for (let d = 0; d < 6; d++) {
    const [a, sg] = DIRS[d];
    const u = (a + 1) % 3, v = (a + 2) % 3;
    // the slab of cells we own: x, y in the core (1..N), z 1..Hz-2. Every neighbour of those is inside the volume
    // (the apron, and the empty layers below and above), so no bounds checks
    const lo = [1, 1, 1], hi = [N + 1, N + 1, Hz - 1];
    const du = hi[u] - lo[u], dv = hi[v] - lo[v];
    const sa = st[a], su = st[u], sv = st[v], off = sg * sa;
    const mask = new Float64Array(du * dv);
    for (let l = lo[a]; l < hi[a]; l++) {
      mask.fill(0);
      let any = false;
      if (a === 2 && sg < 0 && l <= 1) continue; // the underside of the map
      for (let j = 0; j < dv; j++) {
        let idx = l * sa + lo[u] * su + (lo[v] + j) * sv;
        for (let i = 0; i < du; i++, idx += su) {
          const c = vol[idx];
          if (!c) continue;
          const n = idx + off;
          if (vol[n]) continue;
          // AO from the 8 cells around the face, in the layer in front of it
          const um = vol[n - su] ? 1 : 0, up = vol[n + su] ? 1 : 0, vm = vol[n - sv] ? 1 : 0, vp = vol[n + sv] ? 1 : 0;
          const mm = vol[n - su - sv] ? 1 : 0, pm = vol[n + su - sv] ? 1 : 0, mp = vol[n - su + sv] ? 1 : 0, pp = vol[n + su + sv] ? 1 : 0;
          const o0 = um && vm ? 0 : 3 - (um + vm + mm), o1 = up && vm ? 0 : 3 - (up + vm + pm);
          const o2 = um && vp ? 0 : 3 - (um + vp + mp), o3 = up && vp ? 0 : 3 - (up + vp + pp);
          const ao = o0 | (o1 << 2) | (o2 << 4) | (o3 << 6);
          const g = a === 2 ? 0 : ground[idx % SS];
          mask[i + j * du] = (c * 256 + ao) * 256 + g + 1;
          any = true;
        }
      }
      if (!any) continue;
      // greedy merge of equal keys
      for (let j = 0; j < dv; j++) {
        for (let i = 0; i < du;) {
          const key = mask[i + j * du];
          if (!key) { i++; continue; }
          let w = 1;
          while (i + w < du && mask[i + w + j * du] === key) w++;
          let h = 1;
          outer: for (; j + h < dv; h++) {
            for (let k = 0; k < w; k++) if (mask[i + k + (j + h) * du] !== key) break outer;
          }
          for (let jj = 0; jj < h; jj++) for (let k = 0; k < w; k++) mask[i + k + (j + jj) * du] = 0;
          emit(q, a, sg, u, v, l, lo[u] + i, lo[v] + j, w, h, key, s);
          i += w;
        }
      }
    }
  }
  // indices: two triangles per quad, the diagonal flipped where the AO calls for it
  const index = new Uint32Array(q.n * 6);
  for (let k = 0; k < q.n; k++) {
    const b = k * 4, flip = q.attr[b * 4 + 3];
    const o = k * 6;
    if (flip) { index.set([b + 1, b + 2, b + 3, b + 1, b + 3, b], o); } else { index.set([b, b + 1, b + 2, b, b + 2, b + 3], o); }
  }
  return { pos: q.pos.slice(0, q.n * 12), attr: q.attr.slice(0, q.n * 16), pal: q.pal.slice(0, q.n * 4), index, quads: q.n, top: H * s };
}

function emit(q: Quads, a: number, sg: number, u: number, v: number, l: number, i0: number, j0: number,
  w: number, h: number, key: number, s: number) {
  if (q.n >= q.cap) q.grow();
  const g = (key % 256) - 1;
  const rest = Math.floor(key / 256);
  const ao = rest % 256, pal = Math.floor(rest / 256);
  const plane = sg > 0 ? l + 1 : l;
  // corners in (u, v): 0 (0,0), 1 (w,0), 2 (w,h), 3 (0,h); AO bits are per (-u,-v), (+u,-v), (-u,+v), (+u,+v)
  const cu = [0, w, w, 0], cv = [0, 0, h, h];
  const aoBit = [0, 1, 3, 2];
  // winding: counter-clockwise seen from outside. (u, v, a) is cyclic, but the data axes (x right, y down, z up)
  // are left-handed, a mirror of three's, so the order is the reverse of the usual
  const order = sg > 0 ? [0, 3, 2, 1] : [0, 1, 2, 3];
  const nrm = a * 2 + (sg > 0 ? 0 : 1);
  const b = q.n * 4;
  const aos: number[] = [];
  for (let k = 0; k < 4; k++) {
    const c = order[k];
    const P = [0, 0, 0];
    P[a] = plane; P[u] = i0 + cu[c]; P[v] = j0 + cv[c];
    // data (x, y, z) -> three (x, z, y), apron removed, in metres
    const vi = b + k;
    q.pos[vi * 3] = (P[0] - 1) * s;
    q.pos[vi * 3 + 1] = (P[2] - 1) * s;
    q.pos[vi * 3 + 2] = (P[1] - 1) * s;
    const o = (ao >> (aoBit[c] * 2)) & 3;
    aos.push(o);
    q.attr[vi * 4] = nrm; q.attr[vi * 4 + 1] = o; q.attr[vi * 4 + 2] = Math.max(0, g); q.attr[vi * 4 + 3] = 0;
    q.pal[vi] = pal;
  }
  // flip the diagonal so AO interpolates without the anisotropy artefact
  if (aos[0] + aos[2] > aos[1] + aos[3]) q.attr[b * 4 + 3] = 1;
  q.n++;
}
