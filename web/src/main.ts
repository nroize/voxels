import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, TiltShiftEffect, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { paletteTexture, voxelMaterial } from './material';
import { Stream, type TileLevel } from './stream';
import { lighting, litShare, skyDome, sunPosition, sunVector } from './sky';
import { Labels, type Label } from './labels';
import { Search, type Hit } from './search';
import { Inspector } from './inspect';
import { PRESETS, Weather, liveWeather } from './weather';
import { CloudEffect, cloudTextures, cloudUniforms } from './clouds';
import './style.css';

interface View { label: string; pos: [number, number, number]; target: [number, number, number] }
interface Meta {
  city: string; name: string; name_he: string; W: number; D: number; H: number; base: number; theta: number;
  center: [number, number]; floor: number; tiles: { N: number; levels: TileLevel[] };
  palette: [number, number, number, number][]; labels: Label[]; views: Record<string, View>;
  sources: { osm: string }; report: Record<string, unknown>; lamps: [number, number, number][];
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
  // the pixel ratio starts at up to 1.5 and adapts to keep frames short (or ?dpr= fixes it)
  const dprMax = Number(q.get('dpr')) || Math.min(window.devicePixelRatio, 1.5);
  let dpr = dprMax;
  renderer.setPixelRatio(dpr);
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // redrawn only when the sun, the shadow box or the drawn tiles change
  renderer.toneMapping = THREE.NoToneMapping;
  $('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 2, 60000);
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 20;
  controls.maxDistance = 7000;
  controls.zoomToCursor = true;
  controls.listenToKeyEvents(window);
  controls.keyPanSpeed = 25;

  const cloudU = cloudUniforms(cloudTextures());
  const { material, uniforms } = voxelMaterial(paletteTexture(meta.palette), meta.floor, cloudU);
  material.envMapIntensity = 1.0;
  uniforms.lampTex.value = lampTexture(meta);
  uniforms.uMap.value.set(meta.W, meta.D);
  const stream = new Stream(base, meta.tiles.N, meta.tiles.levels, meta.H, material, Number(q.get('err') ?? 4));
  scene.add(stream.group);

  // the table the diorama stands on
  const table = new THREE.Mesh(new THREE.PlaneGeometry(80000, 80000), new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: 1, envMapIntensity: 0 }));
  table.rotation.x = -Math.PI / 2;
  table.position.set(meta.W / 2, -0.05, meta.D / 2);
  table.receiveShadow = true;
  scene.add(table);

  // the day sky: Preetham's scattering model (three's Sky), with the gradient dome over it for night and weather
  const psky = new Sky();
  psky.scale.setScalar(45000);
  psky.frustumCulled = false;
  psky.renderOrder = -2;
  const pu = psky.material.uniforms;
  pu.cloudCoverage.value = 0; // the clouds are clouds.ts's
  pu.mieDirectionalG.value = 0.8;
  scene.add(psky);
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
  ao.setQualityMode('Medium'); // (halfRes would be cheaper, but its render targets break with this three.js)
  composer.addPass(ao);
  const bloom = new BloomEffect({ intensity: 0.9, luminanceThreshold: 1.0, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.6 });
  const cloudFX = new CloudEffect(cloudU);
  composer.addPass(new EffectPass(camera, cloudFX, bloom, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })));
  // "Miniature": a tilt-shift blur above and below a band through the middle, the diorama look
  const tilt = new EffectPass(camera, new TiltShiftEffect({ offset: 0.05, focusArea: 0.42, feather: 0.32, kernelSize: 3 }));
  tilt.enabled = q.get('tilt') === '1';
  composer.addPass(tilt);
  composer.addPass(new EffectPass(camera, new SMAAEffect()));
  // the sky as an environment map, so glass and water reflect it (re-rendered when the time or weather changes)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(psky.geometry, psky.material).copy(psky), new THREE.Mesh(sky.mesh.geometry, sky.mesh.material));
  let envRT: THREE.WebGLRenderTarget | null = null, envDirty = true, lastEnv = 0;

  // ---- time of day and season
  const hourIn = $<HTMLInputElement>('hour'), monthIn = $<HTMLSelectElement>('month');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  months.forEach((m, i) => monthIn.add(new Option(m, String(i + 1))));
  hourIn.value = q.get('hour') ?? '17.6';
  monthIn.value = q.get('month') ?? '5';
  let playing = false;
  $('play').onclick = () => { playing = !playing; $('play').textContent = playing ? '❚❚' : '▶'; };
  const weather = new Weather(scene);
  let fogNear = 2500, fogFar = 16000, haze = 0;
  const setTime = () => {
    const hour = Number(hourIn.value), month = Number(monthIn.value);
    const doy = liveDay ?? Math.round((month - 1) * 30.44 + 15);
    const { az, el } = sunPosition(meta.center[0], meta.center[1], doy, hour);
    const L0 = lighting(el), A = weather.apply(L0);
    const L = { ...L0, zenith: A.zenith, horizon: A.horizon, sun: A.sun, sunI: A.sunI, hemiI: A.hemiI };
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
    sky.uniforms.sunDisc.value = A.sunDisc;
    sky.uniforms.stars.value = A.stars;
    const w0 = weather.state;
    sky.uniforms.over.value = Math.min(1, Math.max(L.night * 1.05, w0.grey * 0.85, w0.dust * 0.75, w0.haze * 0.6));
    pu.sunPosition.value.copy(sunVector(az, el, meta.theta));
    pu.turbidity.value = 2.2 + w0.haze * 6 + w0.dust * 8;
    pu.rayleigh.value = 1.4 - w0.dust * 0.8;
    pu.mieCoefficient.value = 0.004 + w0.dust * 0.02 + w0.haze * 0.006;
    pu.showSunDisc.value = A.sunDisc > 0.5 ? 1 : 0;
    fogNear = A.fogNear; fogFar = A.fogFar; haze = weather.state.haze;
    uniforms.uWet.value = weather.state.wet;
    uniforms.uRain.value = weather.state.rain;
    envDirty = true;
    if (A.flash > 0) hemi.color.lerp(new THREE.Color(0.85, 0.9, 1), A.flash);
    (scene.fog as THREE.Fog).color.copy(L.horizon);
    (table.material as THREE.MeshStandardMaterial).color.setRGB(0.72, 0.69, 0.64).multiplyScalar(0.4 + 0.6 * (1 - L.night));
    uniforms.uNight.value = L.night;
    uniforms.uLit.value = litShare(hour);
    uniforms.uMonth.value = month + 0.5;
    uniforms.uSky.value.copy(L.horizon).lerp(L.zenith, 0.4);
    sunDir.copy(dir);
    uniforms.uSunCol.value.copy(sun.color);
    // the clouds' light: the same sun and sky as the city, in the clouds' own units
    cloudU.uSunDir.value.copy(dir);
    cloudFX.get('uSunCol').copy(sun.color).multiplyScalar(sun.intensity * 0.3);
    cloudFX.get('uAmb').copy(hemi.color).multiplyScalar(hemi.intensity * 0.55);
    cloudFX.get('uFogCol').copy(L.horizon);
    cloudFX.set('uNight', L.night);
    const w = weather.state;
    cloudU.uCover.value = w.cloud; cloudU.uBase.value = w.base; cloudU.uThick.value = w.thick; cloudU.uScale.value = w.scale; cloudU.uRidge.value = w.ridge;
    weather.rainColour(L.horizon, L.night);
    cloudFX.set('uDark', w.dark); cloudFX.set('uRain', w.rain); cloudFX.set('uFogDist', 3000 + fogFar);
    const hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60);
    $('clock').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  const sunDir = new THREE.Vector3();
  // "Now": the date and time in Israel, kept up to date until the slider or the month is moved
  let liveDay: number | null = null, liveTimer = 0;
  const nowBtn = $<HTMLButtonElement>('now');
  const followClock = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date()).map((x) => [x.type, Number(x.value)]));
    hourIn.value = String(p.hour + p.minute / 60);
    monthIn.value = String(p.month);
    liveDay = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(p.year, 0, 0)) / 86400e3);
    setTime();
  };
  const setLive = (on: boolean) => {
    clearInterval(liveTimer);
    nowBtn.classList.toggle('on', on);
    if (on) { playing = false; $('play').textContent = '▶'; followClock(); liveTimer = setInterval(followClock, 30_000); }
    else liveDay = null;
  };
  nowBtn.onclick = () => setLive(!nowBtn.classList.contains('on'));
  hourIn.oninput = () => { setLive(false); setTime(); };
  monthIn.onchange = () => { setLive(false); setTime(); };
  $('play').addEventListener('click', () => setLive(false));
  if (q.get('hour') === 'now') setLive(true);
  const weatherIn = $<HTMLSelectElement>('weather');
  for (const [k, p] of Object.entries(PRESETS)) weatherIn.add(new Option(p.label, k));
  weatherIn.add(new Option('Now (live)', 'live'));
  const setWeather = async (k: string, instant = false) => {
    if (k === 'live') {
      const live = weatherIn.options[weatherIn.options.length - 1];
      live.text = 'Now: loading…';
      try {
        const w = await liveWeather(meta.center[0], meta.center[1]);
        weather.setState(w.state);
        live.text = `Now: ${w.text}`;
      } catch { live.text = 'Now: unavailable'; }
    } else weather.set(k);
    if (instant) { weather.snap(); setTime(); }
  };
  weatherIn.onchange = () => setWeather(weatherIn.value);
  weatherIn.value = PRESETS[q.get('weather') ?? ''] || q.get('weather') === 'live' ? q.get('weather')! : 'clear';
  setWeather(weatherIn.value, true);
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

  // ---- search and picking (the indexes load after the first frames)
  const flyTo = (x: number, y: number, z: number, dist: number) => {
    const dir = camera.position.clone().sub(controls.target).setY(0);
    if (dir.lengthSq() < 1) dir.set(-0.6, 0, 0.8);
    dir.normalize().multiplyScalar(dist * 0.8).setY(dist * 0.6);
    const tgt = new THREE.Vector3(x, y, z);
    flight = { from: [camera.position.clone(), controls.target.clone()], to: [tgt.clone().add(dir), tgt], t0: performance.now() };
  };
  let searchP: Promise<Search> | null = null;
  const index = () => (searchP ??= Search.load(base));
  setTimeout(index, 2500);
  const inspector = new Inspector(base, meta.tiles.N, scene, camera, stream.group, index,
    meta.palette, meta.floor, flyTo);
  let down: { x: number; y: number; t: number } | null = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || performance.now() - down.t > 500) return;
    inspector.click(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1));
  });
  const qIn = $<HTMLInputElement>('q'), results = $<HTMLUListElement>('results');
  let hits: Hit[] = [], active = 0;
  const show = () => {
    results.hidden = !hits.length && !qIn.value.trim();
    results.innerHTML = hits.length ? hits.map((h, i) => `<li class="${i === active ? 'on' : ''}" data-i="${i}"><span class="r-l" dir="auto">${escHtml(h.label)}</span><span class="r-s">${h.sub.split(' · ').map((p) => `<bdi>${escHtml(p)}</bdi>`).join(' · ')}</span></li>`).join('')
      : qIn.value.trim().length > 1 ? '<li class="none">Nothing found on this map</li>' : '';
  };
  const choose = (h: Hit) => {
    hits = []; show(); qIn.blur();
    if (h.building) inspector.select(h.building, true);
    else { inspector.select(0); flyTo(h.x, 10, h.y, h.zoom); }
  };
  qIn.addEventListener('input', async () => { const s = await index(); hits = s.query(qIn.value); active = 0; show(); });
  qIn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(hits.length - 1, active + 1); show(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); show(); e.preventDefault(); }
    else if (e.key === 'Enter' && hits[active]) choose(hits[active]);
    else if (e.key === 'Escape') { hits = []; qIn.value = ''; show(); qIn.blur(); }
    e.stopPropagation(); // keep the arrow keys from panning the map
  });
  results.addEventListener('pointerdown', (e) => {
    const li = (e.target as HTMLElement).closest('li[data-i]') as HTMLElement | null;
    if (li) { e.preventDefault(); choose(hits[Number(li.dataset.i)]); }
  });
  qIn.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 150));
  qIn.addEventListener('focus', () => { index(); if (hits.length) show(); });

  const labels = new Labels($('app'), meta.labels);
  labels.enabled = q.get('labels') !== '0';
  $<HTMLInputElement>('show-labels').checked = labels.enabled;
  $<HTMLInputElement>('show-labels').onchange = (e) => { labels.enabled = (e.target as HTMLInputElement).checked; };
  if (q.get('ui') === '0') document.body.classList.add('no-ui');
  $<HTMLInputElement>('tilt').checked = tilt.enabled;
  $<HTMLInputElement>('tilt').onchange = (e) => { tilt.enabled = (e.target as HTMLInputElement).checked; };

  // the credits sit in the bottom-right corner, or just above the control bar when the two would overlap
  const credits = document.querySelector<HTMLElement>('.credits')!, bar = document.querySelector<HTMLElement>('.bar')!;
  const placeCredits = () => {
    credits.style.bottom = '';
    const a = credits.getBoundingClientRect(), b = bar.getBoundingClientRect();
    if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) credits.style.bottom = `${innerHeight - b.top + 8}px`;
  };
  placeCredits();
  document.fonts?.ready.then(placeCredits);
  addEventListener('resize', placeCredits);
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
  });

  const clock = new THREE.Clock();
  const stats = $('stats');
  const debug = q.has('debug');
  // ?perf: the time of each frame's rendering, GPU included (gl.finish waits for it), and what was drawn
  const perf = q.has('perf') ? { ms: [] as number[], cpu: [] as number[], gap: [] as number[], last: 0, calls: 0, tris: 0, env: 0, shadow: 0, frames: 0 } : null;
  if (perf) renderer.info.autoReset = false;
  const pending: WebGLQuery[] = [];
  let lastStream = 0;
  let shadowKey = '', lastShadow = 0;
  let slow = 0, fast = 0, lastDpr = 0, lastFrame = 0;
  const loop = () => {
    const tl = performance.now(), now0 = tl;
    if (perf) { perf.frames++; if (perf.last) perf.gap.push(tl - perf.last); perf.last = tl; if (perf.gap.length > 240) perf.gap.shift(); }
    const dt = clock.getDelta();
    if (playing) { hourIn.value = String((Number(hourIn.value) + dt * 0.4) % 24); setTime(); }
    if (flight) {
      const t = Math.min(1, (performance.now() - flight.t0) / 2200), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      camera.position.lerpVectors(flight.from[0], flight.to[0], e);
      controls.target.lerpVectors(flight.from[1], flight.to[1], e);
      if (t >= 1) flight = null;
    }
    controls.update();
    // the point you look at stays over the map: pan past the edge and the view slides along it
    const m = 400, tg = controls.target;
    const cx = THREE.MathUtils.clamp(tg.x, -m, meta.W + m), cz = THREE.MathUtils.clamp(tg.z, -m, meta.D + m);
    if (cx !== tg.x || cz !== tg.z) {
      camera.position.x += cx - tg.x; camera.position.z += cz - tg.z;
      tg.x = cx; tg.z = cz;
    }
    tg.y = THREE.MathUtils.clamp(tg.y, -20, 600);
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
    // redraw the shadow map only when something in it changed; drifting clouds, a few times a second
    const sk = `${tgt.x.toFixed(1)},${tgt.z.toFixed(1)},${R.toFixed(0)},${sunDir.x.toFixed(4)},${sunDir.y.toFixed(4)},${stream.version}`;
    const t = clock.elapsedTime;
    if (sk !== shadowKey) { renderer.shadowMap.needsUpdate = true; shadowKey = sk; lastShadow = t; if (perf) perf.shadow = (perf.shadow ?? 0) + 1; }
    // thick weather still lets you see what you are looking at: the fog scales with the distance to it
    Object.assign(scene.fog as THREE.Fog, { near: fogNear + dist * (1 - 0.8 * haze), far: fogFar + dist * (2 - 1.4 * haze) });
    if (weather.update(dt, clock.elapsedTime, camera, controls.target)) setTime();
    cloudU.uWind.value.copy(weather.wind);
    cloudU.uFade.value = weather.fade;
    cloudFX.set('uFlash', weather.flash * weather.state.storm);
    cloudFX.get('uFlashPos').copy(weather.flashPos);
    camera.updateMatrixWorld();
    cloudFX.sync(camera);
    sky.mesh.position.copy(camera.position);
    psky.position.copy(camera.position);
    if (envDirty && now0 - lastEnv > 250) {
      envRT?.dispose();
      // without the sun: the sun light already lights the city, the sky only adds its colours
      const sc0 = sky.uniforms.sunCol.value.clone();
      const disc = pu.showSunDisc.value;
      sky.uniforms.sunCol.value.setRGB(0, 0, 0); pu.showSunDisc.value = 0;
      envRT = pmrem.fromScene(envScene, 0.04, 1, 100000);
      sky.uniforms.sunCol.value.copy(sc0); pu.showSunDisc.value = disc;
      scene.environment = envRT.texture;
      envDirty = false; lastEnv = now0;
      if (perf) perf.env = (perf.env ?? 0) + 1;
    }
    uniforms.uTime.value = clock.elapsedTime;
    const now = performance.now();
    if (now - lastStream > 120) { stream.update(camera, innerHeight * renderer.getPixelRatio()); lastStream = now; }
    // adaptive resolution: frames over ~22 ms for a while lower the pixel ratio, quick ones raise it back
    const gap = lastFrame ? now - lastFrame : 16;
    lastFrame = now;
    if (!q.get('dpr') && gap < 100) { // longer gaps are a hidden tab, not a slow GPU
      slow = gap > 22 ? slow + 1 : Math.max(0, slow - 1);
      fast = gap < 14 ? fast + 1 : 0;
      if (now - lastDpr > 2000 && (slow > 45 || (fast > 150 && dpr < dprMax))) {
        dpr = THREE.MathUtils.clamp(dpr + (slow > 45 ? -0.2 : 0.1), 0.6, dprMax);
        renderer.setPixelRatio(dpr); composer.setSize(innerWidth, innerHeight);
        slow = fast = 0; lastDpr = now;
      }
    }
    if (perf) {
      // GPU time of the frame from a timer query, read back a few frames later
      const gl = renderer.getContext() as WebGL2RenderingContext, ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      renderer.info.reset();
      const qy = ext ? gl.createQuery() : null;
      if (qy) gl.beginQuery(ext.TIME_ELAPSED_EXT, qy);
      composer.render(dt);
      if (qy) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(qy); }
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const r = pending.shift()!;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) perf.ms.push(gl.getQueryParameter(r, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(r);
      }
      if (perf.ms.length > 240) perf.ms.shift();
      perf.calls = renderer.info.render.calls; perf.tris = renderer.info.render.triangles;
    } else composer.render(dt);
    labels.update(camera, innerWidth, innerHeight);
    if (debug) stats.textContent = `drawn ${(stream.drawn / 1e6).toFixed(2)} M quads · loaded ${(stream.quads / 1e6).toFixed(2)} M · queue ${stream.loading}`;
    $('loading').classList.toggle('on', stream.loading > 0);
    if (perf) { perf.cpu.push(performance.now() - tl - (perf.ms[perf.ms.length - 1] ?? 0)); if (perf.cpu.length > 240) perf.cpu.shift(); }
    requestAnimationFrame(loop);
  };
  (window as unknown as { __tlv: unknown }).__tlv = { camera, controls, stream, setTime, goto, inspector, index, weather, renderer, perf, composer, ao, sun, bloom, cloudFX, cloudU };
  loop();
}

/** street-light pools: every lamp's light on the ground, 2 m cells over the map */
function lampTexture(meta: Meta) {
  const s = 2, w = Math.ceil(meta.W / s), h = Math.ceil(meta.D / s), acc = new Float32Array(w * h);
  const R = 6, sigma = 2.6; // cells: ~5 m of light round a lamp, ~12 m to the dark
  const k: number[] = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) k.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)));
  for (const [x, y] of meta.lamps) {
    const cx = Math.round(x / s), cy = Math.round(y / s);
    for (let dy = -R, i = 0; dy <= R; dy++) for (let dx = -R; dx <= R; dx++, i++) {
      const px = cx + dx, py = cy + dy;
      if (px >= 0 && py >= 0 && px < w && py < h) acc[py * w + px] += k[i];
    }
  }
  const data = new Uint8Array(w * h);
  for (let i = 0; i < acc.length; i++) data[i] = Math.min(255, acc[i] * 200);
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

main().catch((e) => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${String(e)}</pre>`); });
