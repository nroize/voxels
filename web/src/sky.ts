// The sun over the city (NOAA's approximation, good to a fraction of a degree), the sky dome, and the light colours
// for a given local time in Israel.
import * as THREE from 'three';

const RAD = Math.PI / 180;

/** UTC offset of Asia/Jerusalem on that day, in hours (+2 winter, +3 summer) */
function israelOffset(date: Date) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', timeZoneName: 'shortOffset' }).format(date);
  const m = s.match(/GMT([+-]\d+)/);
  return m ? Number(m[1]) : 2;
}

/** sun azimuth (degrees from north, clockwise) and elevation (degrees) for a local hour on day-of-year `doy` */
export function sunPosition(lat: number, lon: number, doy: number, hour: number, year = 2026) {
  const noonUTC = new Date(Date.UTC(year, 0, 1, 12) + (doy - 1) * 86400e3);
  const tz = israelOffset(noonUTC);
  const g = (2 * Math.PI / 365) * (doy - 1 + (hour - tz - 12) / 24);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = (hour - tz) * 60 + eqt + 4 * lon;
  const ha = (tst / 4 - 180) * RAD;
  const phi = lat * RAD;
  const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  let az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / RAD + 180;
  az = (az + 360) % 360;
  return { az, el: 90 - zen / RAD };
}

/** direction towards the sun in scene axes (x = map right, y = up, z = map down), for a map rotated theta clockwise */
export function sunVector(az: number, el: number, theta: number) {
  const E = Math.cos(el * RAD) * Math.sin(az * RAD), N = Math.cos(el * RAD) * Math.cos(az * RAD), U = Math.sin(el * RAD);
  const c = Math.cos(theta * RAD), s = Math.sin(theta * RAD);
  const x = E * c - N * s, up = E * s + N * c;
  return new THREE.Vector3(x, U, -up).normalize();
}

const lerp3 = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** colours for a sun elevation: zenith, horizon, sun light (linear rgb), intensities */
export function lighting(el: number) {
  const day = smooth(-4, 14, el);          // 0 night .. 1 full day
  const gold = smooth(-5, 2, el) * (1 - smooth(4, 22, el)); // the golden hour
  const night = 1 - smooth(-9, 1, el);
  const zenDay = [0.20, 0.42, 0.78], zenNight = [0.012, 0.018, 0.05], zenGold = [0.26, 0.32, 0.55];
  const horDay = [0.66, 0.78, 0.9], horNight = [0.04, 0.05, 0.1], horGold = [1.0, 0.62, 0.38];
  let zen = lerp3(zenNight, zenDay, day), hor = lerp3(horNight, horDay, day);
  zen = lerp3(zen, zenGold, gold * 0.6); hor = lerp3(hor, horGold, gold * 0.85);
  const sun = lerp3([1.0, 0.97, 0.92], [1.0, 0.56, 0.3], gold);
  return {
    zenith: new THREE.Color(...zen as [number, number, number]),
    horizon: new THREE.Color(...hor as [number, number, number]),
    sun: new THREE.Color(...sun as [number, number, number]),
    sunI: 3.8 * smooth(-2, 6, el) * (0.75 + 0.25 * day),
    hemiI: 0.22 + 0.62 * day + 0.2 * smooth(-12, -3, el) * (1 - day),
    night,
  };
}

export function skyDome() {
  const geo = new THREE.SphereGeometry(40000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, transparent: true,
    uniforms: { zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() }, night: { value: 0 }, sunDisc: { value: 1 }, stars: { value: 1 }, over: { value: 1 } },
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: `uniform vec3 zenith, horizon, sunDir, sunCol; uniform float night, sunDisc, stars, over; varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main() {
        float h = clamp(vDir.y, -0.2, 1.0);
        vec3 c = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
        if (h < 0.0) c = mix(horizon, horizon * 0.7, -h * 5.0);
        float sd = max(dot(normalize(vDir), sunDir), 0.0);
        c += sunCol * (pow(sd, 900.0) * 6.0 * sunDisc + pow(sd, 12.0) * 0.25 * (0.3 + 0.7 * sunDisc)) * (1.0 - night);
        vec3 q = floor(normalize(vDir) * 420.0);
        float st = step(0.9985, hash(q)) * night * stars * smoothstep(0.05, 0.3, h);
        c += vec3(st) * 0.9;
        // over: how much of this gradient covers the physical sky beneath (all of it at night and when grey)
        gl_FragColor = vec4(c, clamp(over + st, 0.0, 1.0));
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = -1;
  return { mesh: m, uniforms: mat.uniforms };
}

/** share of windows lit, by hour (a weekday evening in a residential city) */
export function litShare(hour: number) {
  const pts: [number, number][] = [[0, 0.16], [2, 0.07], [5, 0.05], [6.5, 0.18], [8, 0.12], [17, 0.18], [19, 0.42], [21, 0.5], [23, 0.32], [24, 0.16]];
  for (let i = 1; i < pts.length; i++) {
    if (hour <= pts[i][0]) { const [h0, v0] = pts[i - 1], [h1, v1] = pts[i]; return v0 + (v1 - v0) * (hour - h0) / (h1 - h0); }
  }
  return 0.16;
}
