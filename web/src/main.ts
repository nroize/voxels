import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { paletteTexture, voxelMaterial } from './material';
import { Stream, type TileLevel } from './stream';
import { lighting, litShare, skyDome, sunPosition, sunVector } from './sky';
import { Labels, type Label } from './labels';
import './style.css';

interface View { label: string; pos: [number, number, number]; target: [number, number, number] }
interface Meta {
  city: string; name: string; name_he: string; W: number; D: number; H: number; base: number; theta: number;
  center: [number, number]; floor: number; tiles: { N: number; levels: TileLevel[] };
  palette: [number, number, number, number][]; labels: Label[]; views: Record<string, View>;
  sources: { osm: string }; report: Record<string, unknown>;
}

const CITIES: Record<string, string> = { tlv: 'Tel Aviv-Yafo', rehovot: 'Rehovot' };
const q = new URLSearchParams(location.search);
const city = CITIES[q.get('city') ?? ''] ? q.get('city')! : 'tlv';
const base = `${import.meta.env.BASE_URL}data/${city}`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main() {
  const meta: Meta = await (await fetch(`${base}/meta.json`)).json();
  document.title = `${meta.name} in voxels`;
  $('city-en').textContent = meta.name;
  $('city-he').textContent = meta.name_he;
  const sw = $('city-switch');
  for (const [k, name] of Object.entries(CITIES)) {
    const a = document.createElement('a');
    a.textContent = name; a.href = `?city=${k}`;
    if (k === city) a.className = 'on';
    sw.appendChild(a);
  }
  $('osm-date').textContent = meta.sources.osm;

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  $('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 2, 60000);
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 20;
  controls.maxDistance = 9000;
  controls.zoomToCursor = true;
  controls.listenToKeyEvents(window);
  controls.keyPanSpeed = 25;

  const { material, uniforms } = voxelMaterial(paletteTexture(meta.palette), meta.floor);
  const stream = new Stream(base, meta.tiles.N, meta.tiles.levels, meta.H, material, Number(q.get('err') ?? 3));
  scene.add(stream.group);

  // the table the diorama stands on
  const table = new THREE.Mesh(new THREE.PlaneGeometry(80000, 80000), new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: 1 }));
  table.rotation.x = -Math.PI / 2;
  table.position.set(meta.W / 2, -0.05, meta.D / 2);
  table.receiveShadow = true;
  scene.add(table);

  const sky = skyDome();
  scene.add(sky.mesh);
  const hemi = new THREE.HemisphereLight(0xbfd6ff, 0xb8a888, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  scene.fog = new THREE.Fog(0xffffff, 3000, 20000);

  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
  composer.addPass(new RenderPass(scene, camera));
  const ao = new N8AOPostPass(scene, camera, innerWidth, innerHeight);
  ao.configuration.aoRadius = 4;
  ao.configuration.distanceFalloff = 1.5;
  ao.configuration.intensity = 2.8;
  ao.setQualityMode('Medium');
  composer.addPass(ao);
  const bloom = new BloomEffect({ intensity: 0.9, luminanceThreshold: 1.0, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.6 });
  composer.addPass(new EffectPass(camera, bloom, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })));
  composer.addPass(new EffectPass(camera, new SMAAEffect()));

  // ---- time of day and season
  const hourIn = $<HTMLInputElement>('hour'), monthIn = $<HTMLSelectElement>('month');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  months.forEach((m, i) => monthIn.add(new Option(m, String(i + 1))));
  hourIn.value = q.get('hour') ?? '17.6';
  monthIn.value = q.get('month') ?? '5';
  let playing = false;
  $('play').onclick = () => { playing = !playing; $('play').textContent = playing ? '❚❚' : '▶'; };
  const setTime = () => {
    const hour = Number(hourIn.value), month = Number(monthIn.value);
    const doy = Math.round((month - 1) * 30.44 + 15);
    const { az, el } = sunPosition(meta.center[0], meta.center[1], doy, hour);
    const L = lighting(el);
    const dir = el > -2 ? sunVector(az, el, meta.theta) : sunVector((az + 180) % 360, 35, meta.theta); // the moon stands in
    sun.color.copy(el > -2 ? L.sun : new THREE.Color(0.55, 0.65, 1.0));
    sun.intensity = el > -2 ? L.sunI : 0.08;
    hemi.intensity = L.hemiI;
    // at night the sky over the city glows orange with its own light
    hemi.color.copy(L.zenith).lerp(new THREE.Color(1, 1, 1), 0.35 * (1 - L.night)).lerp(new THREE.Color(0.42, 0.36, 0.32), L.night);
    hemi.groundColor.copy(L.horizon).multiplyScalar(0.6);
    sky.uniforms.zenith.value.copy(L.zenith);
    sky.uniforms.horizon.value.copy(L.horizon);
    sky.uniforms.sunDir.value.copy(sunVector(az, el, meta.theta));
    sky.uniforms.sunCol.value.copy(L.sun);
    sky.uniforms.night.value = L.night;
    (scene.fog as THREE.Fog).color.copy(L.horizon);
    (table.material as THREE.MeshStandardMaterial).color.setRGB(0.72, 0.69, 0.64).multiplyScalar(0.4 + 0.6 * (1 - L.night));
    uniforms.uNight.value = L.night;
    uniforms.uLit.value = litShare(hour);
    uniforms.uMonth.value = month + 0.5;
    uniforms.uSky.value.copy(L.horizon).lerp(L.zenith, 0.4);
    sunDir.copy(dir);
    const hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60);
    $('clock').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  const sunDir = new THREE.Vector3();
  hourIn.oninput = setTime; monthIn.onchange = setTime;
  setTime();

  // ---- views
  const viewSel = $<HTMLSelectElement>('views');
  for (const [k, v] of Object.entries(meta.views)) viewSel.add(new Option(v.label, k));
  let flight: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number } | null = null;
  const goto = (k: string, instant = false) => {
    k = meta.views[k] ? k : Object.keys(meta.views).find((x) => x.startsWith(k) || k.startsWith(x)) ?? k;
    const v = meta.views[k];
    if (!v) return;
    viewSel.value = k;
    const to: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(...v.pos), new THREE.Vector3(...v.target)];
    if (instant) { camera.position.copy(to[0]); controls.target.copy(to[1]); controls.update(); return; }
    flight = { from: [camera.position.clone(), controls.target.clone()], to, t0: performance.now() };
  };
  viewSel.onchange = () => goto(viewSel.value);
  goto(q.get('view') ?? 'overview', true);

  const labels = new Labels($('app'), meta.labels);
  labels.enabled = q.get('labels') !== '0';
  $<HTMLInputElement>('show-labels').checked = labels.enabled;
  $<HTMLInputElement>('show-labels').onchange = (e) => { labels.enabled = (e.target as HTMLInputElement).checked; };
  if (q.get('ui') === '0') document.body.classList.add('no-ui');

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
  });

  const clock = new THREE.Clock();
  const stats = $('stats');
  const debug = q.has('debug');
  let lastStream = 0;
  const loop = () => {
    const dt = clock.getDelta();
    if (playing) { hourIn.value = String((Number(hourIn.value) + dt * 0.4) % 24); setTime(); }
    if (flight) {
      const t = Math.min(1, (performance.now() - flight.t0) / 2200), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      camera.position.lerpVectors(flight.from[0], flight.to[0], e);
      controls.target.lerpVectors(flight.from[1], flight.to[1], e);
      if (t >= 1) flight = null;
    }
    controls.update();
    const dist = camera.position.distanceTo(controls.target);
    camera.near = Math.max(1, dist * 0.01);
    camera.far = 60000;
    camera.updateProjectionMatrix();
    // the sun's shadow box follows what you look at
    const R = THREE.MathUtils.clamp(dist * 1.1, 160, 2200);
    const sc = sun.shadow.camera;
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 1; sc.far = 8000;
    sc.updateProjectionMatrix();
    const tgt = controls.target.clone();
    const texel = (2 * R) / 4096;
    tgt.x = Math.round(tgt.x / texel) * texel; tgt.z = Math.round(tgt.z / texel) * texel;
    sun.target.position.copy(tgt);
    sun.position.copy(tgt).addScaledVector(sunDir, 4000);
    scene.fog!.constructor === THREE.Fog && Object.assign(scene.fog as THREE.Fog, { near: 2500 + dist, far: 16000 + dist * 2 });
    sky.mesh.position.copy(camera.position);
    uniforms.uTime.value = clock.elapsedTime;
    const now = performance.now();
    if (now - lastStream > 120) { stream.update(camera, innerHeight * renderer.getPixelRatio()); lastStream = now; }
    composer.render(dt);
    labels.update(camera, innerWidth, innerHeight);
    if (debug) stats.textContent = `drawn ${(stream.drawn / 1e6).toFixed(2)} M quads · loaded ${(stream.quads / 1e6).toFixed(2)} M · queue ${stream.loading}`;
    $('loading').classList.toggle('on', stream.loading > 0);
    requestAnimationFrame(loop);
  };
  (window as unknown as { __tlv: unknown }).__tlv = { camera, controls, stream, setTime, goto };
  loop();
}

main().catch((e) => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${String(e)}</pre>`); });
