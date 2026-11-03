// Place names over the map: the best-known first, each from as far as its score allows, never overlapping.
import * as THREE from 'three';

export interface Label {
  name: string; he?: string; kind: string; x: number; y: number; z: number; score: number; height?: number; place?: boolean;
}

export class Labels {
  el: HTMLDivElement;
  items: { l: Label; div: HTMLDivElement; p: THREE.Vector3; far: number; w: number; h: number }[] = [];
  enabled = true;
  private v = new THREE.Vector3();

  constructor(parent: HTMLElement, labels: Label[]) {
    this.el = document.createElement('div');
    this.el.className = 'labels';
    parent.appendChild(this.el);
    for (const l of [...labels].sort((a, b) => b.score - a.score)) {
      const div = document.createElement('div');
      div.className = 'label' + (l.place ? ' place' : '');
      const he = l.he && l.he !== l.name ? `<span class="he" dir="rtl">${esc(l.he)}</span>` : '';
      div.innerHTML = `<span class="en">${esc(l.name)}</span>${he}`;
      this.el.appendChild(div);
      const far = l.place ? 2600 : 250 + l.score * 260;
      this.items.push({ l, div, p: new THREE.Vector3(l.x, l.z + (l.place ? 30 : 6), l.y), far, w: 0, h: 0 });
    }
  }

  update(camera: THREE.PerspectiveCamera, W: number, H: number) {
    this.el.style.display = this.enabled ? '' : 'none';
    if (!this.enabled) return;
    const taken: [number, number, number, number][] = [];
    let shown = 0;
    for (const it of this.items) {
      const d = camera.position.distanceTo(it.p);
      this.v.copy(it.p).project(camera);
      const vis = d < it.far && this.v.z < 1 && Math.abs(this.v.x) < 1.05 && Math.abs(this.v.y) < 1.05 && shown < 30;
      if (!vis) { it.div.style.display = 'none'; continue; }
      it.div.style.display = '';
      if (!it.w) { it.w = it.div.offsetWidth; it.h = it.div.offsetHeight; }
      const x = (this.v.x * 0.5 + 0.5) * W, y = (-this.v.y * 0.5 + 0.5) * H;
      const r: [number, number, number, number] = [x - it.w / 2 - 4, y - it.h - 4, x + it.w / 2 + 4, y + 4];
      if (taken.some((t) => r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1])) { it.div.style.display = 'none'; continue; }
      taken.push(r);
      shown++;
      it.div.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      it.div.style.opacity = String(Math.min(1, (it.far - d) / (it.far * 0.25)));
    }
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
