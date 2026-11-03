// The voxel material: MeshStandardMaterial (so three's sun, shadows and fog apply) with the colour taken from
// the palette texture, baked AO, a little per-voxel jitter, and everything the palette's material byte asks for:
// windows on facades and towers (lit at night), the sea's waves, lamps, aviation beacons and seasonal blossom.
import * as THREE from 'three';

export const MAT = {
  plain: 0, facade: 1, glass: 2, stone: 3, sea: 4, water: 5, foliage: 6, lamp: 7,
  bloomPurple: 8, bloomRed: 9, beacon: 10, citrus: 11, window: 12, site: 13,
} as const;

export interface VoxelUniforms {
  palTex: { value: THREE.DataTexture };
  uTime: { value: number };
  uNight: { value: number };     // 0 day .. 1 full night
  uLit: { value: number };       // share of windows lit
  uMonth: { value: number };     // 1.0 = 1 January .. 12.99
  uSky: { value: THREE.Color };  // reflected in glass and water
  uFloor: { value: number };
}

export function paletteTexture(pal: [number, number, number, number][]) {
  const W = 1024, H = Math.ceil(pal.length / W);
  const data = new Uint8Array(W * H * 4);
  pal.forEach((p, i) => data.set(p, i * 4));
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export function voxelMaterial(pal: THREE.DataTexture, floorH: number) {
  const uniforms: VoxelUniforms = {
    palTex: { value: pal }, uTime: { value: 0 }, uNight: { value: 0 }, uLit: { value: 0.3 }, uMonth: { value: 5.5 },
    uSky: { value: new THREE.Color(0.6, 0.75, 0.9) }, uFloor: { value: floorH },
  };
  const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 vattr;
        attribute float pal;
        uniform sampler2D palTex;
        flat varying vec4 vCol;
        flat varying vec3 vN;
        flat varying float vGround;
        varying float vAO;
        varying vec3 vWorld;`)
      .replace('#include <beginnormal_vertex>', `
        int ni = int(vattr.x + 0.5);
        vec3 objectNormal = ni == 0 ? vec3(1., 0., 0.) : ni == 1 ? vec3(-1., 0., 0.) : ni == 2 ? vec3(0., 0., 1.)
          : ni == 3 ? vec3(0., 0., -1.) : ni == 4 ? vec3(0., 1., 0.) : vec3(0., -1., 0.);
        vN = objectNormal;
        int pi = int(pal + 0.5);
        vCol = texelFetch(palTex, ivec2(pi % 1024, pi / 1024), 0);
        vAO = vattr.y / 3.0;
        vGround = vattr.z;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime, uNight, uLit, uMonth, uFloor;
        uniform vec3 uSky;
        flat varying vec4 vCol;
        flat varying vec3 vN;
        flat varying float vGround;
        varying float vAO;
        varying vec3 vWorld;
        float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float season(float c, float w) { float d = abs(uMonth - c); d = min(d, 12.0 - d); return clamp(1.0 - d / w, 0.0, 1.0); }
        vec3 gEmit = vec3(0.0);
        float gRough = 0.9, gMetal = 0.0;
        vec3 gNormalW = vec3(0.0);`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          int mat = int(vCol.a * 255.0 + 0.5);
          vec3 c = vCol.rgb;
          vec3 cell = floor(vWorld - vN * 0.5 + 0.001);
          float h = hash3(cell);
          c *= 0.955 + 0.09 * h;
          bool side = abs(vN.y) < 0.5;
          vec3 V = normalize(cameraPosition - vWorld);
          float fres = pow(1.0 - clamp(dot(V, vN), 0.0, 1.0), 3.0);
          if ((mat == 1 || mat == 2 || mat == 3) && side) {
            float u = abs(vN.x) > 0.5 ? vWorld.z : vWorld.x;
            float f = (vWorld.y - vGround) / uFloor;
            float fl = floor(f), wf = fract(f);
            float fw = max(fwidth(u) / 2.0, fwidth(f));
            float detail = 1.0 - smoothstep(0.25, 0.7, fw);
            vec3 glassDay = mix(vec3(0.07, 0.09, 0.12), uSky * 0.55, 0.25 + 0.5 * fres);
            // far away a window is under a pixel: light whole blocks of windows (2, 4, 8... wide) instead of an
            // even glow, so the skyline keeps its lit and dark patches at any distance
            float lod = exp2(ceil(log2(max(fw * 1.1, 1.0))));
            vec2 fc = vec2(floor(u / (3.0 * lod)), floor(f / lod)) + vec2(vGround * 7.0, lod * 13.0);
            float fh = hash2(fc);
            float farLit = step(fh, uLit) * (0.35 + 0.65 * hash2(fc + 5.3));
            vec3 farEmit = (1.0 - detail) * uNight * (farLit * 0.32 + uLit * 0.05) * vec3(1.0, 0.74, 0.44);
            if (mat == 1) {
              float cu = u / 3.0, wu = fract(cu);
              float win = step(0.18, wu) * step(wu, 0.66) * step(0.28, wf) * step(wf, 0.8);
              if (fl < 1.0) win = step(0.06, wu) * step(wu, 0.94) * step(0.12, wf) * step(wf, 0.82) * step(0.5, hash2(vec2(floor(cu), vGround)));
              float band = step(wf, 0.1);
              vec3 wall = c * (1.0 - 0.18 * band);
              float lit = step(hash2(vec2(floor(cu) + vGround * 7.0, fl + floor(u / 61.0))), uLit);
              vec3 wc = glassDay;
              gEmit = win * lit * uNight * mix(vec3(1.0, 0.72, 0.42), vec3(0.85, 0.9, 1.0), step(0.8, hash2(vec2(fl, floor(cu))))) * 1.6;
              vec3 avg = mix(c * 0.92, glassDay, 0.18);
              c = mix(avg, mix(wall, wc, win), detail);
              gEmit = gEmit * detail + farEmit;
            } else if (mat == 2) {
              float mu = fract(u / 1.6);
              float mull = max(step(0.9, mu), step(0.93, wf));
              vec3 panel = mix(c * 0.75, uSky * 0.9, 0.2 + 0.55 * fres);
              float lit = step(hash2(vec2(floor(u / 3.2) + vGround * 3.0, fl)), uLit * 0.8);
              c = mix(mix(panel, c * 0.55, mull), panel, 1.0 - detail);
              gEmit = (1.0 - mull) * lit * uNight * vec3(1.0, 0.9, 0.75) * 0.8 * detail + farEmit * vec3(0.85, 1.0, 1.25);
              gRough = 0.25; gMetal = 0.35;
            } else {
              float cu = u / 3.6, wu = fract(cu);
              float win = step(0.36, wu) * step(wu, 0.62) * step(0.34, wf) * step(wf, 0.74);
              float lit = step(hash2(vec2(floor(cu) + vGround * 5.0, fl)), uLit * 0.8);
              c = mix(c * 0.95, mix(c, vec3(0.12, 0.1, 0.09), win), detail);
              gEmit = win * lit * uNight * vec3(1.0, 0.7, 0.4) * 1.4 * detail + farEmit * 0.6;
            }
          } else if (mat == 4) {
            // the sea: two trains of waves, glints, darker away from the light
            vec2 p = vWorld.xz;
            float w1 = sin(dot(p, vec2(0.11, 0.05)) - uTime * 1.3), w2 = sin(dot(p, vec2(-0.06, 0.17)) - uTime * 0.9);
            float w3 = sin(dot(p, vec2(0.37, 0.29)) - uTime * 2.1);
            vec3 nw = normalize(vec3(0.11 * w1 * 0.5 - 0.06 * w2 * 0.4 + 0.2 * w3 * 0.25, 1.0, 0.05 * w1 * 0.5 + 0.17 * w2 * 0.4 + 0.15 * w3 * 0.25));
            if (vN.y > 0.5) gNormalW = nw;
            c = mix(c, uSky * 0.8, 0.25 * fres) * (0.97 + 0.03 * w3);
            gRough = 0.16;
          } else if (mat == 5) {
            gRough = 0.2;
            c = mix(c, uSky, 0.2 * fres);
          } else if (mat == 6 || mat == 8 || mat == 9 || mat == 11) {
            vec3 green = mat == 8 ? vec3(0.36, 0.52, 0.27) : vec3(0.38, 0.55, 0.25);
            if (mat == 8) c = mix(green * (0.9 + 0.2 * h), c, season(5.0, 1.3));
            if (mat == 9) c = mix(green * (0.9 + 0.2 * h), c, season(6.6, 1.6));
            if (mat == 11) c = mix(vec3(0.22, 0.4, 0.18), c, season(1.5, 2.8));
            c *= 0.9 + 0.2 * hash3(cell + 3.1);
          } else if (mat == 7) {
            gEmit = c * uNight * 5.0;
          } else if (mat == 10) {
            float blink = step(0.5, fract(uTime * 0.5 + hash2(cell.xz) * 0.2));
            gEmit = vec3(1.0, 0.08, 0.04) * (uNight * 6.0 * blink + 0.4);
          } else if (mat == 13 && side) {
            // an unfinished frame: slabs, columns, and the dark open floors between them
            float u = abs(vN.x) > 0.5 ? vWorld.z : vWorld.x;
            float wf = fract((vWorld.y - vGround) / uFloor);
            float open_ = step(0.22, wf) * step(0.18, fract(u / 6.0));
            c = mix(c, c * 0.28, open_ * (1.0 - smoothstep(0.3, 0.8, fwidth(u) / 2.0)));
          } else if (mat == 12) {
            c = mix(c, uSky, 0.35 * fres); gRough = 0.3;
          }
          float ao = mix(0.42, 1.0, vAO * vAO * 0.35 + vAO * 0.65);
          diffuseColor.rgb = c * ao;
          gEmit *= mix(0.6, 1.0, ao);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = gRough;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = gMetal;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (gNormalW.y > 0.0) normal = normalize((viewMatrix * vec4(gNormalW, 0.0)).xyz);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += gEmit;`);
  };
  m.customProgramCacheKey = () => 'voxel-v1';
  return { material: m, uniforms };
}
