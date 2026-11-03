// Clouds: a layer of 20 m voxels ray-traced per pixel (a post-processing effect, so they sit behind the city where
// the depth buffer says so). Which cells are cloud comes from a coverage map (tileable 2D noise, drifting with the
// wind) shaped by a 3D detail noise and the height in the layer: a little coverage gives scattered cumulus, full
// coverage a deck with a lumpy base, a thick dark layer the towers of a thunderstorm. Under rain the same map draws
// grey shafts down to the ground. The voxel material reads the same map for the clouds' shadows (CLOUD_GLSL).
import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

/** a tileable fractal value noise, size^dims cells in 0..255 */
function noise(size: number, dims: 2 | 3, octaves: number, seed: number) {
  let a = seed | 0;
  const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = size ** dims, out = new Float32Array(n);
  let amp = 1, tot = 0;
  for (let o = 0; o < octaves; o++) {
    const g = Math.max(2, (4 << o)), lat = new Float32Array(g ** dims).map(rnd);
    const at = (x: number, y: number, z: number) => lat[((z % g) * g + (y % g)) * g + (x % g)];
    const s = (t: number) => t * t * (3 - 2 * t);
    for (let i = 0; i < n; i++) {
      const x = (i % size) / size * g, y = (Math.floor(i / size) % size) / size * g, z = dims === 3 ? Math.floor(i / size / size) / size * g : 0;
      const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z), fx = s(x - x0), fy = s(y - y0), fz = s(z - z0);
      const l = (zz: number) => {
        const a0 = at(x0, y0, zz) + (at(x0 + 1, y0, zz) - at(x0, y0, zz)) * fx;
        const a1 = at(x0, y0 + 1, zz) + (at(x0 + 1, y0 + 1, zz) - at(x0, y0 + 1, zz)) * fx;
        return a0 + (a1 - a0) * fy;
      };
      out[i] += (dims === 3 ? l(z0) + (l(z0 + 1) - l(z0)) * fz : l(0)) * amp;
    }
    tot += amp; amp *= 0.5;
  }
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = Math.round((out[i] / tot) * 255);
  return data;
}

export function cloudTextures() {
  const w = new THREE.DataTexture(noise(256, 2, 5, 11), 256, 256, THREE.RedFormat, THREE.UnsignedByteType);
  w.wrapS = w.wrapT = THREE.RepeatWrapping; w.magFilter = w.minFilter = THREE.LinearFilter; w.needsUpdate = true;
  const d = new THREE.Data3DTexture(noise(32, 3, 3, 5), 32, 32, 32);
  d.format = THREE.RedFormat; d.type = THREE.UnsignedByteType;
  d.wrapS = d.wrapT = d.wrapR = THREE.RepeatWrapping; d.magFilter = d.minFilter = THREE.LinearFilter; d.needsUpdate = true;
  return { weather: w, detail: d };
}

/** the uniforms the clouds and the voxel material share */
export function cloudUniforms(tex: ReturnType<typeof cloudTextures>) {
  return {
    tWeather: { value: tex.weather }, tDetail: { value: tex.detail },
    uCover: { value: 0 }, uBase: { value: 1100 }, uThick: { value: 450 }, uScale: { value: 2600 }, uRidge: { value: 0 }, uFade: { value: 1 },
    uWind: { value: new THREE.Vector2() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  };
}

/** coverage of the sky above (x, z), 0..1: shared with the voxel material for the shadows */
export const CLOUD_GLSL = /* glsl */ `
  uniform sampler2D tWeather;
  uniform float uCover, uBase, uThick, uScale, uRidge, uFade;
  uniform vec2 uWind;
  uniform vec3 uSunDir;
  // the field lives in "cloud space", which drifts with the wind (q = world - wind): the voxel grid moves with it,
  // so the clouds sail past as rigid blocks instead of cells flickering on and off at their edges
  // two octaves at unrelated scales over a warped domain, so the 256-texel tile never shows as a repeat; uRidge mixes
  // in ridges (one minus the folded noise), which join the clouds into a network round holes, like closed-cell
  // stratocumulus
  float weatherQ(vec2 q) {
    q += (texture(tWeather, q / (uScale * 1.73)).r - 0.5) * vec2(1.0, -0.7) * uScale * 0.7;
    float n = texture(tWeather, q / uScale).r * 0.68 + texture(tWeather, q / (uScale * 0.29) + 0.37).r * 0.32;
    if (uRidge > 0.001) {
      float r = pow(1.0 - abs(texture(tWeather, q / (uScale * 0.6) + 0.21).r * 2.0 - 1.0), 5.0);
      n = mix(n, max(n, r * 0.62 + n * 0.25), uRidge);
    }
    return n;
  }
  float coverQ(vec2 q) { return smoothstep(1.0 - uCover - 0.02, 1.0 - uCover + 0.26, weatherQ(q)); }
  float weatherAt(vec2 xz) { return weatherQ(xz - uWind); }
  float coverAt(vec2 xz) { return coverQ(xz - uWind); }
  // the share of sunlight the clouds let through to a point
  float cloudShadow(vec3 w) {
    if (uCover < 0.001) return 1.0;
    float t = (uBase + uThick * 0.3 - w.y) / max(uSunDir.y, 0.08);
    float c = coverAt(w.xz + uSunDir.xz * t);
    return 1.0 - c * 0.85 * uFade;
  }
`;

// the march, drawn at half resolution into a buffer of (premultiplied colour, opacity)
const MARCH = /* glsl */ `
  uniform sampler2D tDepth;
  uniform sampler3D tDetail;
  uniform mat4 uInvProj, uCamWorld;
  uniform vec3 uCamPos, uSunCol, uAmb, uFogCol, uGlow, uFlashPos;
  uniform float uDark, uRain, uFlash, uFogDist, uNight;
  varying vec2 vUv;
  ${CLOUD_GLSL}
  const float S = 20.0; // cell size, metres

  void main() {
    float depth = texture(tDepth, vUv).r;
    vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec3 wp = (uCamWorld * vec4(vp.xyz / vp.w, 1.0)).xyz;
    vec3 ro = uCamPos, rd = normalize(wp - ro);
    float tScene = depth >= 0.99999 ? 1e6 : length(wp - ro);
    float b0 = uBase, b1 = uBase + uThick;
    vec3 veil = vec3(0.0);
    float aV = 0.0;

    // rain shafts: grey veils under the wettest clouds, between the camera and whatever the ray meets
    if (uRain > 0.01 && uCover > 0.01) {
      float tEnd = min(tScene, 6000.0);
      if (rd.y > 0.0 && ro.y < b0) tEnd = min(tEnd, (b0 - ro.y) / rd.y);
      float acc = 0.0;
      float t0 = (ro.y > b0 && rd.y < 0.0) ? (b0 - ro.y) / rd.y : 0.0;
      if (tEnd > t0) {
        float dt = (tEnd - t0) / 8.0;
        for (int i = 0; i < 8; i++) {
          vec3 p = ro + rd * (t0 + dt * (float(i) + 0.5));
          // a light veil everywhere it rains, dense shafts under the heart of the cells (the top of the noise)
          float shaft = smoothstep(0.62, 0.7, weatherAt(p.xz)) * smoothstep(0.5, 0.7, texture(tWeather, (p.xz - uWind) / (uScale * 0.45) + 0.7).r);
          if (p.y < b0) acc += (0.1 + shaft * 0.9) * dt;
        }
      }
      aV = min(0.6, 1.0 - exp(-acc * 0.00016 * uRain));
      veil = uFogCol * mix(0.85, 0.5, uDark) * aV;
    }

    float tA = 0.0, tB = -1.0;
    if (uCover > 0.001) {
      if (abs(rd.y) < 1e-4) { if (ro.y >= b0 && ro.y <= b1) tB = 10000.0; }
      else { float ta = (b0 - ro.y) / rd.y, tb = (b1 - ro.y) / rd.y; tA = max(min(ta, tb), 0.0); tB = min(max(ta, tb), 10000.0); }
      tB = min(tB, tScene);
    }
    float alpha = 0.0;
    vec3 acc = vec3(0.0);
    if (tA < tB) {
      // voxel traversal (Amanatides & Woo) from where the ray enters the layer. The cells double in size every 32
      // steps (20, 40, 80, 160 m), so 128 steps reach ~10 km; the shapes are sampled at the same world scales at
      // every size, so far clouds are only blockier, never different
      vec3 stp = sign(rd), inv = 1.0 / max(abs(rd), vec3(1e-6));
      vec3 wind = vec3(uWind.x, 0.0, uWind.y);
      ro -= wind; // from here on, cloud space
      float SL = S, t = tA + 0.05;
      vec3 cell = floor((ro + rd * t) / SL);
      vec3 tMax = ((cell + max(stp, 0.0)) * SL - ro) * stp * inv;
      vec3 tDel = SL * inv;
      int axis = ro.y > b1 || ro.y < b0 ? 1 : -1;
      int lvl = 0, inLvl = 0;
      vec2 col = vec2(1e9);
      float cov = 0.0, bot = 1.0;
      for (int i = 0; i < 128; i++) {
        if (t > tB || alpha > 0.96) break;
        vec3 c = (cell + 0.5) * SL;
        if (c.xz != col) {
          // per column: coverage and the lumpy base
          col = c.xz;
          cov = coverQ(c.xz);
          float d2 = texture(tDetail, vec3(c.xz / (S * 26.0), 0.5)).r;
          // the base undulates by up to ~200 m whatever the layer's thickness (a storm's is kilometres)
          bot = (smoothstep(0.3, 0.75, 1.0 - d2) * 0.42 * mix(1.0, 0.8, cov) + 0.04 * (1.0 - cov)) * min(uThick, 480.0) / uThick;
        }
        float h = (c.y - b0) / uThick;
        if (cov > 0.01 && h > bot) {
          float d = texture(tDetail, c / (S * 22.0)).r;
          float top = cov * (0.45 + 0.75 * d) - 0.04;
          if (h < top) {
            vec3 n = axis < 0 ? -rd : axis == 0 ? vec3(-stp.x, 0.0, 0.0) : axis == 1 ? vec3(0.0, -stp.y, 0.0) : vec3(0.0, 0.0, -stp.z);
            // self-shadow from the cloud above this cell in its column (no extra lookups)
            float sunVis = max(0.25, exp(-(top - h) * uThick / (260.0 * max(uSunDir.y, 0.2))));
            float sun = sunVis * (0.3 + 0.7 * max(dot(n, uSunDir), 0.0));
            vec3 alb = mix(vec3(0.96), vec3(0.36, 0.38, 0.43), uDark) * mix(0.62, 1.0, h);
            vec3 lit = alb * (uSunCol * sun + uAmb * (0.6 + 0.4 * n.y));
            // light through the layer: thin patches glow, thick ones are dark underneath
            lit += alb * uSunCol * 0.35 * exp(-max(top - bot, 0.0) * 3.5) * max(-n.y, 0.0) * (1.0 - uDark * 0.6);
            lit *= (0.86 + 0.28 * d) * (0.93 + 0.14 * fract(sin(dot(floor(c / S), vec3(12.99, 78.23, 37.72))) * 43758.5));
            lit *= n.y > 0.5 ? 1.08 : n.y < -0.5 ? 0.72 : 0.86; // voxel face shading: bright tops, darker sides and bases
            lit += uGlow * max(-n.y, 0.0) * (1.0 - h) * uNight;                       // the city's light from below
            lit += vec3(0.8, 0.86, 1.0) * uFlash * 5.0 * exp(-distance(c + wind, uFlashPos) / 700.0); // lightning inside
            lit = mix(lit, uFogCol, 1.0 - exp(-t / min(uFogDist, 7000.0)));
            // cells round the camera fade, so flying through a cloud thins it gradually rather than popping blocks
            // and the farthest fade into the haze, so the layer has no edge
            float a = clamp(0.9 + cov * 0.08, 0.0, 0.98) * smoothstep(80.0, 450.0, t) * (1.0 - smoothstep(6500.0, 9500.0, t));
            acc += (1.0 - alpha) * a * lit;
            alpha += (1.0 - alpha) * a;
          }
        }
        if (tMax.x < tMax.y && tMax.x < tMax.z) { t = tMax.x; tMax.x += tDel.x; cell.x += stp.x; axis = 0; }
        else if (tMax.y < tMax.z) { t = tMax.y; tMax.y += tDel.y; cell.y += stp.y; axis = 1; }
        else { t = tMax.z; tMax.z += tDel.z; cell.z += stp.z; axis = 2; }
        if (++inLvl == 32 && lvl < 3) {
          lvl++; inLvl = 0; SL *= 2.0;
          cell = floor((ro + rd * (t + 0.05)) / SL);
          tMax = ((cell + max(stp, 0.0)) * SL - ro) * stp * inv;
          tDel = SL * inv;
          col = vec2(1e9);
        }
      }
    }
    acc *= uFade; alpha *= uFade; // fading in or out as a whole, on a change of weather
    // the veil lies under the clouds: scene * (1 - aV)(1 - a) + veil (1 - a) + clouds
    gl_FragColor = vec4(veil * (1.0 - alpha) + acc, 1.0 - (1.0 - aV) * (1.0 - alpha));
  }
`;

// laid over the frame at full resolution
const COMPOSITE = /* glsl */ `
  uniform sampler2D tClouds;
  void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
    vec4 c = texture2D(tClouds, uv);
    outputColor = vec4(inputColor.rgb * (1.0 - c.a) + c.rgb, inputColor.a);
  }
`;

export class CloudEffect extends Effect {
  private rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private march: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private u: Record<string, THREE.IUniform>;

  constructor(shared: ReturnType<typeof cloudUniforms>) {
    const tClouds = new THREE.Uniform<THREE.Texture | null>(null);
    super('CloudEffect', COMPOSITE, { attributes: EffectAttribute.DEPTH, uniforms: new Map<string, THREE.Uniform>([['tClouds', tClouds]]) });
    this.u = {
      ...shared, tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uSunCol: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: new THREE.Color(0.5, 0.6, 0.7) }, uFogCol: { value: new THREE.Color(0.7, 0.8, 0.9) },
      uGlow: { value: new THREE.Color(0.5, 0.32, 0.16) }, uFlashPos: { value: new THREE.Vector3() },
      uDark: { value: 0 }, uRain: { value: 0 }, uFlash: { value: 0 }, uFogDist: { value: 12000 }, uNight: { value: 0 },
    };
    this.march = new THREE.ShaderMaterial({
      uniforms: this.u, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: MARCH,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.march);
    this.quad.frustumCulled = false;
    tClouds.value = this.rt.texture;
  }

  override setDepthTexture(depthTexture: THREE.Texture) { this.u.tDepth.value = depthTexture; }

  override setSize(width: number, height: number) { this.rt.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2))); }

  override update(renderer: THREE.WebGLRenderer) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.render(this.quad, this.cam);
    renderer.setRenderTarget(prev);
  }

  sync(camera: THREE.PerspectiveCamera) {
    this.u.uInvProj.value.copy(camera.projectionMatrixInverse);
    this.u.uCamWorld.value.copy(camera.matrixWorld);
    this.u.uCamPos.value.copy(camera.position);
  }

  set(k: string, v: number) { this.u[k].value = v; }
  get(k: string) { return this.u[k].value; }
}
