// Streams the quadtree of tiles (scripts/tiles.py): the whole map at 8 m first, then refines what is in view until a
// cell of the coarser level would cover fewer than `err` pixels. A parent stays drawn until all its children are
// meshed, so there are no holes; hidden nodes are dropped when the quad budget runs out.
import * as THREE from 'three';
import type { MeshReply, MeshRequest } from './mesher.worker';

export interface TileLevel { s: number; nx: number; ny: number }

interface Node {
  key: string; s: number; tx: number; ty: number;
  box: THREE.Box3;
  state: 'none' | 'queued' | 'loading' | 'ready' | 'error';
  mesh: THREE.Mesh | null;
  quads: number;
  used: number;
  children: Node[];
  parent: Node | null;
}

export class Stream {
  roots: Node[] = [];
  nodes = new Map<string, Node>();
  group = new THREE.Group();
  workers: Worker[] = [];
  idle: Worker[] = [];
  queue: Node[] = [];
  frame = 0;
  quads = 0;
  budget = 9_000_000;
  err: number;
  drawn = 0;
  version = 0; // bumps whenever the set of drawn meshes changes (the shadow map is redrawn then)
  private drawnKey = '';
  pending = 0;
  private frustum = new THREE.Frustum();
  private m4 = new THREE.Matrix4();
  private tmp = new THREE.Vector3();

  constructor(private base: string, private N: number, levels: TileLevel[], H: number, private material: THREE.Material, err = 3) {
    this.err = err;
    const byS = new Map(levels.map((l) => [l.s, l]));
    const make = (s: number, tx: number, ty: number, parent: Node | null): Node | null => {
      const l = byS.get(s);
      if (!l || tx >= l.nx || ty >= l.ny) return null;
      const span = N * s;
      const n: Node = {
        key: `${s}/${tx}_${ty}`, s, tx, ty, state: 'none', mesh: null, quads: 0, used: 0, children: [], parent,
        box: new THREE.Box3(new THREE.Vector3(tx * span, 0, ty * span), new THREE.Vector3((tx + 1) * span, H, (ty + 1) * span)),
      };
      this.nodes.set(n.key, n);
      if (s > 1) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const c = make(s / 2, tx * 2 + dx, ty * 2 + dy, n);
        if (c) n.children.push(c);
      }
      return n;
    };
    const top = Math.max(...levels.map((l) => l.s)), lt = byS.get(top)!;
    for (let ty = 0; ty < lt.ny; ty++) for (let tx = 0; tx < lt.nx; tx++) this.roots.push(make(top, tx, ty, null)!);
    const nw = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < nw; i++) {
      const w = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<MeshReply>) => this.onMesh(w, e.data);
      this.workers.push(w); this.idle.push(w);
    }
  }

  dispose() {
    this.workers.forEach((w) => w.terminate());
    this.nodes.forEach((n) => { if (n.mesh) n.mesh.geometry.dispose(); });
    this.group.clear();
  }

  private onMesh(w: Worker, r: MeshReply) {
    this.idle.push(w);
    this.pending--;
    const n = this.nodes.get(r.key);
    if (!n) return;
    if (r.type === 'error') { n.state = 'error'; console.warn(r.error); this.pump(); return; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
    g.setAttribute('vattr', new THREE.BufferAttribute(r.attr, 4));
    g.setAttribute('pal', new THREE.BufferAttribute(r.pal, 1));
    g.setIndex(new THREE.BufferAttribute(r.index, 1));
    const span = this.N * n.s;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(span, r.top + 1, span));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(n.tx * span, 0, n.ty * span);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    n.box.max.y = r.top + 1;
    n.mesh = mesh; n.quads = r.quads; n.state = 'ready';
    this.quads += r.quads;
    this.group.add(mesh);
    this.pump();
  }

  private request(n: Node, pri: number) {
    if (n.state !== 'none') return;
    n.state = 'queued';
    (n as Node & { pri: number }).pri = pri;
    this.queue.push(n);
  }

  private pump() {
    if (!this.idle.length || !this.queue.length) return;
    this.queue.sort((a, b) => (a as Node & { pri: number }).pri - (b as Node & { pri: number }).pri);
    while (this.idle.length && this.queue.length) {
      const n = this.queue.shift()!;
      if (n.state !== 'queued') continue;
      n.state = 'loading';
      const w = this.idle.pop()!;
      this.pending++;
      const msg: MeshRequest = { key: n.key, url: new URL(`${this.base}/tiles/${n.key}.bin`, location.href).href, N: this.N, s: n.s };
      w.postMessage(msg);
    }
  }

  get loading() { return this.pending + this.queue.length; }

  update(camera: THREE.PerspectiveCamera, viewportH: number) {
    this.frame++;
    this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);
    const focal = viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const cam = camera.position;
    const draw: Node[] = [];
    // stale requests (the camera moved on) go back to 'none' and are re-requested if still wanted
    for (const n of this.queue) n.state = 'none';
    this.queue.length = 0;
    const visit = (n: Node) => {
      const d = Math.max(1, n.box.distanceToPoint(cam));
      const inView = this.frustum.intersectsBox(n.box);
      if (n.state !== 'ready') { this.request(n, d * (n.s === 8 ? 0 : 1) + (inView ? 0 : 1e6)); return; }
      n.used = this.frame;
      const refine = inView && n.children.length && (n.s * focal) / d > this.err;
      if (refine) {
        let ready = true;
        for (const c of n.children) {
          if (c.state !== 'ready' && c.state !== 'error') { ready = false; this.request(c, Math.max(1, c.box.distanceToPoint(cam)) / n.s); }
        }
        if (ready) { for (const c of n.children) if (c.state === 'ready') visit(c); return; }
      }
      draw.push(n);
    };
    for (const r of this.roots) visit(r);
    for (const n of this.nodes.values()) if (n.mesh) n.mesh.visible = false;
    for (const n of draw) n.mesh!.visible = true;
    const key = draw.map((n) => n.key).join();
    if (key !== this.drawnKey) { this.drawnKey = key; this.version++; }
    this.drawn = draw.reduce((a, n) => a + n.quads, 0);
    if (this.quads > this.budget) this.evict(draw);
    this.pump();
  }

  private evict(draw: Node[]) {
    const keep = new Set(draw);
    const old = [...this.nodes.values()].filter((n) => n.mesh && !keep.has(n) && n.s < 8 && n.used < this.frame)
      .sort((a, b) => a.used - b.used);
    for (const n of old) {
      if (this.quads <= this.budget * 0.8) break;
      this.group.remove(n.mesh!);
      n.mesh!.geometry.dispose();
      n.mesh = null; n.state = 'none'; this.quads -= n.quads; n.quads = 0;
    }
  }
}
