// Address and place search over search.json (scripts/search.py), in Hebrew or English: "Dizengoff 50",
// "דיזנגוף 50", "50 Dizengoff St", "Habima". OSM maps few house numbers, so a number that is not mapped is placed
// along the street between the mapped ones on the same side (odd or even) and marked approximate.

export interface Building {
  osm: string; name: string | null; he: string | null; kind: string | null; addr: string | null;
  h: number; src: string; levels: number | null; box: [number, number, number, number]; z0: number; z1: number;
}
export interface Hit {
  label: string; sub: string; x: number; y: number; building: number; exact: boolean; zoom: number;
}
interface Street { he: string; en: string | null; lines: [number, number][][] }
interface Index { streets: Street[]; addrs: [string, string, number, number, number][]; places: [string, string | null, string, number, number, number][] }

const STRIP = new Set(['street', 'st', 'str', 'rd', 'road', 'blvd', 'boulevard', 'ave', 'avenue', 'sderot', 'rehov', 'rechov',
  'רחוב', 'רח', 'שדרות', 'שד', 'שדרת', 'סמטת', 'סמ']);

export function norm(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[֑-ׇ̀-ͯ]/g, '')
    .replace(/["'׳״`´.,\-–()/]/g, ' ').replace(/\s+/g, ' ').trim();
}
const key = (s: string) => norm(s).split(' ').filter((w) => !STRIP.has(w)).join(' ');
const NUM = /^(\d+)([א-תa-z]?)$/;

export class Search {
  buildings: (Building | null)[] = [];
  private streets: (Street & { keys: string[] })[] = [];
  private addrs = new Map<string, { n: number; raw: string; x: number; y: number; g: number }[]>();
  private places: { en: string; he: string | null; kind: string; x: number; y: number; g: number; keys: string[] }[] = [];

  static async load(base: string) {
    const [idx, bl]: [Index, { keys: string[]; rows: (unknown[] | null)[] }] = await Promise.all([
      fetch(`${base}/search.json`).then((r) => r.json()), fetch(`${base}/buildings.json`).then((r) => r.json())]);
    const s = new Search();
    s.buildings = bl.rows.map((r) => r && Object.fromEntries(bl.keys.map((k, i) => [k, r[i]])) as unknown as Building);
    s.streets = idx.streets.map((st) => ({ ...st, keys: [key(st.he), st.en ? key(st.en) : ''].filter(Boolean) }));
    for (const [st, num, x, y, g] of idx.addrs) {
      const m = num.trim().match(NUM);
      const k = key(st);
      if (!s.addrs.has(k)) s.addrs.set(k, []);
      s.addrs.get(k)!.push({ n: m ? Number(m[1]) : NaN, raw: norm(num), x, y, g });
    }
    s.places = idx.places.map(([en, he, kind, x, y, g]) => ({ en, he, kind, x, y, g, keys: [norm(en), he ? norm(he) : ''].filter(Boolean) }));
    return s;
  }

  query(q: string, limit = 8): Hit[] {
    const words = norm(q).split(' ').filter(Boolean);
    if (!words.length) return [];
    // a house number at either end ("Dizengoff 50", "50 Dizengoff")
    let num: string | null = null;
    if (words.length > 1 && NUM.test(words[words.length - 1])) num = words.pop()!;
    else if (words.length > 1 && NUM.test(words[0])) num = words.shift()!;
    const sq = words.filter((w) => !STRIP.has(w)).join(' ');
    if (sq.length < 2) return [];
    const out: (Hit & { score: number })[] = [];
    const score = (keys: string[]) => {
      let best = 0;
      for (const k of keys) {
        if (k === sq) best = Math.max(best, 4);
        else if (k.startsWith(sq)) best = Math.max(best, 3);
        else if (k.split(' ').some((w) => w.startsWith(sq))) best = Math.max(best, 2.5);
        else if (k.includes(sq)) best = Math.max(best, 1.5);
      }
      return best;
    };
    for (const st of this.streets) {
      const sc = score(st.keys);
      if (!sc) continue;
      const name = st.en ?? st.he, he = st.en ? st.he : '';
      if (num) {
        const hit = this.address(st, num);
        if (hit) { out.push({ ...hit, score: sc + (hit.exact ? 10 : 6) }); continue; }
      }
      const mid = midpoint(st.lines[0]);
      out.push({ label: name, sub: [he, num ? `street · number ${num} not mapped` : 'street'].filter(Boolean).join(' · '),
        x: mid[0], y: mid[1], building: 0, exact: !num, zoom: 420, score: sc + (num ? 2 : 0) });
    }
    if (!num) {
      for (const p of this.places) {
        const sc = score(p.keys);
        if (!sc) continue;
        const b = p.g ? this.buildings[p.g] : null;
        out.push({ label: p.en, sub: [p.he, p.kind.replace(/_/g, ' '), b?.addr].filter(Boolean).join(' · '), x: p.x, y: p.y,
          building: p.g, exact: true, zoom: p.g ? 200 : 300, score: sc + 0.6 + (p.g ? 0.2 : 0) });
      }
    }
    out.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const found = num && out.some((h) => h.building);
    return out.filter((h) => !(found && !h.building)).filter((h) => { const k = h.label + h.sub; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
  }

  /** an exact mapped address, or one placed between the mapped numbers of that street */
  private address(st: Street & { keys: string[] }, num: string): Hit | null {
    const list = st.keys.flatMap((k) => this.addrs.get(k) ?? []);
    const name = `${st.en ?? st.he} ${num}`, he = st.en ? `${st.he} ${num}` : '';
    const exact = list.find((a) => a.raw === num) ?? list.find((a) => a.n === Number(num.match(NUM)?.[1]));
    if (exact && exact.raw === num) {
      return { label: name, sub: [he, 'address'].filter(Boolean).join(' · '), x: exact.x, y: exact.y, building: exact.g, exact: true, zoom: 200 };
    }
    const n = Number(num.match(NUM)?.[1]);
    const anchors = list.filter((a) => Number.isFinite(a.n));
    if (!Number.isFinite(n) || anchors.length < 2) return null;
    // the street piece the anchors are on; their positions along it and the side they are on
    const line = st.lines.reduce((best, l) => {
      const c = anchors.filter((a) => project(l, a.x, a.y).d < 40).length;
      return c > best.c ? { l, c } : best;
    }, { l: st.lines[0], c: -1 }).l;
    const pts = anchors.map((a) => ({ ...a, ...project(line, a.x, a.y) })).filter((a) => a.d < 60);
    const same = pts.filter((a) => a.n % 2 === n % 2);
    const use = same.length >= 2 ? same : pts;
    if (use.length < 2) return null;
    use.sort((a, b) => a.n - b.n);
    let lo = use[0], hi = use[use.length - 1];
    for (const a of use) { if (a.n <= n) lo = a; }
    for (let i = use.length - 1; i >= 0; i--) if (use[i].n >= n) hi = use[i];
    if (n < use[0].n - 8 || n > use[use.length - 1].n + 8) return null; // too far beyond the mapped numbers to guess
    if (lo === hi) { // just beyond the mapped range: extend from the two nearest
      const i = use.indexOf(lo);
      [lo, hi] = i === 0 ? [use[0], use[1]] : [use[i - 1], use[i]];
    }
    if (hi.n === lo.n) return null;
    const t = (n - lo.n) / (hi.n - lo.n);
    const s = Math.max(0, Math.min(length(line), lo.s + (hi.s - lo.s) * t));
    const side = same.length ? Math.sign(same.reduce((a, p) => a + p.side, 0)) || 1 : 1;
    const off = same.length ? same.reduce((a, p) => a + p.d, 0) / same.length : 12;
    const [x, y, nx, ny] = along(line, s);
    const px = x + nx * side * off, py = y + ny * side * off;
    const g = this.nearestBuilding(px, py, 30);
    const c = g ? centre(this.buildings[g]!) : [px, py];
    return { label: `≈ ${name}`, sub: [he, `approximate, between ${lo.n} and ${hi.n}`].filter(Boolean).join(' · '), x: c[0], y: c[1], building: g, exact: false, zoom: 220 };
  }

  /** an address for a spot with none in OSM: the nearest street, and a house number interpolated from the
   * numbers mapped on the same side of it (null where the street has too few) */
  reverse(x: number, y: number): { street: string; he: string; num: number | null } | null {
    let best: { st: Street & { keys: string[] }; line: [number, number][]; p: ReturnType<typeof project> } | null = null;
    for (const st of this.streets) {
      for (const line of st.lines) {
        const p = project(line, x, y);
        if (p.d < 45 && (!best || p.d < best.p.d)) best = { st, line, p };
      }
    }
    if (!best) return null;
    const { st, line, p } = best;
    const anchors = st.keys.flatMap((k) => this.addrs.get(k) ?? []).filter((a) => Number.isFinite(a.n))
      .map((a) => ({ ...a, ...project(line, a.x, a.y) })).filter((a) => a.d < 60 && a.side === p.side);
    let num: number | null = null;
    if (anchors.length >= 2) {
      anchors.sort((a, b) => a.s - b.s);
      let i = anchors.findIndex((a) => a.s >= p.s);
      if (i <= 0) i = i === 0 ? 1 : anchors.length - 1;
      const a = anchors[i - 1], b = anchors[i];
      if (b.s !== a.s && a.n !== b.n) {
        const n = a.n + (b.n - a.n) * (p.s - a.s) / (b.s - a.s);
        const odd = anchors.filter((q) => q.n % 2).length > anchors.length / 2;
        num = Math.max(1, Math.round((n - (odd ? 1 : 0)) / 2) * 2 + (odd ? 1 : 0));
      }
    }
    return { street: st.en ?? st.he, he: st.he, num };
  }

  /** "מנחם בגין 121" -> "Menachem Begin 121" where the street has an English name in OSM */
  english(addr: string) {
    const m = addr.match(/^(.*\S)\s+(\S+)$/);
    if (!m) return null;
    const k = key(m[1]);
    const st = this.streets.find((x) => x.keys[0] === k);
    return st?.en ? `${st.en} ${m[2]}` : null;
  }

  nearestBuilding(x: number, y: number, max: number) {
    let best = 0, bd = max;
    this.buildings.forEach((b, i) => {
      if (!b) return;
      const [x0, y0, x1, y1] = b.box;
      const d = Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
}

export const centre = (b: Building) => [(b.box[0] + b.box[2]) / 2, (b.box[1] + b.box[3]) / 2];

function length(l: [number, number][]) {
  let s = 0;
  for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
  return s;
}

function midpoint(l: [number, number][]) { const [x, y] = along(l, length(l) / 2); return [x, y]; }

/** point at arc length s, with the unit normal to the left */
function along(l: [number, number][], s: number): [number, number, number, number] {
  for (let i = 1; i < l.length; i++) {
    const [ax, ay] = l[i - 1], [bx, by] = l[i];
    const L = Math.hypot(bx - ax, by - ay);
    if (s <= L || i === l.length - 1) {
      const t = L ? Math.min(1, s / L) : 0;
      return [ax + (bx - ax) * t, ay + (by - ay) * t, -(by - ay) / (L || 1), (bx - ax) / (L || 1)];
    }
    s -= L;
  }
  return [l[0][0], l[0][1], 0, 1];
}

/** arc length of the nearest point, distance, and side (+1 left of travel, -1 right) */
function project(l: [number, number][], x: number, y: number) {
  let best = { s: 0, d: Infinity, side: 1 }, acc = 0;
  for (let i = 1; i < l.length; i++) {
    const [ax, ay] = l[i - 1], [bx, by] = l[i];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    const px = ax + dx * t, py = ay + dy * t, d = Math.hypot(x - px, y - py);
    if (d < best.d) best = { s: acc + t * Math.sqrt(L2), d, side: Math.sign(dx * (y - ay) - dy * (x - ax)) || 1 };
    acc += Math.sqrt(L2);
  }
  return best;
}
