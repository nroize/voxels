// Weather: presets that blend into each other over a couple of seconds, applied on top of the time of day: the cloud
// layer (drawn by clouds.ts), rain streaks around the camera, wet streets (material.ts uWet), fog, the hamsin's
// dust, lightning. "Now" reads the current weather from Open-Meteo.
import * as THREE from 'three';

export interface WeatherState {
  cloud: number;   // coverage of the cloud layer, 0..1 (clouds.ts)
  base: number;    // cloud base, m above the map's base
  thick: number;   // layer thickness, m (a thunderstorm's towers are kilometres tall)
  scale: number;   // size of the cloud features, m
  dark: number;    // cloud albedo, 0 white .. 1 storm grey
  ridge: number;   // 0 separate clouds .. 1 clouds joined in a network round holes
  dim: number;     // sun light kept, on top of the clouds' own shadows, 0..1
  grey: number;    // sky and light washed towards grey, 0..1
  haze: number;    // 0 clear air .. 1 thick fog
  rain: number;    // 0..1
  wet: number;     // streets wet, 0..1
  dust: number;    // the hamsin: a yellow-brown haze, 0..1
  storm: number;   // lightning, 0..1
}

const LAYER = { base: 1100, thick: 450, scale: 2600, dark: 0, ridge: 0 };
export const PRESETS: Record<string, { label: string; s: WeatherState }> = {
  clear: { label: 'Clear', s: { ...LAYER, cloud: 0, dim: 1, grey: 0, haze: 0, rain: 0, wet: 0, dust: 0, storm: 0 } },
  partly: { label: 'Partly cloudy', s: { ...LAYER, cloud: 0.32, base: 1000, thick: 520, scale: 1900, dark: 0.04, dim: 1, grey: 0.05, haze: 0.05, rain: 0, wet: 0, dust: 0, storm: 0 } },
  overcast: { label: 'Overcast', s: { ...LAYER, cloud: 0.52, base: 760, thick: 420, scale: 1700, ridge: 0.7, dark: 0.3, dim: 0.8, grey: 0.6, haze: 0.22, rain: 0, wet: 0, dust: 0, storm: 0 } },
  rain: { label: 'Rain', s: { ...LAYER, cloud: 0.54, base: 560, thick: 520, scale: 2000, ridge: 0.55, dark: 0.5, dim: 0.65, grey: 0.8, haze: 0.42, rain: 0.7, wet: 1, dust: 0, storm: 0 } },
  storm: { label: 'Thunderstorm', s: { ...LAYER, cloud: 0.49, base: 600, thick: 1500, scale: 2400, dark: 0.75, dim: 0.5, grey: 0.9, haze: 0.5, rain: 1, wet: 1, dust: 0, storm: 1 } },
  fog: { label: 'Fog', s: { ...LAYER, cloud: 0.15, base: 900, thick: 300, dim: 0.5, grey: 0.6, haze: 1, rain: 0, wet: 0.25, dust: 0, storm: 0 } },
  hamsin: { label: 'Hamsin (dust)', s: { ...LAYER, cloud: 0, dim: 0.55, grey: 0.2, haze: 0.75, rain: 0, wet: 0, dust: 1, storm: 0 } },
};

// the cloud layer's shape is never blended (sweeping the coverage would grow the clouds cell by cell): it switches
// while the clouds are faded out, and `fade` brings them in. The rest (light, haze, rain) blends
const SHAPE: (keyof WeatherState)[] = ['cloud', 'base', 'thick', 'scale', 'ridge', 'dark'];
const KEYS = (Object.keys(PRESETS.clear.s) as (keyof WeatherState)[]).filter((k) => !SHAPE.includes(k));
const GREY = new THREE.Color(0.62, 0.65, 0.69), DUST = new THREE.Color(0.8, 0.6, 0.36);

export class Weather {
  state: WeatherState = { ...PRESETS.clear.s };
  private target: WeatherState = { ...PRESETS.clear.s };
  fade = 0; // the clouds' opacity, 0..1
  rain: THREE.LineSegments;
  flash = 0;
  flashPos = new THREE.Vector3();
  wind = new THREE.Vector2();
  private nextFlash = 3;
  private rainU: { uTime: { value: number }; uCam: { value: THREE.Vector3 }; uRain: { value: number }; uCol: { value: THREE.Color } };

  constructor(scene: THREE.Scene) {
    const rng = mulberry(7);
    // rain: short faint streaks in a 120 m box round the camera, fading in past 6 m and out by 60 m, so they read
    // as rain in the air and never as streaks on the lens (from afar the rain shafts in clouds.ts carry it)
    const n = 12000, pos = new Float32Array(n * 6), seed = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = rng() * 120 - 60, y = rng() * 120, z = rng() * 120 - 60;
      pos.set([x, y, z, x, y, z], i * 6);
      seed[i * 2] = 0; seed[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('end', new THREE.BufferAttribute(seed, 1));
    this.rainU = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uRain: { value: 0 }, uCol: { value: new THREE.Color(0.78, 0.83, 0.9) } };
    this.rain = new THREE.LineSegments(g, new THREE.ShaderMaterial({
      uniforms: this.rainU, transparent: true, depthWrite: false,
      vertexShader: `attribute float end; uniform float uTime, uRain; uniform vec3 uCam; varying float vA;
        void main() {
          // fixed in the world, wrapping round the camera, so drops fall past you rather than with you
          vec3 p;
          p.xz = uCam.xz + mod(position.xz - uCam.xz + 60.0, 120.0) - 60.0;
          p.y = uCam.y - 60.0 + mod(position.y - uTime * 26.0 - uCam.y + 60.0, 120.0);
          p.x += end * 0.1;
          p.y += end * 1.4;
          float d = distance(p, cameraPosition);
          vA = step(fract(dot(position.xz, vec2(0.13, 0.17)) * 7.31), uRain) * smoothstep(6.0, 14.0, d) * (1.0 - smoothstep(35.0, 60.0, d));
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `uniform vec3 uCol; varying float vA; void main() { if (vA < 0.01) discard; gl_FragColor = vec4(uCol, 0.4 * vA); }`,
    }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);
  }

  set(name: string) {
    const p = PRESETS[name];
    if (p) this.target = { ...p.s };
  }

  setState(s: WeatherState) { this.target = { ...s }; }

  /** rain catches the light of the sky around it: bright by day, barely visible at night */
  rainColour(horizon: THREE.Color, night: number) {
    this.rainU.uCol.value.copy(horizon).multiplyScalar(1.25).lerp(new THREE.Color(0.55, 0.45, 0.35), night * 0.5);
  }

  /** jump to the target at once (on load) */
  snap() { this.state = { ...this.target }; this.fade = this.state.cloud > 0 ? 1 : 0; }

  /** true while still blending */
  update(dt: number, t: number, camera: THREE.Camera, focus: THREE.Vector3) {
    let moving = false;
    const k = 1 - Math.exp(-dt * 1.6);
    for (const key of KEYS) {
      const d = this.target[key] - this.state[key];
      if (Math.abs(d) > 0.002) { this.state[key] += d * k; moving = true; } else this.state[key] = this.target[key];
    }
    // clouds: fade out, change shape, fade back in (about a second each way)
    const same = SHAPE.every((key) => Math.abs(this.state[key] - this.target[key]) < 1e-6);
    if (!same && this.fade < 0.01) { for (const key of SHAPE) this.state[key] = this.target[key]; }
    const want = same && this.state.cloud > 0 ? 1 : 0;
    if (this.fade !== want) {
      this.fade = want > this.fade ? Math.min(want, this.fade + dt / 1.2) : Math.max(want, this.fade - dt / 1.0);
      moving = true;
    }
    const s = this.state;
    // the clouds drift in from the sea on the westerly, ~4 m/s
    this.wind.set(t * 4, t * 0.7);
    this.rain.visible = s.rain > 0.01;
    this.rainU.uTime.value = t;
    this.rainU.uRain.value = s.rain;
    this.rainU.uCam.value.copy(camera.position);
    // lightning: a flash every few seconds in a storm
    this.flash = Math.max(0, this.flash - dt * 5);
    if (s.storm > 0.5) {
      this.nextFlash -= dt;
      if (this.nextFlash < 0) {
        // somewhere in the clouds within a few kilometres of what you look at
        this.flash = 1; this.nextFlash = 2 + Math.random() * 7;
        const a = Math.random() * Math.PI * 2, r = 400 + Math.random() * 2500;
        this.flashPos.set(focus.x + Math.cos(a) * r, s.base + s.thick * (0.15 + Math.random() * 0.4), focus.z + Math.sin(a) * r);
      }
    }
    return moving || this.flash > 0;
  }

  /** the weather over the lights and colours of the time of day */
  apply(L: { zenith: THREE.Color; horizon: THREE.Color; sun: THREE.Color; sunI: number; hemiI: number; night: number }) {
    const s = this.state;
    const grey = GREY.clone().multiplyScalar(0.25 + 0.75 * (1 - L.night));
    const zenith = L.zenith.clone().lerp(grey, s.grey).lerp(DUST.clone().multiplyScalar(0.8), s.dust * 0.7);
    const horizon = L.horizon.clone().lerp(grey.clone().multiplyScalar(1.1), Math.max(s.grey, s.haze * 0.8)).lerp(DUST.clone().multiplyScalar(1 - 0.7 * L.night), s.dust * 0.85);
    const sun = L.sun.clone().lerp(new THREE.Color(1, 0.62, 0.32), s.dust * 0.7);
    const f = this.flash * s.storm;
    return {
      zenith, horizon, sun,
      sunI: L.sunI * s.dim,
      hemiI: L.hemiI * (1 + 0.25 * s.grey - 0.15 * s.dust) + f * 2.5,
      fogNear: 2500 * (1 - s.haze) + 40,
      fogFar: 16000 * Math.pow(1 - s.haze * 0.92, 2) + 700,
      sunDisc: 1 - Math.min(1, s.cloud * this.fade * 1.2 + s.haze * 0.5),
      stars: 1 - Math.min(1, s.cloud * this.fade * 1.5 + s.haze),
      flash: f,
    };
  }
}

/** WMO weather code and cloud cover from Open-Meteo -> a state */
export async function liveWeather(lat: number, lon: number): Promise<{ state: WeatherState; text: string }> {
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code,cloud_cover,precipitation,visibility&timezone=Asia%2FJerusalem`);
  const c = (await r.json()).current;
  const code: number = c.weather_code, cover = (c.cloud_cover ?? 0) / 100;
  let name = 'clear';
  if (code >= 95) name = 'storm';
  else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) name = 'rain';
  else if (code === 45 || code === 48) name = 'fog';
  else if (code === 3 || cover > 0.8) name = 'overcast';
  else if (code >= 1 || cover > 0.2) name = 'partly';
  const s = { ...PRESETS[name].s };
  if (name === 'partly' || name === 'clear') { s.cloud = cover; s.dim = 1 - cover * 0.5; s.grey = cover * 0.3; }
  if (c.visibility != null && c.visibility < 5000 && name !== 'fog') { s.haze = Math.max(s.haze, 1 - c.visibility / 5000); }
  return { state: s, text: `${PRESETS[name].label.toLowerCase()}, ${Math.round(cover * 100)}% cloud` };
}

function mulberry(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
