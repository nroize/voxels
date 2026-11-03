// Click a building to select it; "Isolate" cuts its voxels out of the level-1 tiles (with the building ids of
// tiles/b, scripts/search.py) and shows them alone on a turntable, ready to download as a MagicaVoxel .vox.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAT, paletteTexture, voxelMaterial } from './material';
import { cloudTextures, cloudUniforms } from './clouds';
import { centre, type Building, type Search } from './search';
import type { MeshReply } from './mesher.worker';

const FOLIAGE = new Set<number>([MAT.foliage, MAT.bloomPurple, MAT.bloomRed, MAT.citrus]);

async function gunzip(url: string) {
  const r = await fetch(url);
  if (!r.ok || !r.body || (r.headers.get('content-type') ?? '').includes('text/html')) return null;
  return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

/** the voxel columns of one building: (x, y) in map metres -> runs (z0, len, palette) at or above its base */
export interface Cutout { x0: number; y0: number; w: number; d: number; cols: Map<number, number[]>; ground: Map<number, number>; zmin: number; zmax: number }

export class Inspector {
  selected = 0;
  private ids = new Map<string, Promise<Uint16Array | null>>();
  private card: HTMLDivElement;
  private ray = new THREE.Raycaster();
  private shell: THREE.Mesh;
  private models = new Map<number, Promise<{ cut: Cutout; mesh: Extract<MeshReply, { type: 'mesh' }> } | null>>();
  private guessed = new Map<number, string | null>(); // estimated addresses, by building

  constructor(private base: string, private N: number, private scene: THREE.Scene, private camera: THREE.Camera,
    private meshes: THREE.Group, private search: () => Promise<Search>, private palette: [number, number, number, number][],
    private floorH: number, private onFly: (x: number, y: number, z: number, dist: number) => void) {
    // the highlight: the building's own voxel faces in translucent orange, drawn just in front of the city's
    this.shell = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: 0xffa000, transparent: true, opacity: 0.5, depthWrite: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    }));
    this.shell.renderOrder = 10;
    this.shell.visible = false;
    this.shell.frustumCulled = false;
    scene.add(this.shell);
    this.card = document.createElement('div');
    this.card.className = 'card bcard';
    this.card.hidden = true;
    document.body.appendChild(this.card);
  }

  private idTile(tx: number, ty: number) {
    const k = `${tx}_${ty}`;
    if (!this.ids.has(k)) this.ids.set(k, gunzip(`${this.base}/tiles/b/${k}.bin`).then((b) => b && new Uint16Array(b)));
    return this.ids.get(k)!;
  }

  async buildingAt(x: number, y: number) {
    const tx = Math.floor(x / this.N), ty = Math.floor(y / this.N);
    const t = await this.idTile(tx, ty);
    if (!t) return 0;
    const cx = Math.floor(x) - tx * this.N, cy = Math.floor(y) - ty * this.N;
    return cx >= 0 && cy >= 0 && cx < this.N && cy < this.N ? t[cy * this.N + cx] : 0;
  }

  /** the nearest voxel face under the pointer: raycast tile by tile, nearest box first, stop once nothing nearer */
  pick(ndc: THREE.Vector2) {
    this.ray.setFromCamera(ndc, this.camera);
    const r = this.ray.ray, p = new THREE.Vector3();
    const cands: { m: THREE.Mesh; d: number }[] = [];
    for (const o of this.meshes.children) {
      const m = o as THREE.Mesh;
      if (!m.visible) continue;
      const bb = m.geometry.boundingBox!.clone().translate(m.position);
      if (r.intersectBox(bb, p)) cands.push({ m, d: r.origin.distanceTo(p) });
    }
    cands.sort((a, b) => a.d - b.d);
    let best: THREE.Intersection | null = null;
    for (const c of cands) {
      if (best && c.d > best.distance) break;
      const hits = this.ray.intersectObject(c.m, false);
      if (hits.length && (!best || hits[0].distance < best.distance)) best = hits[0];
    }
    if (!best || !best.face) return null;
    // into the voxel that was hit
    return best.point.clone().addScaledVector(best.face.normal, -0.3);
  }

  async click(ndc: THREE.Vector2) {
    const p = this.pick(ndc);
    if (!p) { this.select(0); return; }
    this.select(await this.buildingAt(p.x, p.z));
  }

  async select(g: number, fly = false) {
    this.selected = g;
    const s = await this.search();
    const b = g ? s.buildings[g] : null;
    this.shell.visible = false;
    if (!b) { this.card.hidden = true; return; }
    const [x0, y0, x1, y1] = b.box;
    this.model(g, b).then((m) => {
      if (!m || this.selected !== g) return;
      this.shell.geometry.dispose();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.mesh.pos, 3));
      geo.setIndex(new THREE.BufferAttribute(m.mesh.index, 1));
      this.shell.geometry = geo;
      this.shell.position.set(m.cut.x0, 0, m.cut.y0);
      this.shell.visible = true;
    });
    this.card.hidden = false;
    if (b.addr && !this.guessed.has(g)) this.guessed.set(g, s.english(b.addr));
    if (!b.addr && !this.guessed.has(g)) {
      const [cx, cy] = centre(b);
      const r = s.reverse(cx, cy);
      this.guessed.set(g, r ? (r.num ? `≈ ${r.street} ${r.num}` : `on ${r.street}`) : null);
    }
    this.card.innerHTML = cardHtml(b, true, this.guessed.get(g) ?? null);
    this.card.querySelector<HTMLButtonElement>('.iso')!.onclick = () => this.isolate(g, b);
    this.card.querySelector<HTMLButtonElement>('.x')!.onclick = () => this.select(0);
    if (fly) this.onFly((x0 + x1) / 2, b.z0 + (b.z1 - b.z0) * 0.4, (y0 + y1) / 2, Math.max(140, (b.z1 - b.z0) * 1.6 + Math.max(x1 - x0, y1 - y0)));
  }

  /** the building's voxels from the level-1 tiles under its box */
  private async cut(g: number, b: Building): Promise<Cutout> {
    const [x0, y0, x1, y1] = b.box, N = this.N, S = N + 2;
    const cols = new Map<number, number[]>(), ground = new Map<number, number>();
    let zmin = Infinity, zmax = 0;
    const jobs: Promise<void>[] = [];
    for (let ty = Math.floor(y0 / N); ty <= Math.floor((y1 - 1) / N); ty++) {
      for (let tx = Math.floor(x0 / N); tx <= Math.floor((x1 - 1) / N); tx++) {
        jobs.push((async () => {
          const [ids, buf] = await Promise.all([this.idTile(tx, ty), gunzip(`${this.base}/tiles/1/${tx}_${ty}.bin`)]);
          if (!ids || !buf) return;
          const counts = new Uint16Array(buf, 0, S * S), gr = new Uint8Array(buf, S * S * 2, S * S);
          let nr = 0;
          const off = new Uint32Array(S * S + 1);
          for (let i = 0; i < S * S; i++) { off[i] = nr; nr += counts[i]; }
          const runs = new Uint16Array(buf.slice(S * S * 3, S * S * 3 + nr * 6));
          for (let cy = 0; cy < N; cy++) for (let cx = 0; cx < N; cx++) {
            if (ids[cy * N + cx] !== g) continue;
            const i = (cy + 1) * S + cx + 1, out: number[] = [];
            for (let k = off[i]; k < off[i] + counts[i]; k++) {
              let z0 = runs[k * 3], len = runs[k * 3 + 1];
              const v = runs[k * 3 + 2];
              if (FOLIAGE.has(this.palette[v]?.[3])) continue;
              if (z0 + len <= b.z0) continue;
              if (z0 < b.z0) { len -= b.z0 - z0; z0 = b.z0; }
              out.push(z0, len, v);
              zmin = Math.min(zmin, z0); zmax = Math.max(zmax, z0 + len);
            }
            const key = (ty * N + cy) * 100000 + tx * N + cx;
            if (out.length) { cols.set(key, out); ground.set(key, gr[i]); }
          }
        })());
      }
    }
    await Promise.all(jobs);
    return { x0, y0, w: x1 - x0, d: y1 - y0, cols, ground, zmin: Number.isFinite(zmin) ? zmin : b.z0, zmax };
  }

  /** the building cut out and meshed (once per building: the highlight and the isolated view share it) */
  private model(g: number, b: Building) {
    if (!this.models.has(g)) this.models.set(g, (async () => {
      const cut = await this.cut(g, b);
      const W = Math.max(cut.w, cut.d), S = W + 2;
      // an uncompressed tile in the mesher's format with the building in its core
      const counts = new Uint16Array(S * S), gbuf = new Uint8Array(S * S), runs: number[] = [];
      for (let cy = 0; cy < cut.d; cy++) for (let cx = 0; cx < cut.w; cx++) {
        const key = (cut.y0 + cy) * 100000 + cut.x0 + cx, c = cut.cols.get(key);
        if (!c) continue;
        const i = (cy + 1) * S + cx + 1;
        counts[i] = c.length / 3; gbuf[i] = cut.ground.get(key) ?? 0;
        runs.push(...c);
      }
      const r16 = new Uint16Array(runs);
      const buf = new Uint8Array(S * S * 3 + r16.byteLength);
      buf.set(new Uint8Array(counts.buffer), 0); buf.set(gbuf, S * S * 2); buf.set(new Uint8Array(r16.buffer), S * S * 3);
      const worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' });
      const reply = await new Promise<MeshReply>((res) => { worker.onmessage = (e) => res(e.data); worker.postMessage({ key: 'iso', buf: buf.buffer, N: W, s: 1 }, [buf.buffer]); });
      worker.terminate();
      return reply.type === 'mesh' ? { cut, mesh: reply } : null;
    })());
    return this.models.get(g)!;
  }

  async isolate(g: number, b: Building) {
    const ov = document.createElement('div');
    ov.className = 'iso-view';
    ov.innerHTML = `<div class="iso-card card">${cardHtml(b, false, this.guessed.get(g) ?? null)}<div class="iso-actions"><button class="vox">Download .vox</button><button class="close">Close</button></div><p class="iso-note">Drag to turn, scroll to zoom. Windows are drawn by the shader, so the .vox has plain walls.</p></div><div class="iso-loading">cutting out the voxels…</div>`;
    document.body.appendChild(ov);
    const m = await this.model(g, b);
    ov.querySelector('.iso-loading')!.remove();
    if (!m) return;
    const { cut, mesh: reply } = m;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    ov.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const { material } = voxelMaterial(paletteTexture(this.palette), this.floorH, cloudUniforms(cloudTextures()));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(reply.pos, 3));
    geo.setAttribute('vattr', new THREE.BufferAttribute(reply.attr, 4));
    geo.setAttribute('pal', new THREE.BufferAttribute(reply.pal, 1));
    geo.setIndex(new THREE.BufferAttribute(reply.index, 1));
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    const cx = cut.w / 2, cz = cut.d / 2, H = cut.zmax - cut.zmin, R = Math.max(cut.w, cut.d, H);
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(cut.w + 6, 1.5, cut.d + 6), new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 1 }));
    plinth.position.set(cx, cut.zmin - 0.75, cz);
    plinth.receiveShadow = true;
    scene.add(plinth);
    scene.add(new THREE.HemisphereLight(0xdfe9ff, 0xb9a98c, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
    sun.position.set(cx - R, cut.zmin + R * 1.4, cz + R * 0.8);
    sun.target.position.set(cx, cut.zmin, cz);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: R * 5 });
    sun.shadow.normalBias = 0.3;
    scene.add(sun, sun.target);
    const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.5, R * 20);
    // far enough for the bounding sphere to fit the narrower side of the view
    const rad = 0.5 * Math.hypot(cut.w, cut.d, H);
    const fov = THREE.MathUtils.degToRad(Math.min(camera.fov, camera.fov * camera.aspect)) / 2;
    const dist = (rad / Math.sin(fov)) * 1.05;
    camera.position.set(cx, cut.zmin + H * 0.42, cz).add(new THREE.Vector3(-0.55, 0.45, 0.7).normalize().multiplyScalar(dist));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(cx, cut.zmin + H * 0.42, cz);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.8;
    controls.addEventListener('start', () => { controls.autoRotate = false; });
    let alive = true;
    const loop = () => { if (!alive) return; controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); };
    loop();
    const resize = () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); };
    addEventListener('resize', resize);
    const close = () => {
      alive = false; removeEventListener('resize', resize); removeEventListener('keydown', esc);
      geo.dispose(); renderer.dispose(); ov.remove();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('keydown', esc);
    ov.querySelector<HTMLButtonElement>('.close')!.onclick = close;
    const vb = ov.querySelector<HTMLButtonElement>('.vox')!;
    if (cut.w > 256 || cut.d > 256 || H > 256) { vb.disabled = true; vb.title = 'MagicaVoxel models are at most 256 voxels a side'; }
    vb.onclick = () => download(toVox(cut, this.palette), `${slug(b.name ?? b.addr ?? b.osm)}.vox`);
  }
}

function cardHtml(b: Building, buttons = true, guess: string | null = null) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const title = b.name ?? b.addr ?? kindName(b.kind);
  const src = b.src === 'height' ? 'height from OSM' : b.src === 'levels' ? 'from OSM floor count' : b.src === 'estimated' ? 'height estimated' : 'from OSM parts';
  const [type, id] = [b.osm[0] === 'w' ? 'way' : 'relation', b.osm.slice(1)];
  return `<div class="bc-head"><b>${esc(title)}</b>${buttons ? '<button class="x" title="Close">×</button>' : ''}</div>
    ${b.he ? `<div class="bc-he" dir="rtl">${esc(b.he)}</div>` : ''}
    ${b.addr && b.addr !== title ? `<div class="bc-addr">${guess ? `${esc(guess)} · ` : ''}<bdi>${esc(b.addr)}</bdi></div>` : ''}
    ${!b.addr && guess ? `<div class="bc-addr guess" title="OSM has no address for this building: the nearest street, the number interpolated from the mapped ones on that side">${esc(guess)} <span>${guess.startsWith('≈') ? 'approximate' : 'no number mapped'}</span></div>` : ''}
    <div class="bc-facts">${Math.round(b.h)} m${b.levels ? ` · ${b.levels} floors` : ''} · <span class="${b.src === 'estimated' ? 'est' : ''}">${src}</span></div>
    <div class="bc-links"><a href="https://www.openstreetmap.org/${type}/${id}" target="_blank" rel="noopener">OpenStreetMap ↗</a>${buttons ? '<button class="iso">Isolate ▸</button>' : ''}</div>`;
}

const KINDS: Record<string, string> = {
  yes: 'Building', apartments: 'Apartment building', residential: 'Apartment building', house: 'House', office: 'Office building',
  commercial: 'Commercial building', retail: 'Shops', industrial: 'Industrial building', school: 'School', university: 'University building',
  hospital: 'Hospital', hotel: 'Hotel', synagogue: 'Synagogue', mosque: 'Mosque', church: 'Church', construction: 'Under construction',
  garage: 'Garage', garages: 'Garages', roof: 'Canopy', public: 'Public building', civic: 'Civic building', kindergarten: 'Kindergarten',
};
const kindName = (k: string | null) => (k && KINDS[k]) ?? (k ? k[0].toUpperCase() + k.slice(1).replace(/_/g, ' ') : 'Building');

const slug = (s: string) => s.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'building';

function download(data: Uint8Array<ArrayBuffer>, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** MagicaVoxel .vox (version 150): SIZE, XYZI and RGBA; z up, y to the north */
export function toVox(cut: Cutout, palette: [number, number, number, number][]): Uint8Array<ArrayBuffer> {
  const colour = new Map<number, number>();
  const vox: number[] = [];
  for (const [key, c] of cut.cols) {
    const x = (key % 100000) - cut.x0, y = Math.floor(key / 100000) - cut.y0;
    for (let k = 0; k < c.length; k += 3) {
      let ci = colour.get(c[k + 2]);
      if (ci === undefined) { ci = Math.min(255, colour.size + 1); colour.set(c[k + 2], ci); }
      for (let z = c[k]; z < c[k] + c[k + 1]; z++) vox.push(x, cut.d - 1 - y, z - cut.zmin, ci);
    }
  }
  const sx = cut.w, sy = cut.d, sz = cut.zmax - cut.zmin;
  const n = vox.length / 4;
  const size = 12 + 12, xyzi = 12 + 4 + n * 4, rgba = 12 + 1024;
  const buf = new ArrayBuffer(8 + 12 + size + xyzi + rgba);
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let o = 0;
  const tag = (s: string) => { for (const ch of s) u8[o++] = ch.charCodeAt(0); };
  const i32 = (v: number) => { dv.setInt32(o, v, true); o += 4; };
  tag('VOX '); i32(150);
  tag('MAIN'); i32(0); i32(size + xyzi + rgba);
  tag('SIZE'); i32(12); i32(0); i32(sx); i32(sy); i32(sz);
  tag('XYZI'); i32(4 + n * 4); i32(0); i32(n);
  u8.set(vox, o); o += n * 4;
  tag('RGBA'); i32(1024); i32(0);
  for (const [p, ci] of colour) { const c = palette[p]; u8.set([c[0], c[1], c[2], 255], o + (ci - 1) * 4); }
  return u8;
}
