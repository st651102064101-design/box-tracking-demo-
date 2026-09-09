import * as THREE from 'three/webgpu';
// The app maps `three` to the WebGPU build. WebGLRenderer lives only in the
// standard build, so the fallback needs its own import-map alias.
import { WebGLRenderer } from 'three/webgl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

const CM_TO_M = 0.01;
const THREE_VERSION = '0.184.0';
// Slot volumes are invisible hit targets. The rack is read from its steel
// members: empty bays must never look like dark glass partitions.
const EMPTY_COLOR = new THREE.Color(0x253039);
const FULL_COLOR = new THREE.Color(0xd63d48);
const OCCUPIED_COLOR = new THREE.Color(0xf59e0b);
const HOVER_COLOR = new THREE.Color(0xffc857);
const EMPTY_HOVER_COLOR = new THREE.Color(0x98f83e);
const BOX_HOVER_COLOR = new THREE.Color(0xffef73);
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
let activeController = null;
let generation = 0;

// Code 128-B modules. This is the same symbology emitted by Zebra ZPL ^BC,
// so the 3D label is a faithful model of the physical location sticker.
const CODE128_PATTERNS = ["212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212","112232","122132","122231","113222","123122","123221","223211","221132","221231","213212","223112","312131","311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321","112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121","313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111","314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114","122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212","124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113","114311","411113","411311","113141","114131","311141","411131","211412","211214","211232","2331112"];

const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positive = (value, fallback) => num(value, fallback) > 0 ? num(value, fallback) : fallback;
const token = () => {
  try { return localStorage.getItem('smarttrace_jwt') || ''; } catch (_) { return ''; }
};

function rackId(wh, zone, rack) {
  return `${wh}::${zone || ''}::${rack}`;
}

function legacyModel(locations, occupancy) {
  const grouped = new Map();
  locations.forEach((location) => {
    if (!location || !location.wh || !location.rack) return;
    const id = rackId(location.wh, location.zone || '', location.rack);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(location);
  });
  const racks = [...grouped.entries()]
    .sort(([, a], [, b]) => natural(a[0].zone, b[0].zone) || natural(a[0].rack, b[0].rack))
    .map(([id, rows], rackIndex) => {
      const shelves = [...new Set(rows.map((row) => String(row.shelf || '1')))].sort(natural);
      const slotCodes = [...new Set(rows.map((row) => String(row.slot || '1')))].sort(natural);
      const width = Math.max(290, slotCodes.length * 270 + 20);
      const height = Math.max(110, shelves.length * 80 + 30);
      return {
        id,
        warehouseId: rows[0].wh,
        zone: rows[0].zone || '',
        code: rows[0].rack,
        positionCm: { x: (rackIndex % 4) * 1000, y: 0, z: Math.floor(rackIndex / 4) * 600 },
        rotationYDeg: 0,
        dimensionsCm: { width, height, depth: 110 },
        materialType: 'powder_coated_steel',
        slots: rows.map((row) => {
          const shelfIndex = Math.max(0, shelves.indexOf(String(row.shelf || '1')));
          const slotIndex = Math.max(0, slotCodes.indexOf(String(row.slot || '1')));
          return {
            id: row.code,
            shelfCode: String(row.shelf || '1'),
            slotCode: String(row.slot || '1'),
            localPositionCm: {
              x: (slotIndex - (slotCodes.length - 1) / 2) * 270,
              y: 75 + shelfIndex * 150,
              z: 0,
            },
              dimensionsCm: { width: 270, height: 140, depth: 110 },
            // A stored box is rendered as a box, not as a red "full" warning.
            // Red is reserved for an explicit full report from PDA/web.
            barcode: row.barcode || row.code,
            status: row.reportedFullAt ? 'full' : 'empty',
          };
        }),
      };
    });
  return {
    schemaVersion: 1,
    sourceUnit: 'cm',
    worldUnit: 'm',
    scaleToWorldUnit: CM_TO_M,
    warehouseId: locations[0]?.wh || null,
    racks,
    boxes: [],
    stats: { racks: racks.length, slots: racks.reduce((sum, rack) => sum + rack.slots.length, 0), boxes: 0 },
    fallback: true,
  };
}

async function loadModel(locations, occupancy) {
  const warehouseId = locations.find((location) => location?.wh)?.wh || '';
  if (!warehouseId) return legacyModel(locations, occupancy);
  try {
    const response = await fetch(`/api/warehouse-3d?warehouseId=${encodeURIComponent(warehouseId)}`, {
      headers: { Authorization: `Bearer ${token()}` },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const model = await response.json();
    if (!Array.isArray(model.racks) || !model.racks.length) return legacyModel(locations, occupancy);
    return model;
  } catch (error) {
    console.warn('[Warehouse3D] geometry API unavailable; using Location Master defaults.', error);
    return legacyModel(locations, occupancy);
  }
}

function concreteTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d');
  context.fillStyle = '#343a42';
  context.fillRect(0, 0, 128, 128);
  let seed = 7319;
  for (let i = 0; i < 2600; i += 1) {
    seed = (seed * 16807) % 2147483647;
    const x = seed % 128;
    seed = (seed * 16807) % 2147483647;
    const y = seed % 128;
    const alpha = 0.025 + (seed % 7) * 0.006;
    context.fillStyle = `rgba(255,255,255,${alpha})`;
    context.fillRect(x, y, 1, 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(10, 10);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function floorMarkTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 1400;
  canvas.height = 180;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(219,255,150,.96)';
  context.font = '800 96px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.shadowColor = 'rgba(0,0,0,.85)';
  context.shadowBlur = 8;
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function safetyZoneSignTexture(zone) {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 360;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  // Match rack names exactly: white type with a black industrial outline.
  context.lineJoin = 'round';
  context.lineWidth = 22;
  context.strokeStyle = '#050505';
  context.fillStyle = '#ffffff';
  context.font = '900 142px system-ui, sans-serif';
  context.strokeText(`โซน ${zone}`, canvas.width / 2, canvas.height / 2);
  context.fillText(`โซน ${zone}`, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function rackNameTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 1400;
  canvas.height = 260;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  // The white type and black outline stay legible over a yellow beam or a
  // light shelf without needing an opaque sign background.
  context.font = '900 148px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.lineWidth = 24;
  context.strokeStyle = '#050505';
  context.fillStyle = '#ffffff';
  context.strokeText(text, canvas.width / 2, canvas.height / 2);
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function code128LabelTexture(value) {
  const code = String(value ?? '');
  const codes = [104]; // Start Code B — matches ZPL ^BC for our ASCII location IDs.
  let checksum = 104;
  for (let index = 0; index < code.length; index += 1) {
    const raw = code.charCodeAt(index) - 32;
    const item = raw >= 0 && raw <= 94 ? raw : 0;
    codes.push(item);
    checksum += item * (index + 1);
  }
  codes.push(checksum % 103, 106);
  const modules = [10];
  codes.forEach((item) => CODE128_PATTERNS[item].split('').forEach((width) => modules.push(Number(width))));
  modules.push(10);
  const moduleTotal = modules.reduce((sum, width) => sum + width, 0);
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 210;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const left = 30;
  const top = 18;
  const barHeight = 145;
  const unit = (canvas.width - left * 2) / moduleTotal;
  let x = left;
  let isBar = false;
  modules.forEach((width) => {
    if (isBar) {
      context.fillStyle = '#050505';
      context.fillRect(Math.round(x), top, Math.ceil(width * unit), barHeight);
    }
    x += width * unit;
    isBar = !isBar;
  });
  context.fillStyle = '#111111';
  context.font = '700 21px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  context.textAlign = 'center';
  context.fillText(code, canvas.width / 2, 193);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.NearestFilter;
  return texture;
}

function cartonHandlingTexture(value) {
  const canvas = document.createElement('canvas');
  canvas.width = 560;
  canvas.height = 320;
  const context = canvas.getContext('2d');
  context.fillStyle = '#d8c48e';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#5b4028';
  context.lineWidth = 14;
  context.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
  context.fillStyle = '#5b4028';
  context.textAlign = 'center';
  context.font = '900 48px Arial, sans-serif';
  context.fillText('THIS SIDE UP', canvas.width / 2, 88);
  context.font = '900 42px Arial, sans-serif';
  context.fillText('↑     ↑', canvas.width / 2, 150);
  context.font = '700 31px ui-monospace, monospace';
  context.fillText(String(value ?? ''), canvas.width / 2, 245);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function assetPipeline(renderer) {
  const draco = new DRACOLoader();
  draco.setDecoderPath(`https://unpkg.com/three@${THREE_VERSION}/examples/jsm/libs/draco/`);
  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath(`https://unpkg.com/three@${THREE_VERSION}/examples/jsm/libs/basis/`);
  ktx2.detectSupport(renderer);
  const gltf = new GLTFLoader();
  gltf.setDRACOLoader(draco);
  gltf.setKTX2Loader(ktx2);
  return {
    load: (url) => gltf.loadAsync(url),
    dispose() { draco.dispose(); ktx2.dispose(); },
  };
}

function matrixAt(position, quaternion, scale) {
  return new THREE.Matrix4().compose(position, quaternion, scale);
}

function worldPoint(rack, localX, localY, localZ) {
  const rotation = THREE.MathUtils.degToRad(num(rack.rotationYDeg));
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const x = num(localX) * CM_TO_M;
  const z = num(localZ) * CM_TO_M;
  return new THREE.Vector3(
    num(rack.positionCm?.x) * CM_TO_M + x * cos + z * sin,
    num(rack.positionCm?.y) * CM_TO_M + num(localY) * CM_TO_M,
    num(rack.positionCm?.z) * CM_TO_M - x * sin + z * cos,
  );
}

function rendererName(renderer) {
  const backend = String(renderer?.backend?.constructor?.name || '');
  if (/webgpu/i.test(backend)) return 'WebGPU';
  if (/webgl/i.test(backend)) return 'WebGL 2 fallback';
  return navigator.gpu ? 'WebGPU' : 'WebGL 2 fallback';
}

async function createScene(canvas, model, onSelect, onBoxSelect, onWarehouseNavigate) {
  const stage = canvas.parentElement;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101419);
  scene.fog = new THREE.FogExp2(0x101419, 0.012);

  // Prefer WebGPU, but do not let a browser/driver with partial WebGPU support
  // leave the whole warehouse view on a blank error state.
  let renderer;
  if (navigator.gpu) {
    try {
      renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false });
      await renderer.init();
    } catch (error) {
      console.warn('[Warehouse3D] WebGPU init failed; falling back to WebGL 2.', error);
      try { renderer?.dispose?.(); } catch (_) { /* best effort */ }
      renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
    }
  } else {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (renderer.init) await renderer.init();

  const camera = new THREE.PerspectiveCamera(52, 1, 0.02, 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  // Rack bays are sub-metre objects. Keep the near plane and orbit limit low
  // enough to inspect an individual tote/box, not merely the whole rack.
  controls.minDistance = 0.28;
  controls.maxDistance = 260;

  const hemisphereLight = new THREE.HemisphereLight(0xdcecff, 0x20252b, 1.75);
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.48);
  scene.add(hemisphereLight);
  scene.add(ambientLight);
  const sun = new THREE.DirectionalLight(0xfff3de, 2.25);
  sun.position.set(-18, 28, 14);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.025;
  scene.add(sun);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'loc3d-label-layer';
  stage.appendChild(labelRenderer.domElement);
  const labelElement = document.createElement('div');
  labelElement.className = 'loc3d-slot-label empty';
  labelElement.textContent = 'ว่าง';
  const labelObject = new CSS2DObject(labelElement);
  labelObject.visible = false;
  scene.add(labelObject);

  const warehouseLabel = String(model.warehouseName || model.warehouseId || 'คลังสินค้า');
  const warehouseTitle = document.createElement('div');
  warehouseTitle.className = 'loc3d-warehouse-title';
  const warehouseTitleCaption = document.createElement('span');
  warehouseTitleCaption.textContent = 'กำลังดูพื้นที่จัดเก็บ';
  const warehouseTitleRow = document.createElement('div');
  warehouseTitleRow.className = 'loc3d-warehouse-title-row';
  const warehouseTitleName = document.createElement('strong');
  // This header describes the whole scene. Zone labels belong on their
  // physical safety markers below, never in place of the warehouse name.
  warehouseTitleName.textContent = warehouseLabel;
  if (typeof onWarehouseNavigate === 'function') {
    warehouseTitle.classList.add('is-switchable');
    const makeWarehouseArrow = (direction, label, icon) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'loc3d-warehouse-arrow';
      button.setAttribute('aria-label', label);
      button.title = label;
      button.textContent = icon;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onWarehouseNavigate(direction);
      });
      return button;
    };
    warehouseTitleRow.append(
      makeWarehouseArrow(-1, 'คลังก่อนหน้า', '‹'),
      warehouseTitleName,
      makeWarehouseArrow(1, 'คลังถัดไป', '›'),
    );
  } else warehouseTitleRow.append(warehouseTitleName);
  warehouseTitle.append(warehouseTitleCaption, warehouseTitleRow);
  stage.appendChild(warehouseTitle);

  // A small contextual action that follows the currently hovered rack. It is
  // deliberately a CSS2D button so it feels attached to the physical model.
  const rackActionButton = document.createElement('button');
  rackActionButton.type = 'button';
  rackActionButton.className = 'loc3d-rack-action';
  rackActionButton.setAttribute('aria-label', 'เครื่องมือแร็ก ยังไม่พร้อมใช้งาน');
  rackActionButton.title = 'เครื่องมือแร็ก (ยังไม่พร้อมใช้งาน)';
  rackActionButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.6 7.6 0 0 0-1.7-.98L14.5 2.42A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.61.25-1.18.58-1.7.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.02.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.09.73 1.7.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .5-.42l.38-2.65c.61-.25 1.18-.58 1.7-.98l2.49 1a.5.5 0 0 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>';
  const rackActionObject = new CSS2DObject(rackActionButton);
  rackActionObject.visible = false;
  scene.add(rackActionObject);
  let actionPointerOver = false;
  rackActionButton.addEventListener('pointerenter', () => { actionPointerOver = true; });
  rackActionButton.addEventListener('pointerleave', () => { actionPointerOver = false; });
  rackActionButton.addEventListener('pointerdown', (event) => event.stopPropagation());
  rackActionButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const toastZone = document.getElementById('toastZone');
    const fullscreenHost = document.fullscreenElement;
    const originalToastParent = toastZone?.parentElement;
    const movedToastIntoFullscreen = Boolean(fullscreenHost && toastZone && !fullscreenHost.contains(toastZone));
    if (movedToastIntoFullscreen) fullscreenHost.appendChild(toastZone);
    window.toast?.('เครื่องมือแร็กยังไม่พร้อมใช้งาน', '', 'ok');
    if (movedToastIntoFullscreen) {
      window.setTimeout(() => {
        if (toastZone.parentElement === fullscreenHost && originalToastParent) originalToastParent.appendChild(toastZone);
      }, 3200);
    }
  });

  const hud = document.createElement('div');
  hud.className = 'loc3d-hud';
  hud.innerHTML = `<span class="ok">1 unit = 1 m</span><span>${rendererName(renderer)}</span><span>${model.stats?.racks || 0} แร็ก · ${model.stats?.slots || 0} ช่อง · ${model.stats?.boxes || 0} กล่อง</span>${model.stats?.stagingBoxes ? `<span class="warn">รอ Putaway ${model.stats.stagingBoxes} กล่อง</span>` : ''}<span class="loc3d-perf">กำลังวัด FPS…</span>`;
  stage.appendChild(hud);

  // Keep the scene controls inside the 3D stage, so fullscreen expands only
  // the warehouse view instead of the whole application shell.
  const fullscreenButton = document.createElement('button');
  fullscreenButton.type = 'button';
  fullscreenButton.className = 'loc3d-fullscreen';
  fullscreenButton.setAttribute('aria-label', 'ขยายมุมมอง 3D เต็มจอ');
  fullscreenButton.title = 'เต็มจอ';
  fullscreenButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M21 16v4a1 1 0 0 1-1 1h-4M3 16v4a1 1 0 0 0 1 1h4"/><path d="M8 8 3 3m13 5 5-5M8 16l-5 5m13-5 5 5"/></svg>';
  const firstPersonButton = document.createElement('button');
  firstPersonButton.type = 'button';
  firstPersonButton.className = 'loc3d-first-person';
  firstPersonButton.setAttribute('aria-label', 'มุมมองบุคคลที่หนึ่ง');
  firstPersonButton.title = 'มุมมองคนเดิน · ใช้ W A S D';
  firstPersonButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.5"/><path d="M7.5 21 9 13l3-3 3 3 1.5 8M9 13 5 16m10-3 4 3M12 10V7.5"/></svg>';
  const firstPersonOverlay = document.createElement('div');
  firstPersonOverlay.className = 'loc3d-first-person-overlay';
  firstPersonOverlay.setAttribute('aria-hidden', 'true');
  const firstPersonHint = document.createElement('div');
  firstPersonHint.className = 'loc3d-first-person-shortcut';
  const isEnglish = () => {
    try { return localStorage.getItem('smarttrace_lang') === 'en'; } catch { return false; }
  };
  const updateFirstPersonCopy = () => {
    const english = isEnglish();
    firstPersonButton.title = english ? 'First-person view · press F' : 'มุมมองคนเดิน · กด F';
    fullscreenButton.title = english ? 'Fullscreen · press M' : 'เต็มจอ · กด M';
    firstPersonHint.innerHTML = english
      ? '<kbd>F</kbd> First-person · <kbd>WASD</kbd> move · <kbd>M</kbd> fullscreen'
      : '<kbd>F</kbd> มุมมองคนเดิน · <kbd>WASD</kbd> เดิน · <kbd>M</kbd> เต็มจอ';
    firstPersonOverlay.innerHTML = english
      ? '<i class="loc3d-reticle"></i><div class="loc3d-first-person-help"><b>First-person mode</b><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>Shift</kbd> run · <kbd>Space</kbd> jump · mouse look · left click interact · <kbd>Esc</kbd> exit</span></div>'
      : '<i class="loc3d-reticle"></i><div class="loc3d-first-person-help"><b>โหมดคนเดิน</b><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> เดิน · <kbd>Shift</kbd> วิ่ง · <kbd>Ctrl</kbd> ย่อ · <kbd>Space</kbd> กระโดด · เมาส์มอง · คลิกซ้ายโต้ตอบ · <kbd>Esc</kbd> ออก</span></div>';
  };
  updateFirstPersonCopy();
  let firstPerson = false;
  const walkKeys = new Set();
  const walkEyeHeight = 1.7;
  let walkVerticalVelocity = 0;
  let walkJumpHeight = 0;
  let walkHeadBobPhase = 0;
  let walkHeadBobOffset = 0;
  // Opening the app's normal modal/drawer must temporarily release browser
  // pointer lock, not end the walk session. Camera position/rotation stay on
  // the same camera object, then lock is restored once the panel closes.
  let resumeFirstPersonAfterModal = false;
  const exitFirstPerson = () => {
    resumeFirstPersonAfterModal = false;
    firstPerson = false;
    firstPersonButton.classList.toggle('active', firstPerson);
    firstPersonButton.setAttribute('aria-pressed', String(firstPerson));
    controls.enabled = true;
    walkKeys.clear();
    walkVerticalVelocity = 0;
    walkJumpHeight = 0;
    walkHeadBobOffset = 0;
    stage.classList.remove('loc3d-first-person-active');
    firstPersonOverlay.classList.remove('show');
    if (document.pointerLockElement === canvas) document.exitPointerLock?.();
  };
  const enterFirstPerson = () => {
    firstPerson = true;
    firstPersonButton.classList.add('active');
    firstPersonButton.setAttribute('aria-pressed', 'true');
    controls.enabled = false;
    // OrbitControls can leave the camera pitched sharply down or with a tiny
    // roll depending on the warehouse's previous overview angle. A walking
    // camera must always enter level at eye height; retain yaw only.
    camera.rotation.order = 'YXZ';
    camera.rotation.x = 0;
    camera.rotation.z = 0;
    camera.position.y = warehouseFloorY + walkEyeHeight;
    stage.classList.add('loc3d-first-person-active');
    firstPersonOverlay.classList.add('show');
    canvas.requestPointerLock?.();
    window.toast?.('โหมดคนเดิน · WASD เดิน, Shift วิ่ง, Space กระโดด, เมาส์มอง, Esc ออก', '', 'ok');
  };
  const toggleFirstPerson = () => {
    if (firstPerson) exitFirstPerson();
    else enterFirstPerson();
  };
  firstPersonButton.addEventListener('click', toggleFirstPerson);
  const onFirstPersonShortcut = (event) => {
    if (event.code !== 'KeyF' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target?.matches?.('input,textarea,select,[contenteditable="true"]')) return;
    toggleFirstPerson();
    event.preventDefault();
  };
  window.addEventListener('keydown', onFirstPersonShortcut, { passive: false });
  const onWalkKey = (event) => {
    if (!firstPerson || event.metaKey || event.altKey || (event.ctrlKey && !['ControlLeft', 'ControlRight'].includes(event.code))) return;
    if (event.code === 'Escape' && event.type === 'keydown') {
      exitFirstPerson();
      event.preventDefault();
      return;
    }
    if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Space'].includes(event.code)) return;
    if (event.code === 'Space' && event.type === 'keydown' && walkVerticalVelocity === 0) walkVerticalVelocity = 5.1;
    if (event.type === 'keydown') walkKeys.add(event.code);
    else walkKeys.delete(event.code);
    event.preventDefault();
  };
  window.addEventListener('keydown', onWalkKey, { passive: false });
  window.addEventListener('keyup', onWalkKey, { passive: false });
  // First-person input owns browser-like shortcuts while the canvas has focus.
  // Browsers may reserve a few OS-level commands (notably Ctrl+W), but this
  // capture handler prevents every cancelable shortcut from escaping the game.
  const onFirstPersonBrowserShortcut = (event) => {
    if (!firstPerson || !event.ctrlKey || event.altKey || event.metaKey) return;
    if (!['KeyW', 'KeyR', 'KeyL', 'KeyT', 'KeyN', 'KeyD', 'KeyH', 'KeyJ', 'KeyK', 'KeyP', 'Tab', 'F5', 'F6'].includes(event.code)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('keydown', onFirstPersonBrowserShortcut, { capture: true, passive: false });
  const onPointerLockChange = () => {
    // Escape and browser chrome both release pointer lock. Treat that as
    // leaving the walking mode so camera controls return predictably.
    if (firstPerson && document.pointerLockElement !== canvas && !resumeFirstPersonAfterModal) exitFirstPerson();
    if (document.pointerLockElement === canvas) resumeFirstPersonAfterModal = false;
  };
  document.addEventListener('pointerlockchange', onPointerLockChange);
  let fallbackFullscreen = false;
  const setFallbackFullscreen = (enabled) => {
    fallbackFullscreen = enabled;
    stage.classList.toggle('loc3d-mobile-fullscreen', enabled);
    document.body.classList.toggle('loc3d-body-fullscreen', enabled);
    syncFullscreenPortals();
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
    camera.aspect = stage.clientWidth / Math.max(1, stage.clientHeight);
    camera.updateProjectionMatrix();
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === stage || fallbackFullscreen) {
        if (document.fullscreenElement === stage) await document.exitFullscreen();
        setFallbackFullscreen(false);
      }
      else {
        const target = stage.requestFullscreen || stage.webkitRequestFullscreen ? stage : canvas;
        const request = target.requestFullscreen || target.webkitRequestFullscreen;
        if (request) await request.call(target);
        else setFallbackFullscreen(true);
      }
      canvas.focus?.();
    } catch (error) {
      console.warn('[Warehouse3D] fullscreen unavailable', error);
      // iOS Safari may expose the method but reject it; use a fixed viewport
      // fallback so iPhone and Android still get a true edge-to-edge canvas.
      setFallbackFullscreen(true);
    }
  };
  fullscreenButton.addEventListener('click', toggleFullscreen);
  const onFullscreenShortcut = (event) => {
    if (event.code !== 'KeyM' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target?.matches?.('input,textarea,select,[contenteditable="true"]')) return;
    toggleFullscreen();
    event.preventDefault();
  };
  window.addEventListener('keydown', onFullscreenShortcut, { passive: false });
  stage.appendChild(fullscreenButton);
  stage.appendChild(firstPersonButton);
  stage.appendChild(firstPersonHint);
  stage.appendChild(firstPersonOverlay);

  // Fullscreen only renders descendants of the fullscreen element. Portal
  // the app's existing modal/drawer layers into the 3D stage while fullscreen
  // is active so slot and box clicks still open the normal system UI.
  const fullscreenPortals = ['modal', 'alertM', 'drawer']
    .map((id) => document.getElementById(id))
    .filter(Boolean)
    .map((element) => ({ element, parent: element.parentElement, nextSibling: element.nextSibling }));
  const syncFullscreenPortals = () => {
    const isThisStageFullscreen = document.fullscreenElement === stage || fallbackFullscreen;
    fullscreenPortals.forEach(({ element, parent, nextSibling }) => {
      if (isThisStageFullscreen) {
        if (!stage.contains(element)) stage.appendChild(element);
      } else if (element.parentElement !== parent) {
        if (nextSibling && nextSibling.parentElement === parent) parent.insertBefore(element, nextSibling);
        else parent.appendChild(element);
      }
    });
  };
  document.addEventListener('fullscreenchange', syncFullscreenPortals);
  syncFullscreenPortals();
  const releasePointerForModal = () => {
    if (firstPerson && document.pointerLockElement === canvas) {
      resumeFirstPersonAfterModal = true;
      document.exitPointerLock?.();
    }
  };
  const modalPointerObserver = new MutationObserver(() => {
    const hasOpenModal = fullscreenPortals.some(({ element }) => element.classList.contains('show'));
    if (hasOpenModal) releasePointerForModal();
    else if (resumeFirstPersonAfterModal && firstPerson) {
      window.setTimeout(() => {
        const stillOpen = fullscreenPortals.some(({ element }) => element.classList.contains('show'));
        if (resumeFirstPersonAfterModal && firstPerson && !stillOpen && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
      }, 0);
    }
  });
  fullscreenPortals.forEach(({ element }) => modalPointerObserver.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'] }));

  const rackEntries = [];
  const slotEntries = [];
  const uprightParts = [];
  const beamParts = [];
  const deckParts = [];
  const braceParts = [];
  const basePlateParts = [];
  const consumerUnitPickMeshes = [];
  const dockDoorPickMeshes = [];
  const dockDoors = [];
  const consumerPowerIndicators = [];
  const consumerPowerIndicatorLights = [];
  const warehousePowerFixtures = [];
  const warehousePowerLights = [];
  const bounds = new THREE.Box3();
  const boundPoint = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  // Visual plan only — rack/slot identity stays DB-owned. Racks in a zone are
  // paired back-to-back: their rear frames are almost flush, while their
  // loading faces point out to the two service aisles. Consecutive pairs
  // continue at the row end (Z), preserving clear travel routes for forklifts.
  const racksByZone = new Map();
  model.racks.forEach((rack) => {
    const key = String(rack.zone || '—');
    const list = racksByZone.get(key) || [];
    list.push(rack);
    racksByZone.set(key, list);
  });
  const zoneKeys = [...racksByZone.keys()].sort(natural);
  const displayTransformByRackId = new Map();
  const outerRackIds = new Set();
  // Back-to-back frames share their rear line. Keep only a 1 cm numerical
  // tolerance so they look flush without z-fighting their steel meshes.
  const rackBackClearance = 0.01;
  const zoneGap = 3.5;
  const rowGap = 1.15;
  const placements = [];
  let zoneCursorX = 0;
  zoneKeys.forEach((zone) => {
    const zoneRacks = [...(racksByZone.get(zone) || [])].sort((a, b) => natural(a.code, b.code));
    const maxDepth = Math.max(...zoneRacks.map((rack) => positive(rack.dimensionsCm?.depth, 110) * CM_TO_M), 1.1);
    const maxLength = Math.max(...zoneRacks.map((rack) => positive(rack.dimensionsCm?.width, 270) * CM_TO_M), 2.7);
    // A small steel-frame clearance prevents mesh overlap, but does not form
    // a fake aisle between the two rear faces.
    zoneRacks.forEach((rack, index) => {
      const isRightSide = index % 2 === 1;
      const rowIndex = Math.floor(index / 2);
      const rackDepth = positive(rack.dimensionsCm?.depth, 110) * CM_TO_M;
      placements.push({
        rack,
        // Align each rack's rear frame to one shared seam. Using the largest
        // rack depth for every centre left an artificial gap when dimensions
        // differ, even though these two racks are meant to touch back-to-back.
        centerX: zoneCursorX + (isRightSide ? 1 : -1) * rackDepth / 2,
        centerZ: rowIndex * (maxLength + rowGap),
        faceRight: isRightSide,
      });
      if (!isRightSide && index === zoneRacks.length - 1) outerRackIds.add(rack.id);
    });
    zoneCursorX += maxDepth * 2 + rackBackClearance + zoneGap;
  });
  if (placements.length) {
    const minX = Math.min(...placements.map(({ centerX, rack }) => centerX - positive(rack.dimensionsCm?.depth, 110) * CM_TO_M / 2));
    const maxX = Math.max(...placements.map(({ centerX, rack }) => centerX + positive(rack.dimensionsCm?.depth, 110) * CM_TO_M / 2));
    const minZ = Math.min(...placements.map(({ centerZ, rack }) => centerZ - positive(rack.dimensionsCm?.width, 270) * CM_TO_M / 2));
    const maxZ = Math.max(...placements.map(({ centerZ, rack }) => centerZ + positive(rack.dimensionsCm?.width, 270) * CM_TO_M / 2));
    const layoutOffsetX = (minX + maxX) / 2;
    const layoutOffsetZ = (minZ + maxZ) / 2;
    placements.forEach(({ rack, centerX, centerZ, faceRight }) => {
      displayTransformByRackId.set(rack.id, {
        positionCm: {
          x: (centerX - layoutOffsetX) * 100,
          y: num(rack.positionCm?.y),
          z: (centerZ - layoutOffsetZ) * 100,
        },
        rotationYDeg: faceRight ? 90 : -90,
      });
    });
  }

  const zoneBounds = new Map();

  model.racks.forEach((sourceRack) => {
    const displayTransform = displayTransformByRackId.get(sourceRack.id);
    const rack = {
      ...sourceRack,
      positionCm: displayTransform?.positionCm ?? sourceRack.positionCm,
      rotationYDeg: displayTransform?.rotationYDeg ?? num(sourceRack.rotationYDeg),
    };
    const rotation = THREE.MathUtils.degToRad(num(rack.rotationYDeg));
    const quaternion = new THREE.Quaternion().setFromAxisAngle(up, rotation);
    const width = positive(rack.dimensionsCm?.width, 140) * CM_TO_M;
    const height = positive(rack.dimensionsCm?.height, 110) * CM_TO_M;
    const depth = positive(rack.dimensionsCm?.depth, 110) * CM_TO_M;
    const frame = Math.min(0.1, width * 0.08, depth * 0.08);
    const base = worldPoint(rack, 0, 0, 0);
    const addPart = (parts, x, y, z, sx, sy, sz) => {
      const position = new THREE.Vector3(x, y, z).applyQuaternion(quaternion).add(base);
      parts.push({ position, quaternion, scale: new THREE.Vector3(sx, sy, sz), rack });
    };
    const addBrace = (x1, y1, z1, x2, y2, z2) => {
      const start = new THREE.Vector3(x1, y1, z1), end = new THREE.Vector3(x2, y2, z2);
      const delta = end.clone().sub(start), length = delta.length();
      if (length < 0.03) return;
      const localRotation = new THREE.Quaternion().setFromUnitVectors(up, delta.normalize());
      const partQuaternion = quaternion.clone().multiply(localRotation);
      const position = start.add(end).multiplyScalar(0.5).applyQuaternion(quaternion).add(base);
      braceParts.push({ position, quaternion: partQuaternion, scale: new THREE.Vector3(frame * 0.34, length, frame * 0.34), rack });
    };
    const shelfBottoms = new Map();
    (rack.slots || []).forEach((slot) => {
      const y = num(slot.localPositionCm?.y) - positive(slot.dimensionsCm?.height, 70) / 2;
      shelfBottoms.set(String(slot.shelfCode), y * CM_TO_M);
    });
    const shelfLevels = [...shelfBottoms.entries()].sort((a, b) => a[1] - b[1]);
    // Uprights between bins are structural steel, not decoration. Generate a
    // divider for every adjacent pair on each shelf so the real rack layout is
    // legible even when translucent slot volumes overlap.
    const shelfSlots = new Map();
    (rack.slots || []).forEach((slot) => {
      const key = String(slot.shelfCode || '1');
      const list = shelfSlots.get(key) || [];
      list.push(slot);
      shelfSlots.set(key, list);
    });
    const widestShelf = [...shelfSlots.values()].sort((a, b) => b.length - a.length)[0] || [];
    widestShelf.sort((a, b) => num(a.localPositionCm?.x) - num(b.localPositionCm?.x));
    // Each DB slot column is one selective-rack bay. Deriving every frame from
    // those columns keeps the 2.7 m bays accurate without inventing inventory.
    const frameXs = [-(width - frame) / 2];
    for (let index = 1; index < widestShelf.length; index += 1) {
      frameXs.push((num(widestShelf[index - 1].localPositionCm?.x) + num(widestShelf[index].localPositionCm?.x)) * CM_TO_M / 2);
    }
    frameXs.push((width - frame) / 2);
    const uniqueFrameXs = [...new Set(frameXs.map((x) => x.toFixed(4)))].map(Number).sort((a, b) => a - b);
    uniqueFrameXs.forEach((x) => [-1, 1].forEach((sideZ) => {
      addPart(uprightParts, x, height / 2, sideZ * (depth - frame) / 2, frame, height, frame);
      addPart(basePlateParts, x, 0.025, sideZ * (depth - frame) / 2, frame * 2.3, 0.05, frame * 2.3);
    }));
    const beamLevels = shelfLevels.map(([, y]) => y).concat([height - 0.04]);
    beamLevels.forEach((y) => {
      for (let index = 0; index < uniqueFrameXs.length - 1; index += 1) {
        const left = uniqueFrameXs[index], right = uniqueFrameXs[index + 1];
        [-1, 1].forEach((sideZ) => addPart(beamParts, (left + right) / 2, y, sideZ * (depth - frame) / 2, right - left, 0.105, frame * 1.28));
      }
    });
    // Braces sit in every depth frame, leaving each bay front unobstructed.
    const braceLevels = shelfLevels.map(([, y]) => y).concat([height - 0.04]);
    for (let index = 0; index < braceLevels.length - 1; index += 1) {
      const low = braceLevels[index] + 0.07, high = braceLevels[index + 1] - 0.07;
      uniqueFrameXs.forEach((x) => {
        const z = (depth - frame) / 2;
        addBrace(x, low, -z, x, high, z);
        addBrace(x, low, z, x, high, -z);
      });
    }
    const rackEntry = { rack, quaternion, width, height, depth, base, collisionBox: null };
    rackEntries.push(rackEntry);
    // All eight rotated corners are required here. Using only a diagonal pair
    // underestimates a 90-degree rack and can clip the floor/camera framing.
    const corners = [-1, 1].flatMap((sideX) => [-1, 1].flatMap((sideZ) => [0, 1].map((sideY) =>
      worldPoint(
        rack,
        sideX * width / CM_TO_M / 2,
        sideY * height / CM_TO_M,
        sideZ * depth / CM_TO_M / 2,
      ))));
    const collisionBox = new THREE.Box3();
    corners.forEach((point) => {
      bounds.expandByPoint(point);
      collisionBox.expandByPoint(point);
      const zone = String(rack.zone || '—');
      const zoneBox = zoneBounds.get(zone) || new THREE.Box3();
      zoneBox.expandByPoint(point);
      zoneBounds.set(zone, zoneBox);
    });
    // The camera may approach a bay closely, but never pass through its steel
    // frame. Expand the physical footprint slightly for a natural clearance.
    rackEntry.collisionBox = collisionBox.expandByScalar(0.24);

    (rack.slots || []).forEach((slot) => {
      const position = worldPoint(rack, slot.localPositionCm?.x, slot.localPositionCm?.y, slot.localPositionCm?.z);
      slotEntries.push({
        rack,
        slot,
        position,
        quaternion,
        scale: new THREE.Vector3(
          positive(slot.dimensionsCm?.width, 110) * CM_TO_M,
          positive(slot.dimensionsCm?.height, 70) * CM_TO_M,
          positive(slot.dimensionsCm?.depth, 100) * CM_TO_M,
        ),
      });
      bounds.expandByPoint(boundPoint.copy(position));
    });
  });

  const addRackBatch = (parts, material) => {
    if (!parts.length) return null;
    const mesh = new THREE.InstancedMesh(UNIT_BOX, material, parts.length);
    parts.forEach((part, index) => mesh.setMatrixAt(index, matrixAt(part.position, part.quaternion, part.scale)));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.rackByInstance = parts.map((part) => part.rack);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.computeBoundingBox(); mesh.computeBoundingSphere(); scene.add(mesh);
    return mesh;
  };
  // Industrial palette from the reference: blue uprights/bracing and orange
  // load beams. No continuous white shelf deck is rendered.
  const rackPickMeshes = [
    addRackBatch(uprightParts, new THREE.MeshStandardMaterial({ color: 0x1268cf, metalness: 0.72, roughness: 0.3 })),
    addRackBatch(beamParts, new THREE.MeshStandardMaterial({ color: 0xf28a12, metalness: 0.45, roughness: 0.38 })),
    addRackBatch(deckParts, new THREE.MeshStandardMaterial({ color: 0xd8dde0, metalness: 0.3, roughness: 0.56 })),
    addRackBatch(braceParts, new THREE.MeshStandardMaterial({ color: 0x1680d8, metalness: 0.7, roughness: 0.3 })),
    addRackBatch(basePlateParts, new THREE.MeshStandardMaterial({ color: 0x1268cf, metalness: 0.72, roughness: 0.3 })),
  ].filter(Boolean);

  const occupiedSlotIds = new Set((model.boxes || []).map((box) => String(box.slotId)));
  const slotState = (entry) => entry.slot.status === 'full'
    ? 'full'
    : occupiedSlotIds.has(String(entry.slot.id)) ? 'occupied' : 'empty';
  let showOccupiedSlots = true;
  const slotColor = (entry, revealOccupied = showOccupiedSlots) => {
    const state = slotState(entry);
    // Occupancy is intentionally quiet in the overview. The orange hover
    // treatment is applied only by updatePointer to the slot under the cursor.
    return state === 'full' ? FULL_COLOR : EMPTY_COLOR;
  };
  const slotMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    colorWrite: false,
    depthWrite: false,
  });
  const slotMesh = slotEntries.length ? new THREE.InstancedMesh(UNIT_BOX, slotMaterial, slotEntries.length) : null;
  if (slotMesh) {
    slotEntries.forEach((entry, index) => {
      slotMesh.setMatrixAt(index, matrixAt(entry.position, entry.quaternion, entry.scale));
      slotMesh.setColorAt(index, slotColor(entry));
    });
    slotMesh.instanceMatrix.needsUpdate = true;
    slotMesh.instanceColor.needsUpdate = true;
    slotMesh.computeBoundingBox();
    slotMesh.computeBoundingSphere();
    scene.add(slotMesh);
  }

  const slotById = new Map(slotEntries.map((entry) => [entry.slot.id, entry]));
  const labelTextures = [];
  const barcodeStickers = [];
  const boxBarcodeStickers = [];
  const rackNameLabels = [];
  // Model the actual ZPL/Code128 sticker as a plane fixed to the FRONT shelf
  // beam. It is part of the rack, never a floating screen-space caption.
  // A location label is required for every DB slot. Do not silently omit
  // labels in a real warehouse simply because it has more than 250 slots.
  slotEntries.forEach((entry) => {
      const texture = code128LabelTexture(entry.slot.barcode || entry.slot.id);
      labelTextures.push(texture);
      // Shelf-edge ticket: intentionally smaller than the box opening (and a
      // typical tote), like a 7-Eleven price label rather than a hanging sign.
      const width = Math.min(0.46, Math.max(0.28, entry.scale.x * 0.18));
      const height = Math.min(0.12, width / 4.2);
      const sticker = new THREE.Mesh(
        new THREE.PlaneGeometry(width, height),
        new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.DoubleSide, depthTest: true, depthWrite: true }),
      );
      // Keep the small barcode above the beam's front edge and in front of
      // the rack so it remains readable at close and medium zoom levels.
      // Centre the location barcode on the yellow shelf beam, like a real
      // shelf-edge label, instead of floating above the beam.
      const frontOffset = new THREE.Vector3(0, -entry.scale.y / 2 + 0.005, entry.scale.z / 2 + 0.014)
        .applyQuaternion(entry.quaternion);
      sticker.position.copy(entry.position).add(frontOffset);
      sticker.quaternion.copy(entry.quaternion);
      sticker.renderOrder = 0;
      scene.add(sticker);
      barcodeStickers.push(sticker);
    });
  rackEntries.forEach((entry) => {
    // Mount the rack name upright on its front top beam. It follows the rack
    // while remaining readable instead of lying flat on top of the beam.
    const texture = rackNameTexture(`แร็ค ${entry.rack.code}`);
    labelTextures.push(texture);
    const labelWidth = Math.min(entry.width * 0.72, Math.max(0.7, entry.depth * 2.5));
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(labelWidth, labelWidth * (260 / 1400)),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthWrite: false, side: THREE.DoubleSide }),
    );
    label.quaternion.copy(entry.quaternion);
    label.position.copy(worldPoint(entry.rack, 0, entry.height / CM_TO_M - 5.5, entry.depth / CM_TO_M / 2 + 7));
    label.visible = false;
    scene.add(label);
    rackNameLabels.push(label);
  });
  const materialColors = {
    carton: 0xb7804f,
    plastic_crate: 0x2f83d0,
    metal_box: 0x8d98a5,
    generic: 0xd6a65b,
  };
  const boxesBySlot = new Map();
  (model.boxes || []).forEach((box) => {
    const boxesInSlot = boxesBySlot.get(String(box.slotId)) || [];
    boxesInSlot.push(box);
    boxesBySlot.set(String(box.slotId), boxesInSlot);
  });
  boxesBySlot.forEach((boxesInSlot) => boxesInSlot.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true })));
  const boxEntries = (model.boxes || []).flatMap((box) => {
    const slotEntry = slotById.get(box.slotId);
    if (!slotEntry) return [];
    const width = positive(box.dimensionsCm?.width, 60) * CM_TO_M;
    const height = positive(box.dimensionsCm?.height, 40) * CM_TO_M;
    const depth = positive(box.dimensionsCm?.depth, 40) * CM_TO_M;
    const boxesInSlot = boxesBySlot.get(String(box.slotId)) || [box];
    const boxIndex = Math.max(0, boxesInSlot.indexOf(box));
    // A slot carries two pallet positions. Spread every stored box across the
    // DB-defined slot width so records do not render directly on top of each
    // other, while retaining each box's own dimensions from the API.
    const spread = boxesInSlot.length > 1
      ? Math.min(width * 1.25, Math.max(0, (slotEntry.scale.x - width) / Math.max(1, boxesInSlot.length - 1)))
      : 0;
    const lateralOffsetCm = (boxIndex - (boxesInSlot.length - 1) / 2) * spread / CM_TO_M;
    const slotBottomCm = num(slotEntry.slot.localPositionCm?.y) - positive(slotEntry.slot.dimensionsCm?.height, 70) / 2;
    const position = worldPoint(
      slotEntry.rack,
      num(slotEntry.slot.localPositionCm?.x) + lateralOffsetCm,
      slotBottomCm + 16 + height / CM_TO_M / 2,
      slotEntry.slot.localPositionCm?.z,
    );
    const oversized = width > slotEntry.scale.x || height > slotEntry.scale.y || depth > slotEntry.scale.z;
    return [{
      box,
      slotEntry,
      position,
      quaternion: slotEntry.quaternion,
      scale: new THREE.Vector3(width, height, depth),
      color: new THREE.Color(oversized ? 0xff3bd4 : (materialColors[box.materialType] || materialColors.generic)),
    }];
  });
  const boxMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.69, metalness: 0.04 });
  const boxMesh = boxEntries.length ? new THREE.InstancedMesh(UNIT_BOX, boxMaterial, boxEntries.length) : null;
  if (boxMesh) {
    boxEntries.forEach((entry, index) => {
      boxMesh.setMatrixAt(index, matrixAt(entry.position, entry.quaternion, entry.scale));
      boxMesh.setColorAt(index, entry.color);
    });
    boxMesh.instanceMatrix.needsUpdate = true;
    boxMesh.instanceColor.needsUpdate = true;
    boxMesh.castShadow = boxMesh.receiveShadow = true;
    boxMesh.computeBoundingBox();
    boxMesh.computeBoundingSphere();
    scene.add(boxMesh);
  }
  // Inbound staging is deliberately a one-box-per-pallet grid, rather than a
  // decorative stack. It keeps the 3D view honest while leaving every waiting
  // box directly selectable for the next forklift/putaway task.
  const stagingBoxPickMeshes = [];
  const stagingEntries = [];
  const stagingBoxes = Array.isArray(model.stagingBoxes) ? model.stagingBoxes : [];
  if (stagingBoxes.length) {
    const stagingBounds = bounds.clone();
    const stagingCenter = stagingBounds.getCenter(new THREE.Vector3());
    const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(stagingBoxes.length))));
    const spacingX = 1.35, spacingZ = 1.55;
    // Putaway staging belongs beside the rack block, not in its front aisle:
    // that front clearance is a forklift travel lane.  The side wall margin
    // is intentionally wide enough for a pallet bay plus a safe approach.
    const startX = stagingBounds.min.x - 6.5;
    const startZ = stagingCenter.z - ((Math.ceil(stagingBoxes.length / columns) - 1) * spacingZ) / 2;
    stagingBoxes.forEach((box, index) => {
      const x = startX + (index % columns) * spacingX;
      const z = startZ + Math.floor(index / columns) * spacingZ;
      const width = Math.min(0.9, positive(box.dimensionsCm?.width, 60) * CM_TO_M);
      const height = Math.min(1.05, positive(box.dimensionsCm?.height, 40) * CM_TO_M);
      const depth = Math.min(1.05, positive(box.dimensionsCm?.depth, 40) * CM_TO_M);
      const carton = new THREE.Mesh(
        UNIT_BOX,
        new THREE.MeshStandardMaterial({ color: materialColors[box.materialType] || materialColors.generic, roughness: 0.68, metalness: 0.03 }),
      );
      carton.position.set(x, 0.12 + height / 2, z);
      carton.scale.set(width, height, depth);
      carton.castShadow = carton.receiveShadow = true;
      carton.userData.stagingBox = box;
      carton.userData.stagingBoxId = box.id;
      scene.add(carton);
      stagingBoxPickMeshes.push(carton);
      stagingEntries.push({
        box,
        position: carton.position.clone(),
        quaternion: carton.quaternion.clone(),
        scale: carton.scale.clone(),
        color: new THREE.Color(materialColors[box.materialType] || materialColors.generic),
      });
    });
    const stagingTexture = floorMarkTexture(`รอ Putaway · ${stagingBoxes.length} กล่อง`);
    labelTextures.push(stagingTexture);
    const stagingRows = Math.ceil(stagingBoxes.length / columns);
    const stagingBorder = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(startX - 0.68, 0.025, startZ - spacingZ * 0.52),
        new THREE.Vector3(startX + (columns - 1) * spacingX + 0.68, 0.025, startZ - spacingZ * 0.52),
        new THREE.Vector3(startX + (columns - 1) * spacingX + 0.68, 0.025, startZ + (stagingRows - 1) * spacingZ + spacingZ * 0.52),
        new THREE.Vector3(startX - 0.68, 0.025, startZ + (stagingRows - 1) * spacingZ + spacingZ * 0.52),
      ]),
      new THREE.LineBasicMaterial({ color: 0xffd34e, transparent: true, opacity: 0.95, depthTest: false }),
    );
    stagingBorder.renderOrder = 10;
    scene.add(stagingBorder);
    const stagingLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(5.2, Math.max(2.5, columns * 1.25)), 0.52),
      new THREE.MeshBasicMaterial({ map: stagingTexture, transparent: true, depthWrite: false, toneMapped: false }),
    );
    stagingLabel.rotation.x = -Math.PI / 2;
    stagingLabel.position.set(startX, 0.01, startZ + stagingRows * spacingZ + 0.18);
    scene.add(stagingLabel);
  }
  // Cartons are deliberately built as physical packages, rather than just a
  // tinted cube: exposed folded seams, packing tape, softened ink markings,
  // and a dark edge profile make their construction readable at close range.
  // BOX-001 is included as a compatibility fallback for data created before
  // material_type was added to the persisted boxes table.
  const cartonEntries = boxEntries.concat(stagingEntries).filter((entry) => entry.box.materialType === 'carton' || entry.box.id === 'BOX-001');
  if (cartonEntries.length <= 80) {
    const cartonEdgeMaterial = new THREE.LineBasicMaterial({ color: 0x68472e, transparent: true, opacity: 0.68 });
    const cartonSeamMaterial = new THREE.MeshStandardMaterial({ color: 0x745037, roughness: 0.92, metalness: 0 });
    const cartonTapeMaterial = new THREE.MeshStandardMaterial({ color: 0xd9bd77, roughness: 0.8, metalness: 0 });
    cartonEntries.forEach((entry) => {
      const placeLocal = (mesh, x, y, z) => {
        mesh.position.copy(new THREE.Vector3(x, y, z).applyQuaternion(entry.quaternion).add(entry.position));
        mesh.quaternion.copy(entry.quaternion);
        if (!entry.slotEntry) mesh.userData.stagingBoxId = entry.box.id;
        scene.add(mesh);
        return mesh;
      };
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(UNIT_BOX), cartonEdgeMaterial);
      if (!entry.slotEntry) edges.userData.stagingBoxId = entry.box.id;
      edges.position.copy(entry.position);
      edges.quaternion.copy(entry.quaternion);
      edges.scale.copy(entry.scale);
      scene.add(edges);

      const topY = entry.scale.y / 2 + 0.006;
      const tape = new THREE.Mesh(
        new THREE.BoxGeometry(Math.min(0.14, entry.scale.x * 0.16), 0.012, entry.scale.z * 0.94),
        cartonTapeMaterial,
      );
      placeLocal(tape, 0, topY, 0);
      [-0.25, 0.25].forEach((fraction) => {
        const seam = new THREE.Mesh(
          new THREE.BoxGeometry(0.014, 0.01, entry.scale.z * 0.94),
          cartonSeamMaterial,
        );
        placeLocal(seam, entry.scale.x * fraction, topY + 0.002, 0);
      });
      const handlingTexture = cartonHandlingTexture(entry.box.id);
      labelTextures.push(handlingTexture);
      const handlingSize = Math.max(0.1, Math.min(entry.scale.x * 0.32, entry.scale.y * 0.34));
      const handlingMark = new THREE.Mesh(
        new THREE.PlaneGeometry(handlingSize, handlingSize * 0.56),
        new THREE.MeshBasicMaterial({ map: handlingTexture, toneMapped: false, side: THREE.DoubleSide }),
      );
      placeLocal(
        handlingMark,
        -entry.scale.x * 0.27,
        entry.scale.y * 0.26,
        entry.scale.z / 2 + 0.004,
      );
      boxBarcodeStickers.push(handlingMark);
    });
  }
  // GTA-style selection marker: one reusable animated ring (not one mesh per
  // box), keeping the hover interaction constant-cost even with many boxes.
  const hoverRingMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd34e, transparent: true, opacity: 0.96, depthWrite: false, depthTest: false,
    side: THREE.DoubleSide,
  });
  const hoverRing = new THREE.Mesh(new THREE.RingGeometry(0.56, 1, 64), hoverRingMaterial);
  hoverRing.rotation.x = -Math.PI / 2;
  hoverRing.visible = false;
  hoverRing.renderOrder = 10;
  scene.add(hoverRing);
  const hoverOutlineMaterial = new THREE.LineBasicMaterial({
    color: 0xffef73, transparent: true, opacity: 0.95, depthTest: false,
  });
  const hoverOutline = new THREE.LineSegments(new THREE.EdgesGeometry(UNIT_BOX), hoverOutlineMaterial);
  hoverOutline.visible = false;
  hoverOutline.renderOrder = 11;
  scene.add(hoverOutline);
  const hoverShell = new THREE.Mesh(
    UNIT_BOX,
    new THREE.MeshBasicMaterial({ color: 0xffd34e, transparent: true, opacity: 0.22, depthWrite: false, depthTest: false, side: THREE.BackSide }),
  );
  hoverShell.visible = false;
  hoverShell.renderOrder = 9;
  scene.add(hoverShell);
  // Every stored box gets its own physical RFID/barcode sticker. The tag is
  // the same identifier the backend exposes for scanners, and the label size
  // is constrained by BOTH the box width and height so it never overhangs.
  if (boxEntries.length + stagingEntries.length <= 250) {
    boxEntries.concat(stagingEntries).forEach((entry) => {
      const labelWidth = Math.min(entry.scale.x * 0.84, entry.scale.y * 3.15);
      if (labelWidth < 0.025) return;
      const labelHeight = labelWidth / 3.65;
      const texture = code128LabelTexture(entry.box.id);
      labelTextures.push(texture);
      const sticker = new THREE.Mesh(
        new THREE.PlaneGeometry(labelWidth, labelHeight),
        new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.DoubleSide }),
      );
      if (!entry.slotEntry) sticker.userData.stagingBoxId = entry.box.id;
      // Slightly proud of the front carton face: a real applied RFID/ZPL
      // label, not a floating caption and never outside the box silhouette.
      const frontOffset = new THREE.Vector3(0, 0, entry.scale.z / 2 + 0.003)
        .applyQuaternion(entry.quaternion);
      sticker.position.copy(entry.position).add(frontOffset);
      sticker.quaternion.copy(entry.quaternion);
      scene.add(sticker);
      boxBarcodeStickers.push(sticker);
    });
  }

  if (bounds.isEmpty()) bounds.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(12, 4, 12));
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const floorMargin = Math.max(2.5, Math.min(7, Math.max(size.x, size.z) * 0.18));
  const floorTexture = concreteTexture();
  floorTexture.repeat.set(Math.max(2, (size.x + floorMargin * 2) / 2), Math.max(2, (size.z + floorMargin * 2) / 2));
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.max(8, size.x + floorMargin * 2), Math.max(8, size.z + floorMargin * 2)),
    new THREE.MeshStandardMaterial({ color: 0xffffff, map: floorTexture, roughness: 0.92, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(center.x, Math.min(0, bounds.min.y) - 0.015, center.z);
  floor.receiveShadow = true;
  scene.add(floor);

  // Size the enclosure once from the real rack footprint. The previous
  // scale-plus-margin calculation enlarged the building twice, making a
  // full-size selective rack look like a miniature in an empty hangar.
  const warehouseMarginX = Math.max(11, Math.min(16, size.x * 0.9));
  const warehouseMarginZ = Math.max(13, Math.min(20, size.z * 4));
  const warehouseWidth = Math.max(36, size.x + warehouseMarginX * 2);
  const warehouseDepth = Math.max(28, size.z + warehouseMarginZ * 2);
  // A selective five-level rack should sit close to the roof eave, like a
  // real warehouse, rather than looking miniature under a tall empty roof.
  const warehouseWallHeight = Math.max(6.2, size.y + 0.72);
  // Keep the gable shallow, as in a standard metal-sheet warehouse rather
  // than using a semi-circular hangar roof.
  const warehouseRoofRise = Math.max(1.05, warehouseWidth * 0.055);
  const warehouseFloorY = floor.position.y;
  const warehouseCenterY = warehouseFloorY + warehouseWallHeight / 2;
  const wallThickness = 0.12;
  // The concrete floor must extend under the complete building, not merely
  // the rack footprint, otherwise roof/wall geometry looks detached below it.
  floor.geometry.dispose();
  floor.geometry = new THREE.PlaneGeometry(warehouseWidth + 1.5, warehouseDepth + 1.5);
  floorTexture.repeat.set(Math.max(2, (warehouseWidth + 1.5) / 2), Math.max(2, (warehouseDepth + 1.5) / 2));
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xf3f6f7, metalness: 0.68, roughness: 0.36, side: THREE.DoubleSide });
  const roofMaterial = new THREE.MeshStandardMaterial({ color: 0x38434a, metalness: 0.72, roughness: 0.5, side: THREE.DoubleSide });
  const trussMaterial = new THREE.MeshStandardMaterial({ color: 0x58788a, metalness: 0.82, roughness: 0.28 });
  const sprinklerPipeMaterial = new THREE.MeshStandardMaterial({ color: 0xbd2730, metalness: 0.5, roughness: 0.32 });
  const wallSpecs = [
    [wallThickness, warehouseWallHeight, warehouseDepth, center.x - warehouseWidth / 2, warehouseCenterY, center.z],
    [wallThickness, warehouseWallHeight, warehouseDepth, center.x + warehouseWidth / 2, warehouseCenterY, center.z],
    [warehouseWidth, warehouseWallHeight, wallThickness, center.x, warehouseCenterY, center.z - warehouseDepth / 2],
    [warehouseWidth, warehouseWallHeight, wallThickness, center.x, warehouseCenterY, center.z + warehouseDepth / 2],
  ];
  wallSpecs.forEach(([width, height, depth, x, y, z]) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), wallMaterial);
    wall.position.set(x, y, z);
    wall.receiveShadow = true;
    scene.add(wall);
  });
  // Corrugated metal-sheet seams make the enclosure read as a real new build.
  const seamMaterial = new THREE.MeshStandardMaterial({ color: 0xb9c3c8, metalness: 0.72, roughness: 0.4 });
  const seamPositions = [];
  for (let x = center.x - warehouseWidth / 2 + 0.65; x < center.x + warehouseWidth / 2; x += 0.65) {
    [-1, 1].forEach((side) => {
      seamPositions.push({ x, y: warehouseCenterY, z: center.z + side * (warehouseDepth / 2 - 0.068), axis: 'z' });
    });
  }
  for (let z = center.z - warehouseDepth / 2 + 0.65; z < center.z + warehouseDepth / 2; z += 0.65) {
    [-1, 1].forEach((side) => {
      seamPositions.push({ x: center.x + side * (warehouseWidth / 2 - 0.068), y: warehouseCenterY, z, axis: 'x' });
    });
  }
  const seamMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), seamMaterial, seamPositions.length);
  seamPositions.forEach((seam, index) => {
    const seamScale = seam.axis === 'z'
      ? new THREE.Vector3(0.022, warehouseWallHeight, 0.028)
      : new THREE.Vector3(0.028, warehouseWallHeight, 0.022);
    seamMesh.setMatrixAt(index, matrixAt(new THREE.Vector3(seam.x, seam.y, seam.z), new THREE.Quaternion(), seamScale));
  });
  seamMesh.instanceMatrix.needsUpdate = true;
  scene.add(seamMesh);
  const halfWarehouseWidth = warehouseWidth / 2;
  const halfWarehouseDepth = warehouseDepth / 2;
  const roofEaveY = warehouseFloorY + warehouseWallHeight;
  const roofRidgeY = roofEaveY + warehouseRoofRise;
  const makeRoofPanel = (eaveX) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      eaveX, roofEaveY, center.z - halfWarehouseDepth,
      center.x, roofRidgeY, center.z - halfWarehouseDepth,
      center.x, roofRidgeY, center.z + halfWarehouseDepth,
      eaveX, roofEaveY, center.z + halfWarehouseDepth,
    ], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, roofMaterial);
  };
  [center.x - halfWarehouseWidth, center.x + halfWarehouseWidth].forEach((eaveX) => {
    const roofPanel = makeRoofPanel(eaveX);
    // The metal roof is a visual enclosure, not a source of hard rectangular
    // shadows on the floor. Rack and box shadows remain enabled separately.
    roofPanel.castShadow = false;
    roofPanel.receiveShadow = false;
    scene.add(roofPanel);
  });
  // Close both gable ends with matching white metal sheet.
  [-1, 1].forEach((side) => {
    const endZ = center.z + side * halfWarehouseDepth;
    const gable = new THREE.BufferGeometry();
    gable.setAttribute('position', new THREE.Float32BufferAttribute([
      center.x - halfWarehouseWidth, roofEaveY, endZ,
      center.x + halfWarehouseWidth, roofEaveY, endZ,
      center.x, roofRidgeY, endZ,
    ], 3));
    gable.setIndex([0, 1, 2]);
    gable.computeVertexNormals();
    scene.add(new THREE.Mesh(gable, roofMaterial));
  });
  const steelBetween = (from, to, radius = 0.065, material = trussMaterial) => {
    const direction = to.clone().sub(from);
    const member = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 8), material);
    member.position.copy(from).add(to).multiplyScalar(0.5);
    member.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    // Roof members should read structurally, but their repeated shadow grid
    // looks artificial in the compact warehouse view.
    member.castShadow = false;
    scene.add(member);
  };
  // Warehouse circulation details: yellow traffic lanes, a staging box,
  // pedestrian/keep-clear markings, safety rails, bollards and empty pallets.
  // These remain independent of rack geometry and of the optional forklift.
  const safetyYellow = new THREE.MeshBasicMaterial({ color: 0xffc400, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const guardrailMaterial = new THREE.MeshStandardMaterial({ color: 0xffc400, emissive: 0x392b00, emissiveIntensity: 0.18, metalness: 0.48, roughness: 0.38 });
  const impactBlackMaterial = new THREE.MeshStandardMaterial({ color: 0x171a1c, metalness: 0.5, roughness: 0.42 });
  const floorStrip = (x, z, width, depth, rotationY = 0) => {
    // Floor safety markings are paint: a zero-thickness decal immediately
    // above the epoxy, not a raised BoxGeometry that catches light/shadows.
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), safetyYellow);
    strip.position.set(x, warehouseFloorY + 0.0015, z);
    strip.quaternion
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    strip.receiveShadow = false;
    scene.add(strip);
    return strip;
  };
  // Outline each rack individually. A single outline around the whole cluster
  // is misleading: it crosses the aisles and does not show the actual rack
  // footprints used for safe storage zoning.
  const rackBoundaryWidth = Math.min(warehouseWidth - 2.4, size.x + 1.2);
  const rackBoundaryDepth = Math.min(warehouseDepth - 2.4, size.z + 1.2);
  rackEntries.forEach((entry) => {
    const clearance = 0.16;
    const outlineWidth = entry.width + clearance * 2;
    const outlineDepth = entry.depth + clearance * 2;
    const rotationY = THREE.MathUtils.degToRad(num(entry.rack.rotationYDeg));
    const localPoint = (x, z) => worldPoint(entry.rack, x * 100, 0, z * 100);
    const north = localPoint(0, -outlineDepth / 2);
    const south = localPoint(0, outlineDepth / 2);
    const west = localPoint(-outlineWidth / 2, 0);
    const east = localPoint(outlineWidth / 2, 0);
    floorStrip(north.x, north.z, outlineWidth, 0.085, rotationY);
    floorStrip(south.x, south.z, outlineWidth, 0.085, rotationY);
    floorStrip(west.x, west.z, 0.085, outlineDepth, rotationY);
    floorStrip(east.x, east.z, 0.085, outlineDepth, rotationY);
  });
  const aisleCenterZ = center.z + rackBoundaryDepth / 2 + 2.15;
  const steelBoxBeam = (from, to, width = 0.055, height = 0.09) => {
    const direction = to.clone().sub(from);
    const length = direction.length();
    if (length < 0.05) return;
    // Safety rails are round steel tubes, not rectangular box sections.
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(width, height) / 2, Math.max(width, height) / 2, length, 24), guardrailMaterial);
    beam.position.copy(from).add(to).multiplyScalar(0.5);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    beam.castShadow = false;
    scene.add(beam);
  };
  const createRackEndGuard = (railMinX, railMaxX, railZ, postCount = 3) => {
    // A paired, back-to-back rack has a wide shared end and needs a centre
    // bollard. A standalone rack must have only its two corner bollards so
    // the guard follows the actual rack head without inventing a middle post.
    const ratios = postCount === 2 ? [0, 1] : [0, 0.5, 1];
    const points = ratios.map((ratio) => new THREE.Vector3(
      THREE.MathUtils.lerp(railMinX, railMaxX, ratio), warehouseFloorY, railZ,
    ));
    points.forEach((point) => {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1.15, 10), guardrailMaterial);
      post.position.set(point.x, warehouseFloorY + 0.575, point.z);
      scene.add(post);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.035, 0.2), guardrailMaterial);
      foot.position.set(point.x, warehouseFloorY + 0.018, point.z);
      scene.add(foot);
      [0.2, 0.52, 0.84].forEach((height) => {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.059, 0.059, 0.14, 10), impactBlackMaterial);
        band.position.set(point.x, warehouseFloorY + height, point.z);
        scene.add(band);
      });
    });
    // Two horizontal steel rails replace the old diagonal knee braces.
    if (points.length >= 2) {
      const start = points[0];
      const end = points[points.length - 1];
      [0.38, 0.82].forEach((height) => {
        steelBoxBeam(
          new THREE.Vector3(start.x, warehouseFloorY + height, start.z),
          new THREE.Vector3(end.x, warehouseFloorY + height, end.z),
        );
      });
    }
  };
  // Keep the guard flush with the real steel footprint. `collisionBox` is
  // deliberately enlarged for raycasting, so it must never drive safety size.
  const rackFootprintBounds = (entry) => {
    const footprint = new THREE.Box3();
    [-1, 1].forEach((sideX) => [-1, 1].forEach((sideZ) => footprint.expandByPoint(
      worldPoint(entry.rack, sideX * entry.width * 50, 0, sideZ * entry.depth * 50),
    )));
    return footprint;
  };
  // Keep the guard clear of the rack face so it protects the uprights without
  // touching the shelf beams or blocking the front label area.
  const safetyClearance = 0.35;
  // Every rack end gets its own yellow/black safety posts.  The previous
  // outer-rack-only filter made Zone A/B rows without a visible guard whenever
  // the layout was treated as a back-to-back group, even though each physical
  // rack needs impact protection at both ends.
  rackEntries.forEach((entry) => {
      const rackBox = rackFootprintBounds(entry);
      [rackBox.min.z - safetyClearance, rackBox.max.z + safetyClearance].forEach((railZ, side) =>
        createRackEndGuard(rackBox.min.x, rackBox.max.x, railZ, 2));
  });
  // Zone labels sit on the aisle side of each zone, left-to-right A, B, C.
  const safetySignTextures = [];
  zoneKeys.forEach((zone) => {
    const zoneBox = zoneBounds.get(zone);
    const zoneCenter = zoneBox?.getCenter(new THREE.Vector3()) || new THREE.Vector3(center.x, 0, center.z);
    const zoneSize = zoneBox?.getSize(new THREE.Vector3()) || new THREE.Vector3(3.5, 0, 8);
    // Keep a single neutral concrete floor; zone membership belongs to rack
    // labels and data, not a competing colour wash on the walking surface.
    const aisleDir = aisleCenterZ >= zoneCenter.z ? 1 : -1;
    const signZ = zoneCenter.z + aisleDir * (zoneSize.z / 2 + 0.85);
    const floorTexture = floorMarkTexture(`โซน ${zone}`);
    safetySignTextures.push(floorTexture);
    const floorLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(5.2, 0.82),
      new THREE.MeshBasicMaterial({ map: floorTexture, transparent: true, depthWrite: false, toneMapped: false }),
    );
    floorLabel.rotation.x = -Math.PI / 2;
    floorLabel.position.set(zoneCenter.x, warehouseFloorY + 0.004, signZ);
    floorLabel.renderOrder = 3;
    scene.add(floorLabel);
  });
  // Closely spaced blue-grey factory trusses: a straight lower chord, a roof-
  // following upper chord and repeated triangular webs across the full span.
  const frameCount = Math.max(8, Math.min(12, Math.ceil(warehouseDepth / 5.8)));
  const trussSegments = 12;
  const trussBottomY = roofEaveY - 0.34;
  for (let index = 0; index < frameCount; index += 1) {
    const z = center.z - halfWarehouseDepth + (warehouseDepth * index) / (frameCount - 1);
    const bottomNodes = [];
    const topNodes = [];
    for (let segment = 0; segment <= trussSegments; segment += 1) {
      const ratio = segment / trussSegments;
      const x = center.x - halfWarehouseWidth + warehouseWidth * ratio;
      const roofRatio = 1 - Math.abs((x - center.x) / halfWarehouseWidth);
      bottomNodes.push(new THREE.Vector3(x, trussBottomY, z));
      topNodes.push(new THREE.Vector3(x, roofEaveY + warehouseRoofRise * roofRatio - 0.12, z));
    }
    for (let segment = 0; segment < trussSegments; segment += 1) {
      steelBetween(bottomNodes[segment], bottomNodes[segment + 1], 0.026);
      steelBetween(topNodes[segment], topNodes[segment + 1], 0.03);
      steelBetween(
        segment % 2 === 0 ? bottomNodes[segment] : topNodes[segment],
        segment % 2 === 0 ? topNodes[segment + 1] : bottomNodes[segment + 1],
        0.022,
      );
    }
    steelBetween(bottomNodes[0], topNodes[0], 0.026);
    steelBetween(bottomNodes[trussSegments], topNodes[trussSegments], 0.026);
  }
  // Longitudinal purlins tie portal frames together under the metal sheets.
  [-1, 1].forEach((side) => [0.32, 0.68].forEach((ratio) => {
    const x = center.x + side * halfWarehouseWidth * (1 - ratio);
    const y = roofEaveY + warehouseRoofRise * ratio;
    steelBetween(
      new THREE.Vector3(x, y, center.z - halfWarehouseDepth),
      new THREE.Vector3(x, y, center.z + halfWarehouseDepth),
      0.042,
    );
  }));
  // Ridge and eave purlins give the roof the repeated longitudinal members
  // visible in a real metal-sheet warehouse.
  steelBetween(
    new THREE.Vector3(center.x, roofRidgeY, center.z - halfWarehouseDepth),
    new THREE.Vector3(center.x, roofRidgeY, center.z + halfWarehouseDepth),
    0.05,
  );
  [-1, 1].forEach((side) => steelBetween(
    new THREE.Vector3(center.x + side * halfWarehouseWidth, roofEaveY, center.z - halfWarehouseDepth),
    new THREE.Vector3(center.x + side * halfWarehouseWidth, roofEaveY, center.z + halfWarehouseDepth),
    0.045,
  ));
  // Blue-grey columns and upper-wall X bracing continue the roof structure
  // down the metal-sheet side walls as in the reference factory.
  const wallFrameCount = Math.max(8, Math.min(12, Math.ceil(warehouseDepth / 5.8)));
  const wallBayDepth = warehouseDepth / (wallFrameCount - 1);
  [-1, 1].forEach((side) => {
    const wallX = center.x + side * (halfWarehouseWidth - 0.08);
    for (let index = 0; index < wallFrameCount; index += 1) {
      const z = center.z - halfWarehouseDepth + (warehouseDepth * index) / (wallFrameCount - 1);
      steelBetween(
        new THREE.Vector3(wallX, warehouseFloorY + 0.12, z),
        new THREE.Vector3(wallX, roofEaveY, z),
        0.052,
      );
      if (index < wallFrameCount - 1) {
        const nextZ = center.z - halfWarehouseDepth + (warehouseDepth * (index + 1)) / (wallFrameCount - 1);
        steelBetween(
          new THREE.Vector3(wallX, warehouseFloorY + warehouseWallHeight * 0.5, z),
          new THREE.Vector3(wallX, roofEaveY - 0.2, nextZ),
          0.027,
        );
        steelBetween(
          new THREE.Vector3(wallX, roofEaveY - 0.2, z),
          new THREE.Vector3(wallX, warehouseFloorY + warehouseWallHeight * 0.5, nextZ),
          0.027,
        );
      }
      // Knee brace transfers the eave load from each truss into the column.
      steelBetween(
        new THREE.Vector3(wallX, roofEaveY - 0.72, z),
        new THREE.Vector3(wallX - side * 0.92, trussBottomY, z),
        0.035,
      );
    }
    [0.31, 0.56, 0.78].forEach((heightRatio) => steelBetween(
      new THREE.Vector3(wallX, warehouseFloorY + warehouseWallHeight * heightRatio, center.z - halfWarehouseDepth),
      new THREE.Vector3(wallX, warehouseFloorY + warehouseWallHeight * heightRatio, center.z + halfWarehouseDepth),
      0.038,
    ));
  });
  // Reproduce the reference's wall build-up: a smooth light lower panel,
  // corrugated cladding above, teal portal framing, and a continuous louvre
  // strip on the service elevation. These are wall details, not configured
  // warehouse gates, so the previously removed 3D doors stay absent.
  const lowerWallMaterial = new THREE.MeshStandardMaterial({ color: 0xe4e8e8, metalness: 0.18, roughness: 0.62 });
  const louvreMaterial = new THREE.MeshStandardMaterial({ color: 0xd7e0e2, metalness: 0.62, roughness: 0.38 });
  const louvreFrameMaterial = new THREE.MeshStandardMaterial({ color: 0x426f7b, metalness: 0.76, roughness: 0.3 });
  const lowerWallHeight = Math.min(3.25, warehouseWallHeight * 0.31);
  [-1, 1].forEach((side) => {
    const wallX = center.x + side * (halfWarehouseWidth - 0.072);
    const innerX = wallX - side * 0.075;
    const lowerPanel = new THREE.Mesh(
      new THREE.BoxGeometry(0.035, lowerWallHeight, warehouseDepth - 0.22),
      lowerWallMaterial,
    );
    lowerPanel.position.set(innerX, warehouseFloorY + lowerWallHeight / 2, center.z);
    scene.add(lowerPanel);
  });
  // The photographed long wall has broad horizontal louvres between portal
  // columns. Put them on the visible service elevation only; the opposite
  // elevation remains continuous metal sheet as requested.
  const louvreSide = -1;
  const louvreX = center.x + louvreSide * (halfWarehouseWidth - 0.105);
  const louvreStartY = warehouseFloorY + lowerWallHeight + 0.46;
  const louvreHeight = Math.min(2.05, warehouseWallHeight * 0.22);
  for (let bay = 1; bay < wallFrameCount - 2; bay += 2) {
    const bayStartZ = center.z - halfWarehouseDepth + wallBayDepth * bay + 0.22;
    const bayLength = wallBayDepth * 2 - 0.44;
    const bayCenterZ = bayStartZ + bayLength / 2;
    steelBetween(
      new THREE.Vector3(louvreX, louvreStartY, bayStartZ),
      new THREE.Vector3(louvreX, louvreStartY, bayStartZ + bayLength),
      0.042,
      louvreFrameMaterial,
    );
    steelBetween(
      new THREE.Vector3(louvreX, louvreStartY + louvreHeight, bayStartZ),
      new THREE.Vector3(louvreX, louvreStartY + louvreHeight, bayStartZ + bayLength),
      0.042,
      louvreFrameMaterial,
    );
    [bayStartZ, bayStartZ + bayLength].forEach((z) => steelBetween(
      new THREE.Vector3(louvreX, louvreStartY, z),
      new THREE.Vector3(louvreX, louvreStartY + louvreHeight, z),
      0.04,
      louvreFrameMaterial,
    ));
    for (let slatIndex = 0; slatIndex < 8; slatIndex += 1) {
      const slatY = louvreStartY + 0.16 + slatIndex * ((louvreHeight - 0.3) / 7);
      const louvreSlat = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.075, bayLength - 0.08), louvreMaterial);
      louvreSlat.position.set(louvreX + 0.025, slatY, bayCenterZ);
      scene.add(louvreSlat);
    }
  }
  // Detail both gable walls as well. Offset every feature toward the interior
  // so it reads in the camera view rather than being hidden inside the sheet.
  [-1, 1].forEach((side) => {
    const endZ = center.z + side * (halfWarehouseDepth - 0.075);
    const innerZ = endZ - side * 0.095;
    const endLowerPanel = new THREE.Mesh(
      new THREE.BoxGeometry(warehouseWidth - 0.18, lowerWallHeight, 0.035),
      lowerWallMaterial,
    );
    endLowerPanel.position.set(center.x, warehouseFloorY + lowerWallHeight / 2, innerZ);
    scene.add(endLowerPanel);
    for (let column = 0; column <= 4; column += 1) {
      const x = center.x - halfWarehouseWidth + (warehouseWidth * column) / 4;
      steelBetween(
        new THREE.Vector3(x, warehouseFloorY + 0.08, innerZ),
        new THREE.Vector3(x, roofEaveY, innerZ),
        0.052,
        louvreFrameMaterial,
      );
    }
    // The reference has clean horizontal girts, not a large X across the
    // cladding. Keep the lower panel joint and two upper structural rails.
    [0.31, 0.56, 0.78].forEach((ratio) => steelBetween(
      new THREE.Vector3(center.x - halfWarehouseWidth, warehouseFloorY + warehouseWallHeight * ratio, innerZ),
      new THREE.Vector3(center.x + halfWarehouseWidth, warehouseFloorY + warehouseWallHeight * ratio, innerZ),
      0.038,
      louvreFrameMaterial,
    ));
    // Match the photo: one long louvre bank at the right-hand bays, rather
    // than several small vents distributed across the elevation.
    const endLouvreWidth = Math.min(10.4, warehouseWidth * 0.38);
    const endLouvreHeight = Math.min(1.62, warehouseWallHeight * 0.17);
    const endLouvreY = warehouseFloorY + lowerWallHeight + 0.64;
    const endLouvreX = center.x + warehouseWidth * 0.2;
    steelBetween(
      new THREE.Vector3(endLouvreX - endLouvreWidth / 2, endLouvreY, innerZ),
      new THREE.Vector3(endLouvreX + endLouvreWidth / 2, endLouvreY, innerZ),
      0.045,
      louvreFrameMaterial,
    );
    steelBetween(
      new THREE.Vector3(endLouvreX - endLouvreWidth / 2, endLouvreY + endLouvreHeight, innerZ),
      new THREE.Vector3(endLouvreX + endLouvreWidth / 2, endLouvreY + endLouvreHeight, innerZ),
      0.045,
      louvreFrameMaterial,
    );
    [endLouvreX - endLouvreWidth / 2, endLouvreX + endLouvreWidth / 2].forEach((edgeX) => steelBetween(
      new THREE.Vector3(edgeX, endLouvreY, innerZ),
      new THREE.Vector3(edgeX, endLouvreY + endLouvreHeight, innerZ),
      0.045,
      louvreFrameMaterial,
    ));
    for (let slatIndex = 0; slatIndex < 11; slatIndex += 1) {
      const slatY = endLouvreY + 0.12 + slatIndex * ((endLouvreHeight - 0.24) / 10);
      const endLouvreSlat = new THREE.Mesh(new THREE.BoxGeometry(endLouvreWidth - 0.1, 0.065, 0.1), louvreMaterial);
      endLouvreSlat.position.set(endLouvreX, slatY, innerZ + side * 0.02);
      endLouvreSlat.rotation.z = -0.13;
      scene.add(endLouvreSlat);
    }
    // Fire mains turn the corner at this elevation, matching the red runs on
    // the two long walls instead of ending visibly before the gable.
    [0.78, 0.83].forEach((heightRatio) => steelBetween(
      new THREE.Vector3(center.x - halfWarehouseWidth + 0.51, warehouseFloorY + warehouseWallHeight * heightRatio, center.z + side * (halfWarehouseDepth - 0.51)),
      new THREE.Vector3(center.x + halfWarehouseWidth - 0.51, warehouseFloorY + warehouseWallHeight * heightRatio, center.z + side * (halfWarehouseDepth - 0.51)),
      0.032,
      sprinklerPipeMaterial,
    ));
  });
  // Lower wall band, cable trays, bay numbers, wall lights and electrical
  // boxes complete the service-wall rhythm from the reference.
  const lowerBandMaterial = new THREE.MeshStandardMaterial({ color: 0x7c888d, metalness: 0.68, roughness: 0.38 });
  const cableMaterial = new THREE.MeshStandardMaterial({ color: 0x333b40, metalness: 0.84, roughness: 0.25 });
  const wallLightMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xeaf8ff, emissiveIntensity: 2.8, roughness: 0.25 });
  const wallDetailTextures = [];
  const wallMarkerTexture = (text, background, foreground) => {
    const markerCanvas = document.createElement('canvas');
    markerCanvas.width = 256;
    markerCanvas.height = 128;
    const context = markerCanvas.getContext('2d');
    context.fillStyle = background;
    context.fillRect(0, 0, markerCanvas.width, markerCanvas.height);
    context.strokeStyle = foreground;
    context.lineWidth = 8;
    context.strokeRect(6, 6, markerCanvas.width - 12, markerCanvas.height - 12);
    context.fillStyle = foreground;
    context.font = '700 72px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, markerCanvas.width / 2, markerCanvas.height / 2 + 3);
    const texture = new THREE.CanvasTexture(markerCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    wallDetailTextures.push(texture);
    return texture;
  };
  // Loading-dock elevation: door count and flow type come solely from the
  // warehouse master API. The opposite wall remains unbroken metal sheet.
  const configuredDoors = Array.isArray(model.doors) ? model.doors : [];
  if (configuredDoors.length) {
    const doorSide = -1;
    const wallX = center.x + doorSide * (halfWarehouseWidth - 0.15);
    const innerX = wallX - doorSide * 0.16;
    const rotationY = Math.PI / 2;
    const doorSpan = (warehouseDepth - 3.6) / (configuredDoors.length + 1);
    const doorWidth = Math.min(3.1, Math.max(2.1, doorSpan * 0.58));
    const doorHeight = Math.min(4.15, Math.max(3.25, warehouseWallHeight * 0.39));
    const dockDoorMaterial = new THREE.MeshStandardMaterial({ color: 0xe8ecec, metalness: 0.58, roughness: 0.36 });
    const dockFrameMaterial = new THREE.MeshStandardMaterial({ color: 0x445c63, metalness: 0.78, roughness: 0.28 });
    configuredDoors.forEach((door, index) => {
      const doorZ = center.z - halfWarehouseDepth + 1.8 + doorSpan * (index + 1);
      // The leaf is separated from the permanent frame so a click can raise
      // and lower it like a real sectional loading door.
      const leaf = new THREE.Group();
      leaf.position.set(innerX, warehouseFloorY, doorZ);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.13, doorHeight, doorWidth), dockDoorMaterial);
      panel.position.set(0, doorHeight / 2, 0);
      panel.userData.doorIndex = dockDoors.length;
      leaf.add(panel);
      scene.add(leaf);
      dockDoorPickMeshes.push(panel);
      // The black interior remains hidden while the shutter is down, then
      // becomes visible behind the raised door as a real unlit dock opening.
      const openingMaterial = new THREE.MeshBasicMaterial({ color: 0x020304, transparent: true, opacity: 0, side: THREE.DoubleSide });
      const openingBlack = new THREE.Mesh(new THREE.PlaneGeometry(doorWidth - 0.14, doorHeight - 0.12), openingMaterial);
      openingBlack.rotation.y = rotationY;
      openingBlack.position.set(innerX - doorSide * 0.075, warehouseFloorY + doorHeight / 2, doorZ);
      scene.add(openingBlack);
      [-1, 1].forEach((edge) => steelBetween(
        new THREE.Vector3(innerX - doorSide * 0.08, warehouseFloorY, doorZ + edge * doorWidth / 2),
        new THREE.Vector3(innerX - doorSide * 0.08, warehouseFloorY + doorHeight + 0.22, doorZ + edge * doorWidth / 2),
        0.06,
        dockFrameMaterial,
      ));
      steelBetween(
        new THREE.Vector3(innerX - doorSide * 0.08, warehouseFloorY + doorHeight + 0.22, doorZ - doorWidth / 2),
        new THREE.Vector3(innerX - doorSide * 0.08, warehouseFloorY + doorHeight + 0.22, doorZ + doorWidth / 2),
        0.06,
        dockFrameMaterial,
      );
      for (let row = 1; row < 6; row += 1) {
        const seam = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.025, doorWidth - 0.08), dockFrameMaterial);
        seam.position.set(-doorSide * 0.01, (doorHeight * row) / 6, 0);
        leaf.add(seam);
      }
      const numberSign = new THREE.Mesh(
        new THREE.PlaneGeometry(0.62, 0.34),
        new THREE.MeshBasicMaterial({ map: wallMarkerTexture(String(door.gateNo), '#3d464c', '#ffd84d'), toneMapped: false, side: THREE.DoubleSide }),
      );
      numberSign.rotation.y = rotationY;
      numberSign.position.set(innerX - doorSide * 0.09, warehouseFloorY + doorHeight + 0.58, doorZ);
      scene.add(numberSign);
      const typeColor = door.type === 'in' ? 0x58c7ff : door.type === 'out' ? 0xff8b59 : 0xb8ee59;
      const statusLamp = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.42), new THREE.MeshStandardMaterial({ color: typeColor, emissive: typeColor, emissiveIntensity: 0.55 }));
      statusLamp.position.set(innerX - doorSide * 0.15, warehouseFloorY + doorHeight + 0.34, doorZ);
      scene.add(statusLamp);
      dockDoors.push({ door, leaf, openingBlack, openingMaterial, statusLamp, typeColor, height: doorHeight, open: false, progress: 0 });
      const pipeZ = doorZ + doorWidth / 2 + 0.23;
      steelBetween(
        new THREE.Vector3(innerX - doorSide * 0.27, warehouseFloorY + 0.12, pipeZ),
        new THREE.Vector3(innerX - doorSide * 0.27, warehouseFloorY + doorHeight + 0.56, pipeZ),
        0.035,
        sprinklerPipeMaterial,
      );
    });
  }
  [-1, 1].forEach((side) => {
    const wallX = center.x + side * (halfWarehouseWidth - 0.15);
    const innerX = wallX - side * 0.16;
    const sideRotation = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    const lowerBand = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.58, warehouseDepth - 0.3), lowerBandMaterial);
    lowerBand.position.set(innerX, warehouseFloorY + 0.32, center.z);
    scene.add(lowerBand);
    // Three-tier service tray with regular cantilever brackets.
    [0.34, 0.39, 0.44].forEach((heightRatio) => {
      const trayY = warehouseFloorY + warehouseWallHeight * heightRatio;
      steelBetween(
        new THREE.Vector3(innerX - side * 0.34, trayY, center.z - halfWarehouseDepth + 0.65),
        new THREE.Vector3(innerX - side * 0.34, trayY, center.z + halfWarehouseDepth - 0.65),
        0.026,
        cableMaterial,
      );
      for (let index = 0; index < wallFrameCount; index += 1) {
        const bracketZ = center.z - halfWarehouseDepth + (warehouseDepth * index) / (wallFrameCount - 1);
        steelBetween(
          new THREE.Vector3(innerX, trayY, bracketZ),
          new THREE.Vector3(innerX - side * 0.52, trayY, bracketZ),
          0.018,
          cableMaterial,
        );
      }
    });
    // Parallel red wall mains beneath the eave.
    [0.78, 0.83].forEach((heightRatio) => steelBetween(
      new THREE.Vector3(innerX - side * 0.2, warehouseFloorY + warehouseWallHeight * heightRatio, center.z - halfWarehouseDepth + 0.51),
      new THREE.Vector3(innerX - side * 0.2, warehouseFloorY + warehouseWallHeight * heightRatio, center.z + halfWarehouseDepth - 0.51),
      0.032,
      sprinklerPipeMaterial,
    ));
    // Keep one service marker beside the single loading door on each wall.
    // Repeating the marker in every wall bay made the 3D view look like it had
    // several doors; the opposite wall mirrors the same single-door position.
    const referenceDoorZ = configuredDoors.length
      ? center.z - halfWarehouseDepth + 1.8 + ((warehouseDepth - 3.6) / (configuredDoors.length + 1))
      : center.z;
    // Keep the wall light clear of the door frame on the right, while the
    // consumer unit below moves to the clear wall bay on the left.
    const serviceOffset = side === -1 ? 1.12 : 0;
    // Deliberately omit the old white service bar: it looked like a stray
    // floating rod next to the door rather than a useful warehouse fixture.
    // One realistic consumer unit is mounted beside the operating door. It is
    // intentionally wall-fixed (not a loose floor prop) and faces the aisle.
    if (side === -1) {
      const consumerX = innerX - side * 0.14;
      const consumerY = warehouseFloorY + 1.56;
      const consumerZ = referenceDoorZ - 2.35;
      const consumerBodyMaterial = new THREE.MeshStandardMaterial({ color: 0xf0f1ee, roughness: 0.42, metalness: 0.12 });
      const consumerLidMaterial = new THREE.MeshStandardMaterial({ color: 0xfafaf7, roughness: 0.32, metalness: 0.08 });
      const consumerTrimMaterial = new THREE.MeshStandardMaterial({ color: 0xc6c9c7, roughness: 0.4, metalness: 0.32 });
      const breakerMaterial = new THREE.MeshStandardMaterial({ color: 0x202326, roughness: 0.34, metalness: 0.25 });
      const mainBreakerMaterial = new THREE.MeshStandardMaterial({ color: 0xb72024, roughness: 0.34, metalness: 0.2 });
      const consumerBody = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.9, 1.52), consumerBodyMaterial);
      consumerBody.position.set(consumerX, consumerY, consumerZ);
      consumerBody.castShadow = consumerBody.receiveShadow = true;
      scene.add(consumerBody);
      consumerUnitPickMeshes.push(consumerBody);
      // Hinged weather cover, raised above the breaker row like the reference.
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.44, 1.58), consumerLidMaterial);
      lid.position.set(consumerX - side * 0.05, consumerY + 0.24, consumerZ);
      lid.castShadow = lid.receiveShadow = true;
      scene.add(lid);
      consumerUnitPickMeshes.push(lid);
      const breakerPanel = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.3, 1.22), consumerTrimMaterial);
      breakerPanel.position.set(consumerX - side * 0.115, consumerY - 0.19, consumerZ);
      scene.add(breakerPanel);
      consumerUnitPickMeshes.push(breakerPanel);
      // The main isolator plus eight modular MCBs are individual solids, so
      // their levers remain legible when the user moves close to the wall.
      for (let breaker = 0; breaker < 9; breaker += 1) {
        const isMain = breaker < 2;
        const width = isMain ? 0.115 : 0.09;
        const z = consumerZ - 0.5 + (breaker < 2 ? breaker * 0.13 : 0.29 + (breaker - 2) * 0.13);
        const breakerBody = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.19, width), consumerBodyMaterial);
        breakerBody.position.set(consumerX - side * 0.16, consumerY - 0.19, z);
        scene.add(breakerBody);
        const lever = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.09, width * 0.58), isMain ? mainBreakerMaterial : breakerMaterial);
        lever.position.set(consumerX - side * 0.215, consumerY - 0.205, z);
        scene.add(lever);
        consumerUnitPickMeshes.push(breakerBody, lever);
      }
      [-1, 1].forEach((zSide) => [-1, 1].forEach((ySide) => {
        const screw = new THREE.Mesh(new THREE.SphereGeometry(0.027, 12, 8), consumerTrimMaterial);
        screw.position.set(consumerX - side * 0.105, consumerY + ySide * 0.34, consumerZ + zSide * 0.64);
        scene.add(screw);
      }));
      const consumerLabel = new THREE.Mesh(
        new THREE.PlaneGeometry(0.45, 0.11),
        new THREE.MeshBasicMaterial({ map: wallMarkerTexture('MAIN CONSUMER UNIT', '#f7f7f3', '#27323a'), toneMapped: false, side: THREE.DoubleSide }),
      );
      consumerLabel.rotation.y = sideRotation;
      consumerLabel.position.set(consumerX - side * 0.242, consumerY - 0.38, consumerZ);
      scene.add(consumerLabel);
      // Red pilot lamp: emergency/status indicator remains visible when the
      // warehouse lighting circuit is switched off.
      const consumerStatusMaterial = new THREE.MeshStandardMaterial({ color: 0x63e65d, emissive: 0x173b19, emissiveIntensity: 0.7, roughness: 0.24, metalness: 0.08 });
      const consumerStatusLamp = new THREE.Mesh(new THREE.SphereGeometry(0.034, 14, 10), consumerStatusMaterial);
      consumerStatusLamp.position.set(consumerX - side * 0.245, consumerY + 0.27, consumerZ + 0.57);
      scene.add(consumerStatusLamp);
      consumerPowerIndicators.push(consumerStatusLamp);
      const consumerStatusLight = new THREE.PointLight(0xff2638, 0, 0.9, 2);
      consumerStatusLight.position.copy(consumerStatusLamp.position);
      scene.add(consumerStatusLight);
      consumerPowerIndicatorLights.push(consumerStatusLight);
    }
    const safetyTexture = wallMarkerTexture('!', '#f3f5f6', '#263238');
    const safetySign = new THREE.Mesh(
      new THREE.PlaneGeometry(0.28, 0.28),
      new THREE.MeshBasicMaterial({ map: safetyTexture, toneMapped: false, side: THREE.DoubleSide }),
    );
    safetySign.rotation.y = sideRotation;
    safetySign.position.set(innerX - side * 0.026, warehouseFloorY + 1.25, referenceDoorZ);
    scene.add(safetySign);
  });
  // Cable trays use the same three heights on every elevation and turn each
  // corner at the same inset as their long-wall runs.
  [-1, 1].forEach((side) => {
    const endTrayZ = center.z + side * (halfWarehouseDepth - 0.65);
    [0.34, 0.39, 0.44].forEach((heightRatio) => steelBetween(
      new THREE.Vector3(center.x - halfWarehouseWidth + 0.65, warehouseFloorY + warehouseWallHeight * heightRatio, endTrayZ),
      new THREE.Vector3(center.x + halfWarehouseWidth - 0.65, warehouseFloorY + warehouseWallHeight * heightRatio, endTrayZ),
      0.026,
      cableMaterial,
    ));
  });
  // Fire-sprinkler mains run beneath the trusses. Heads are placed directly
  // below the visible red pipe instead of floating independently in space.
  const sprinklerHeadMaterial = new THREE.MeshStandardMaterial({ color: 0xc8d0d4, metalness: 0.82, roughness: 0.2 });
  const serviceRowCount = Math.min(7, Math.max(5, frameCount - 2));
  const serviceFrameIndices = Array.from({ length: serviceRowCount }, (_, index) => (
    Math.round((index + 1) * (frameCount - 1) / (serviceRowCount + 1))
  ));
  // Each red main runs across the warehouse width, parallel to the long side
  // of each rectangular light. Both are fixed below the same straight truss.
  serviceFrameIndices.forEach((frameIndex) => {
    const pipeZ = center.z - halfWarehouseDepth + (warehouseDepth * frameIndex) / (frameCount - 1);
    const pipeY = trussBottomY - 0.16;
    steelBetween(
      new THREE.Vector3(center.x - halfWarehouseWidth + 0.4, pipeY, pipeZ),
      new THREE.Vector3(center.x + halfWarehouseWidth - 0.4, pipeY, pipeZ),
      0.035,
      sprinklerPipeMaterial,
    );
    for (let index = 1; index < 8; index += 1) {
      const headX = center.x - halfWarehouseWidth + (warehouseWidth * index) / 8;
      // Short hanger physically connects the main to the truss above.
      steelBetween(
        new THREE.Vector3(headX, trussBottomY, pipeZ),
        new THREE.Vector3(headX, pipeY, pipeZ),
        0.014,
        trussMaterial,
      );
      const dropStart = new THREE.Vector3(headX, pipeY, pipeZ);
      const dropEnd = dropStart.clone().add(new THREE.Vector3(0, -0.18, 0));
      steelBetween(dropStart, dropEnd, 0.018, sprinklerPipeMaterial);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.09, 8), sprinklerHeadMaterial);
      head.position.copy(dropEnd).add(new THREE.Vector3(0, -0.05, 0));
      head.rotation.x = Math.PI;
      scene.add(head);
    }
  });
  // Red vertical fire risers join the overhead mains at both side walls.
  [-1, 1].forEach((side) => {
    const riserX = center.x + side * (halfWarehouseWidth - 0.3);
    const wallPipeX = center.x + side * (halfWarehouseWidth - 0.51);
    const wallPipeY = warehouseFloorY + warehouseWallHeight * 0.83;
    const riserZ = center.z - halfWarehouseDepth * 0.72;
    steelBetween(
      new THREE.Vector3(riserX, warehouseFloorY + 0.35, riserZ),
      new THREE.Vector3(riserX, wallPipeY, riserZ),
      0.042,
      sprinklerPipeMaterial,
    );
    steelBetween(
      new THREE.Vector3(riserX, wallPipeY, riserZ),
      new THREE.Vector3(wallPipeX, wallPipeY, riserZ),
      0.042,
      sprinklerPipeMaterial,
    );
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), sprinklerPipeMaterial);
    elbow.position.set(riserX, wallPipeY, riserZ);
    scene.add(elbow);
  });
  const lightMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdff7ff, emissiveIntensity: 2.2, roughness: 0.3 });
  const fixtureCount = serviceFrameIndices.length;
  [-0.24, 0.24].forEach((xRatio) => {
    const lightX = center.x + halfWarehouseWidth * xRatio;
    const lightY = trussBottomY - 0.24;
    for (let index = 1; index <= fixtureCount; index += 1) {
      const frameIndex = serviceFrameIndices[index - 1];
      const lightZ = center.z - halfWarehouseDepth + (warehouseDepth * frameIndex) / (frameCount - 1);
      steelBetween(
        new THREE.Vector3(lightX, trussBottomY, lightZ),
        new THREE.Vector3(lightX, lightY + 0.04, lightZ),
        0.014,
        trussMaterial,
      );
      // Flat rectangular high-bay fixture like the reference photograph.
      const fixture = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.07, 0.28), lightMaterial);
      fixture.position.set(lightX, lightY, lightZ);
      scene.add(fixture);
      warehousePowerFixtures.push(fixture);
      // The emitting panel itself is the exact source anchor for this light.
      const light = new THREE.PointLight(0xe8f6ff, 8, Math.max(7, warehouseWidth * 0.42), 2);
      light.position.copy(fixture.position).add(new THREE.Vector3(0, -0.08, 0));
      scene.add(light);
      warehousePowerLights.push(light);
    }
  });
  let warehousePowerOn = true;
  const setWarehousePower = (on) => {
    warehousePowerOn = Boolean(on);
    // Power-off keeps only a faint, shadowless emergency/ambient spill. The
    // high-bay circuit and sunlight are truly off, but operators can still
    // distinguish the warehouse outline instead of seeing a pure black void.
    hemisphereLight.intensity = warehousePowerOn ? 1.75 : 0.045;
    ambientLight.intensity = warehousePowerOn ? 0.48 : 0.018;
    sun.intensity = warehousePowerOn ? 2.25 : 0;
    // Changing castShadow forces expensive shadow-program work on some WebGL
    // drivers and made the whole view hitch whenever this switch was pressed.
    // Keep the shadow pipeline stable; intensity still turns the circuit off.
    renderer.toneMappingExposure = warehousePowerOn ? 1.05 : 0.16;
    scene.background.set(warehousePowerOn ? 0x101419 : 0x020508);
    scene.fog.color.set(warehousePowerOn ? 0x101419 : 0x020508);
    wallLightMaterial.emissiveIntensity = warehousePowerOn ? 2.8 : 0;
    consumerPowerIndicators.forEach((indicator) => {
      indicator.material.color.set(warehousePowerOn ? 0x63e65d : 0xff2638);
      indicator.material.emissive.set(warehousePowerOn ? 0x173b19 : 0x6d0b13);
      indicator.material.emissiveIntensity = warehousePowerOn ? 0.7 : 2.2;
    });
    consumerPowerIndicatorLights.forEach((light) => { light.intensity = warehousePowerOn ? 0 : 0.42; });
    warehousePowerFixtures.forEach((fixture) => { fixture.material.emissiveIntensity = warehousePowerOn ? 2.2 : 0; });
    warehousePowerLights.forEach((light) => { light.intensity = warehousePowerOn ? 8 : 0; });
  };
  const toggleDockDoor = (index) => {
    const entry = dockDoors[index];
    if (!entry) return;
    entry.open = !entry.open;
    const lampColor = entry.open ? 0x63e65d : entry.typeColor;
    entry.statusLamp.material.color.set(lampColor);
    entry.statusLamp.material.emissive.set(lampColor);
    // Make the actionable surface unambiguous: the door itself is the
    // control, and the status lamp gives an immediate open/close cue.
    entry.leaf.userData.doorAction = entry.open ? 'คลิกบานประตูเพื่อปิด' : 'คลิกบานประตูเพื่อเปิด';
    window.toast?.(
      entry.open ? 'เปิดประตูแล้ว' : 'ปิดประตูแล้ว',
      entry.open ? 'คลิกที่บานประตูอีกครั้งเพื่อปิด' : 'คลิกที่บานประตูเพื่อเปิด',
      'ok',
    );
  };
  const floorMarkTextures = safetySignTextures;
  // One grid division represents one metre across the complete warehouse floor.
  const gridSize = Math.ceil(Math.max(warehouseWidth, warehouseDepth));
  const grid = new THREE.GridHelper(gridSize, gridSize, 0x52606e, 0x303841);
  grid.position.set(center.x, floor.position.y + 0.012, center.z);
  grid.material.transparent = true;
  grid.material.opacity = 0.11;
  scene.add(grid);

  const span = Math.max(size.x, size.z, 5);
  // Let users zoom out to inspect the much larger warehouse, while clamping
  // the actual orbit position to its walls and shallow gable roof.
  controls.maxDistance = Math.max(18, Math.min(warehouseWidth, warehouseDepth) * 0.9);
  const keepCameraInsideWarehouse = () => {
    const wallClearance = 0.38;
    const xLimit = halfWarehouseWidth - wallClearance;
    const zLimit = halfWarehouseDepth - wallClearance;
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, center.x - xLimit * 0.68, center.x + xLimit * 0.68);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, center.z - zLimit * 0.68, center.z + zLimit * 0.68);
    controls.target.y = THREE.MathUtils.clamp(controls.target.y, warehouseFloorY + 0.35, roofRidgeY - 0.7);
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, center.x - xLimit, center.x + xLimit);
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, center.z - zLimit, center.z + zLimit);
    const normalizedX = Math.abs(camera.position.x - center.x) / xLimit;
    const roofY = roofEaveY + warehouseRoofRise * (1 - normalizedX);
    camera.position.y = THREE.MathUtils.clamp(camera.position.y, warehouseFloorY + 0.35, roofY - wallClearance);
    rackEntries.forEach(({ collisionBox }) => {
      if (!collisionBox?.containsPoint(camera.position)) return;
      const clearance = 0.08;
      const distances = [
        { axis: 'x', value: collisionBox.min.x, delta: camera.position.x - collisionBox.min.x, direction: -1 },
        { axis: 'x', value: collisionBox.max.x, delta: collisionBox.max.x - camera.position.x, direction: 1 },
        { axis: 'z', value: collisionBox.min.z, delta: camera.position.z - collisionBox.min.z, direction: -1 },
        { axis: 'z', value: collisionBox.max.z, delta: collisionBox.max.z - camera.position.z, direction: 1 },
        { axis: 'y', value: collisionBox.max.y, delta: collisionBox.max.y - camera.position.y, direction: 1 },
      ].sort((a, b) => a.delta - b.delta);
      const nearest = distances[0];
      camera.position[nearest.axis] = nearest.value + nearest.direction * clearance;
    });
  };
  // Barcode labels are a close-inspection aid, not overview decoration. The
  // small cap ensures a large warehouse still requires an intentional zoom-in
  // before hundreds of shelf labels are rendered into the view.
  const barcodeZoomDistance = Math.max(5.5, Math.min(10, span * 0.32));
  const occupancyOverviewZoomDistance = Math.max(8, span * 1.35);
  let barcodeMode = null;
  let occupancyOverviewMode = null;
  // These values are read during the initial overlay calculation below, before
  // the pointer handlers are attached. Declare them here to avoid a temporal
  // dead-zone error on first render.
  let hoverIndex = -1;
  let hoverBoxIndex = -1;
  const updateRackLabelMode = () => {
    const showBarcodes = controls.getDistance() <= barcodeZoomDistance;
    if (showBarcodes === barcodeMode) return;
    barcodeMode = showBarcodes;
    // Hide shelf-edge labels in normal/overview mode. They appear only after
    // the operator deliberately zooms close enough to scan or read one.
    barcodeStickers.forEach((sticker) => { sticker.visible = showBarcodes; });
    boxBarcodeStickers.forEach((sticker) => { sticker.visible = showBarcodes; });
    rackNameLabels.forEach((label) => { label.visible = !showBarcodes; });
  };
  const updateOccupancyOverlay = () => {
    const revealOccupied = controls.getDistance() >= occupancyOverviewZoomDistance;
    if (revealOccupied === occupancyOverviewMode) return;
    occupancyOverviewMode = revealOccupied;
    showOccupiedSlots = revealOccupied;
    if (!slotMesh) return;
    slotEntries.forEach((entry, index) => {
      if (index !== hoverIndex) slotMesh.setColorAt(index, slotColor(entry));
    });
    slotMesh.instanceColor.needsUpdate = true;
  };
  camera.position.set(center.x + span * 0.82, Math.max(5.8, size.y * 0.82), center.z + Math.min(warehouseDepth * 0.4, 7.4));
  controls.target.set(center.x, Math.max(1.2, size.y * 0.4), center.z);
  controls.update();
  keepCameraInsideWarehouse();
  updateRackLabelMode();
  updateOccupancyOverlay();
  sun.position.set(center.x - span * 0.65, Math.max(16, span * 1.1), center.z + span * 0.55);
  const shadowExtent = Math.max(12, span * 0.85);
  Object.assign(sun.shadow.camera, { left: -shadowExtent, right: shadowExtent, top: shadowExtent, bottom: -shadowExtent, near: 0.5, far: Math.max(60, span * 4) });
  sun.shadow.camera.updateProjectionMatrix();

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let forkliftRoot = null;
  let forkliftSelected = false;
  let forkliftSelection = null;
  let forkliftLoadAssembly = null;
  let forkliftClearance = 1.15;
  let forkliftMotion = null;
  const savedForklift = model.forkliftPosition || null;
  const saveForkliftPosition = () => {
    if (!forkliftRoot || !model.warehouseId) return;
    fetch('/api/warehouse-3d/forklift', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ warehouseId: model.warehouseId, position: { x: forkliftRoot.position.x, y: forkliftRoot.position.y, z: forkliftRoot.position.z }, rotationY: forkliftRoot.rotation.y }),
    }).catch((error) => console.warn('[Warehouse3D] could not save forklift position', error));
  };
  const forkliftPickMeshes = [];
  // Each entry keeps the original forklift wheel geometry and its local axle.
  // The source GLB ships all four wheels inside Object_0 rather than as nodes.
  const forkliftWheelMeshes = [];
  const routeMaterial = new THREE.LineBasicMaterial({ color: 0xa8ff2b, transparent: true, opacity: 0.92, depthTest: false });
  const routeLine = new THREE.Line(new THREE.BufferGeometry(), routeMaterial);
  routeLine.renderOrder = 14;
  routeLine.visible = false;
  scene.add(routeLine);
  const targetMarkerMaterial = new THREE.MeshBasicMaterial({ color: 0xa8ff2b, transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthTest: false });
  const targetMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.42, 32),
    targetMarkerMaterial,
  );
  targetMarker.rotation.x = -Math.PI / 2;
  targetMarker.renderOrder = 15;
  targetMarker.visible = false;
  scene.add(targetMarker);
  // Persistent mission beacon: remains over the selected pallet while the
  // forklift drives, rather than showing only a one-shot click ripple.
  const missionBeaconMaterial = new THREE.MeshBasicMaterial({ color: 0xffd34e, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false });
  const missionBeacon = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.64, 40), missionBeaconMaterial);
  missionBeacon.rotation.x = -Math.PI / 2;
  missionBeacon.renderOrder = 16;
  missionBeacon.visible = false;
  scene.add(missionBeacon);
  // A short expanding ripple confirms a double-click immediately, similar to
  // a move-command marker in a game. It deliberately uses the clicked floor
  // coordinate; the smaller persistent ring then marks the safe NavMesh/grid
  // endpoint chosen by the pathfinder.
  const targetRippleMaterial = new THREE.MeshBasicMaterial({ color: 0xd7ff63, transparent: true, opacity: 0.98, side: THREE.DoubleSide, depthTest: false });
  const targetRipple = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.48, 40), targetRippleMaterial);
  targetRipple.rotation.x = -Math.PI / 2;
  targetRipple.renderOrder = 15;
  targetRipple.visible = false;
  scene.add(targetRipple);
  let targetRippleStartedAt = 0;
  const showTargetRipple = (point, valid = true) => {
    targetRipple.position.copy(point).setY(warehouseFloorY + 0.058);
    targetRipple.scale.setScalar(0.45);
    targetRippleMaterial.color.setHex(valid ? 0xd7ff63 : 0xff6b5f);
    targetRippleMaterial.opacity = 0.98;
    targetRipple.visible = true;
    targetRippleStartedAt = performance.now();
  };
  const consumerHoverMaterial = new THREE.LineBasicMaterial({ color: 0xb6ff3b, transparent: true, opacity: 0.96, depthTest: false });
  const consumerHoverOutline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.32, 1.02, 1.68)),
    consumerHoverMaterial,
  );
  consumerHoverOutline.visible = false;
  consumerHoverOutline.renderOrder = 12;
  scene.add(consumerHoverOutline);
  const consumerHoverShell = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 1, 1.66),
    new THREE.MeshBasicMaterial({ color: 0xa8ff2b, transparent: true, opacity: 0.14, depthWrite: false, depthTest: false, side: THREE.BackSide }),
  );
  consumerHoverShell.visible = false;
  consumerHoverShell.renderOrder = 11;
  scene.add(consumerHoverShell);
  let pointerFrame = 0;
  let down = null;
  let isCameraDragging = false;
  let hoverConsumerUnit = false;
  let hoverDockDoorIndex = -1;
  let hoverForklift = false;
  let hoverStagingBox = null;
  let hoverStagingMesh = null;
  let hoverRackCode = '';
  const actionAnchor = new THREE.Vector3();
  const hideRackAction = () => {
    rackActionObject.visible = false;
    hoverRackCode = '';
  };
  const showRackAction = (rack) => {
    if (!rack) return hideRackAction();
    hoverRackCode = String(rack.code || rack.id || 'rack');
    const rackEntry = rackEntries.find((entry) => entry.rack === rack);
    if (!rackEntry) return hideRackAction();
    // One stable affordance per rack: always float at the centre of the top
    // beam, never beside every individual slot or box.
    actionAnchor.set(rackEntry.base.x, rackEntry.base.y + rackEntry.height + 0.55, rackEntry.base.z);
    rackActionObject.position.copy(actionAnchor);
    rackActionObject.visible = true;
  };
  const setPointerFromEvent = (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
  };
  const setPointerAtReticle = () => {
    pointer.set(0, 0);
    raycaster.setFromCamera(pointer, camera);
  };
  const isForkliftHit = () => forkliftPickMeshes.length > 0 && raycaster.intersectObjects(forkliftPickMeshes, false).length > 0;
  const setForkliftSelected = (selected) => {
    forkliftSelected = Boolean(selected && forkliftRoot);
    if (forkliftSelection) forkliftSelection.visible = forkliftSelected;
    if (!forkliftSelected) {
      forkliftMotion = null;
      routeLine.visible = false;
      targetMarker.visible = false;
      targetRipple.visible = false;
      missionBeacon.visible = false;
    }
  };
  const findForkliftPath = (start, target) => {
    const cell = 0.5;
    const minX = center.x - halfWarehouseWidth + forkliftClearance;
    const maxX = center.x + halfWarehouseWidth - forkliftClearance;
    const minZ = center.z - halfWarehouseDepth + forkliftClearance;
    const maxZ = center.z + halfWarehouseDepth - forkliftClearance;
    const cols = Math.max(1, Math.floor((maxX - minX) / cell) + 1);
    const rows = Math.max(1, Math.floor((maxZ - minZ) / cell) + 1);
    const blocked = rackEntries.map(({ collisionBox }) => collisionBox?.clone().expandByScalar(forkliftClearance)).filter(Boolean);
    // Stored and staging boxes use the identical manufacturer pallet model;
    // staging differs only by its floor location and selectable workflow.
    boxEntries.concat(stagingEntries).forEach((entry) => {
      const half = entry.scale.clone().multiplyScalar(0.5 + forkliftClearance / Math.max(entry.scale.x, entry.scale.y, entry.scale.z, 0.01));
      blocked.push(new THREE.Box3(entry.position.clone().sub(half), entry.position.clone().add(half)));
    });
    const key = (x, z) => z * cols + x;
    const point = (x, z) => new THREE.Vector3(minX + x * cell, warehouseFloorY + 0.025, minZ + z * cell);
    const walkable = (x, z) => x >= 0 && z >= 0 && x < cols && z < rows && !blocked.some((box) => box.containsPoint(point(x, z)));
    const nearest = (world) => {
      const sx = THREE.MathUtils.clamp(Math.round((world.x - minX) / cell), 0, cols - 1);
      const sz = THREE.MathUtils.clamp(Math.round((world.z - minZ) / cell), 0, rows - 1);
      if (walkable(sx, sz)) return [sx, sz];
      for (let radius = 1; radius < Math.max(cols, rows); radius += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) === radius && walkable(sx + dx, sz + dz)) return [sx + dx, sz + dz];
        }
      }
      return null;
    };
    const from = nearest(start), to = nearest(target);
    if (!from || !to) return [];
    const open = [{ x: from[0], z: from[1], g: 0, f: 0 }];
    const best = new Map([[key(from[0], from[1]), 0]]), parent = new Map();
    const directions = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let end = null;
    while (open.length) {
      open.sort((a, b) => a.f - b.f);
      const current = open.shift();
      if (current.x === to[0] && current.z === to[1]) { end = current; break; }
      directions.forEach(([dx, dz]) => {
        const nx = current.x + dx, nz = current.z + dz;
        if (!walkable(nx, nz)) return;
        if (dx && dz && (!walkable(current.x + dx, current.z) || !walkable(current.x, current.z + dz))) return;
        const g = current.g + (dx && dz ? Math.SQRT2 : 1);
        const nodeKey = key(nx, nz);
        if (g >= (best.get(nodeKey) ?? Infinity)) return;
        best.set(nodeKey, g); parent.set(nodeKey, [current.x, current.z]);
        open.push({ x: nx, z: nz, g, f: g + Math.hypot(to[0] - nx, to[1] - nz) });
      });
    }
    if (!end) return [];
    const cells = [[end.x, end.z]];
    while (cells[0][0] !== from[0] || cells[0][1] !== from[1]) cells.unshift(parent.get(key(cells[0][0], cells[0][1])));
    const path = cells.map(([x, z]) => point(x, z));
    path[0].set(start.x, warehouseFloorY + 0.025, start.z);
    path[path.length - 1].copy(point(to[0], to[1]));
    return path;
  };
  const moveForkliftTo = (target, pickupMesh = null) => {
    if (!forkliftSelected || !forkliftRoot) return;
    const path = findForkliftPath(forkliftRoot.position, target);
    if (path.length < 2) {
      showTargetRipple(target, false);
      return;
    }
    showTargetRipple(target);
    forkliftMotion = { path, index: 1, speed: 2.1, pickupMesh };
    routeLine.geometry.dispose();
    routeLine.geometry = new THREE.BufferGeometry().setFromPoints(path.map((p) => p.clone().setY(warehouseFloorY + 0.045)));
    routeLine.visible = true;
    targetMarker.position.copy(path[path.length - 1]).setY(warehouseFloorY + 0.055);
    targetMarker.visible = true;
    missionBeacon.position.copy(path[path.length - 1]).setY(warehouseFloorY + 0.06);
    missionBeacon.visible = Boolean(pickupMesh);
  };
  const baseColor = (index) => slotEntries[index] ? slotColor(slotEntries[index]) : EMPTY_COLOR;
  const clearHoverFeedback = () => {
    if (hoverIndex >= 0 && slotMesh) slotMesh.setColorAt(hoverIndex, baseColor(hoverIndex));
    if (hoverBoxIndex >= 0 && boxMesh) boxMesh.setColorAt(hoverBoxIndex, boxEntries[hoverBoxIndex].color);
    if (slotMesh) slotMesh.instanceColor.needsUpdate = true;
    hoverRing.visible = false;
    hoverOutline.visible = false;
    hoverShell.visible = false;
    consumerHoverOutline.visible = false;
    consumerHoverShell.visible = false;
    labelObject.visible = false;
    hoverIndex = -1;
    hoverBoxIndex = -1;
    hoverConsumerUnit = false;
    hoverDockDoorIndex = -1;
    hoverForklift = false;
    hoverStagingBox = null;
    hoverStagingMesh = null;
    hideRackAction();
  };
  const updatePointer = (event) => {
    if (isCameraDragging) {
      clearHoverFeedback();
      canvas.style.cursor = 'grabbing';
      return;
    }
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    // Slots are translucent volumes and their front face is naturally closer
    // than a box inside. Test boxes independently and give them click/hover
    // priority so operators can open the actual box record.
    const boxHit = boxMesh ? raycaster.intersectObject(boxMesh, false)[0] : null;
    const stagingHit = stagingBoxPickMeshes.length ? raycaster.intersectObjects(stagingBoxPickMeshes, false)[0] : null;
    const slotHit = slotMesh ? raycaster.intersectObject(slotMesh, false)[0] : null;
    const consumerHit = consumerUnitPickMeshes.length ? raycaster.intersectObjects(consumerUnitPickMeshes, false)[0] : null;
    const doorHit = dockDoorPickMeshes.length ? raycaster.intersectObjects(dockDoorPickMeshes, false)[0] : null;
    const rackHit = rackPickMeshes.length ? raycaster.intersectObjects(rackPickMeshes, false)[0] : null;
    const nextForklift = isForkliftHit();
    const nextBox = Number.isInteger(boxHit?.instanceId) ? boxHit.instanceId : -1;
    const nextStagingBox = stagingHit?.object?.userData?.stagingBox || null;
    const nextStagingMesh = stagingHit?.object || null;
    const consumerIsClosest = Boolean(consumerHit) && (!doorHit || consumerHit.distance <= doorHit.distance) && (!slotHit || consumerHit.distance < slotHit.distance);
    const doorIndex = Number.isInteger(doorHit?.object?.userData?.doorIndex) ? doorHit.object.userData.doorIndex : -1;
    const nextDoor = nextBox < 0 && !consumerIsClosest && doorIndex >= 0 && (!slotHit || doorHit.distance < slotHit.distance) ? doorIndex : -1;
    const nextConsumerUnit = nextBox < 0 && consumerIsClosest;
    const next = nextBox >= 0 || nextStagingBox || nextConsumerUnit || nextDoor >= 0 ? -1 : (Number.isInteger(slotHit?.instanceId) ? slotHit.instanceId : -1);
    const nextRack = nextBox >= 0
      ? boxEntries[nextBox].slotEntry?.rack
      : next >= 0
        ? slotEntries[next].rack
        : rackHit?.object?.userData?.rackByInstance?.[rackHit.instanceId] || null;
    const nextRackCode = nextRack ? String(nextRack.code || nextRack.id || 'rack') : '';
    if (next === hoverIndex && nextBox === hoverBoxIndex && nextStagingBox === hoverStagingBox && nextStagingMesh === hoverStagingMesh && nextConsumerUnit === hoverConsumerUnit && nextDoor === hoverDockDoorIndex && nextForklift === hoverForklift && nextRackCode === hoverRackCode) return;
    if (hoverIndex >= 0) slotMesh.setColorAt(hoverIndex, baseColor(hoverIndex));
    if (hoverBoxIndex >= 0 && boxMesh) boxMesh.setColorAt(hoverBoxIndex, boxEntries[hoverBoxIndex].color);
    hoverIndex = next;
    hoverBoxIndex = nextBox;
    hoverConsumerUnit = nextConsumerUnit;
    hoverDockDoorIndex = nextDoor;
    hoverForklift = nextForklift;
    hoverStagingBox = nextStagingBox;
    hoverStagingMesh = nextStagingMesh;
    if (!hoverConsumerUnit) { consumerHoverOutline.visible = false; consumerHoverShell.visible = false; }
    if (hoverBoxIndex < 0) { hoverRing.visible = false; hoverOutline.visible = false; hoverShell.visible = false; }
    if (hoverForklift) {
      hoverRing.visible = false;
      hoverOutline.visible = false;
      hoverShell.visible = false;
      labelElement.textContent = forkliftSelected ? 'รถโฟล์คลิฟท์ · เลือกแล้ว' : 'รถโฟล์คลิฟท์ · คลิกเพื่อเลือก';
      labelElement.className = 'loc3d-slot-label occupied';
      labelObject.position.copy(forkliftRoot.position).add(new THREE.Vector3(0, 2.5, 0));
      labelObject.visible = true;
      canvas.style.cursor = 'pointer';
    } else if (hoverStagingBox) {
      labelElement.textContent = `รอ Putaway · ${hoverStagingBox.id} · คลิกเพื่อเลือก`;
      labelElement.className = 'loc3d-slot-label occupied';
      labelObject.position.copy(stagingHit.object.position).add(new THREE.Vector3(0, 0.72, 0));
      labelObject.visible = true;
      canvas.style.cursor = 'pointer';
    } else if (hoverBoxIndex >= 0) {
      const entry = boxEntries[hoverBoxIndex];
      boxMesh.setColorAt(hoverBoxIndex, BOX_HOVER_COLOR);
      boxMesh.instanceColor.needsUpdate = true;
      const ringScale = Math.max(entry.scale.x, entry.scale.z) * 1.5;
      hoverRing.position.set(entry.position.x, entry.position.y - entry.scale.y / 2 + 0.022, entry.position.z);
      hoverRing.userData.baseScale = ringScale;
      hoverRing.scale.setScalar(ringScale);
      hoverRing.visible = true;
      hoverOutline.position.copy(entry.position);
      hoverOutline.quaternion.copy(entry.quaternion);
      hoverOutline.scale.copy(entry.scale).multiplyScalar(1.12);
      hoverOutline.visible = true;
      hoverShell.position.copy(entry.position);
      hoverShell.quaternion.copy(entry.quaternion);
      hoverShell.scale.copy(entry.scale).multiplyScalar(1.16);
      hoverShell.visible = true;
      labelElement.textContent = `กล่อง ${entry.box.id}`;
      labelElement.className = 'loc3d-slot-label occupied';
      labelObject.position.copy(entry.position).add(new THREE.Vector3(0, entry.scale.y / 2 + 0.18, 0));
      labelObject.visible = true;
      canvas.style.cursor = 'pointer';
    } else if (hoverConsumerUnit) {
      const consumerBody = consumerUnitPickMeshes[0];
      consumerHoverOutline.position.copy(consumerBody.position);
      consumerHoverShell.position.copy(consumerBody.position);
      consumerHoverOutline.visible = true;
      consumerHoverShell.visible = true;
      labelElement.textContent = `Consumer Unit · คลิกเพื่อ${warehousePowerOn ? 'ปิด' : 'เปิด'}ไฟ`;
      labelElement.className = 'loc3d-slot-label occupied';
      labelObject.position.copy(consumerBody.position).add(new THREE.Vector3(0, 0.72, 0));
      labelObject.visible = true;
      canvas.style.cursor = 'pointer';
    } else if (hoverDockDoorIndex >= 0) {
      const door = dockDoors[hoverDockDoorIndex];
      const doorPosition = new THREE.Vector3();
      door.leaf.getWorldPosition(doorPosition);
      labelElement.textContent = `ประตู ${door.door.gateNo} · ${door.open ? 'เปิดอยู่ · คลิกบานประตูเพื่อปิด' : 'ปิดอยู่ · คลิกบานประตูเพื่อเปิด'}`;
      labelElement.className = 'loc3d-slot-label occupied';
      labelObject.position.copy(doorPosition).add(new THREE.Vector3(0, 2.35, 0));
      labelObject.visible = true;
      canvas.style.cursor = 'pointer';
    } else if (hoverIndex >= 0) {
      const entry = slotEntries[hoverIndex];
      const state = slotState(entry);
      const hiddenOccupied = state === 'occupied' && !showOccupiedSlots;
      slotMesh.setColorAt(hoverIndex, state === 'empty' || hiddenOccupied ? EMPTY_HOVER_COLOR : HOVER_COLOR);
      labelElement.textContent = state === 'full' ? 'เต็ม' : hiddenOccupied ? 'ช่องจัดเก็บ' : state === 'occupied' ? 'มีของ' : 'ว่าง';
      labelElement.className = `loc3d-slot-label ${hiddenOccupied ? 'empty' : state}`;
      // Keep the slot-status label inside the bay instead of floating above its beam.
      labelObject.position.copy(entry.position).add(new THREE.Vector3(0, 0.05, 0));
      labelObject.visible = true;
      canvas.style.cursor = 'pointer';
    } else {
      hoverRing.visible = false;
      hoverOutline.visible = false;
      hoverShell.visible = false;
      labelObject.visible = false;
      canvas.style.cursor = 'default';
    }
    showRackAction(hoverConsumerUnit || hoverDockDoorIndex >= 0 || hoverForklift ? null : nextRack);
    if (slotMesh) slotMesh.instanceColor.needsUpdate = true;
  };
  const onPointerMove = (event) => {
    if (firstPerson && document.pointerLockElement === canvas) {
      camera.rotation.y -= event.movementX * 0.0022;
      camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - event.movementY * 0.0022, -1.38, 1.38);
      setPointerAtReticle();
      updatePointer({ clientX: canvas.getBoundingClientRect().left + canvas.clientWidth / 2, clientY: canvas.getBoundingClientRect().top + canvas.clientHeight / 2 });
      return;
    }
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 5) isCameraDragging = true;
    if (pointerFrame) cancelAnimationFrame(pointerFrame);
    pointerFrame = requestAnimationFrame(() => updatePointer(event));
  };
  const onPointerDown = (event) => {
    down = { x: event.clientX, y: event.clientY };
    isCameraDragging = false;
  };
  const onPointerUp = (event) => {
    const wasCameraDragging = isCameraDragging;
    if (down && !wasCameraDragging && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5) {
      if (firstPerson && document.pointerLockElement === canvas) {
        const rect = canvas.getBoundingClientRect();
        updatePointer({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
      } else setPointerFromEvent(event);
      // The forklift is its own on/off control: clicking it again clears the
      // selection (and any pending route) instead of leaving it stuck active.
      if (isForkliftHit()) setForkliftSelected(!forkliftSelected);
      else if (hoverStagingBox) {
        if (forkliftSelected && hoverStagingMesh) {
          if (forkliftLoadAssembly?.parent === forkliftRoot || forkliftMotion?.pickupMesh) {
            window.toast?.('รถยกมีพาเรทอยู่แล้ว', 'ต้องนำพาเรทปัจจุบันไปวางก่อน จึงรับกล่องถัดไปได้', 'warn');
            return;
          }
          // A forklift operator is issuing a physical pickup command here;
          // opening the generic box drawer would interrupt that workflow.
          const palletPoint = hoverStagingMesh.position.clone();
          palletPoint.y = warehouseFloorY + 0.025;
          moveForkliftTo(palletPoint, hoverStagingMesh);
          window.toast?.('กำลังไปรับกล่อง', `${hoverStagingBox.id} · พาเลท Putaway`, 'ok');
        } else {
          releasePointerForModal();
          onBoxSelect?.(hoverStagingBox.id);
        }
      }
      else if (hoverBoxIndex >= 0) {
        releasePointerForModal();
        onBoxSelect?.(boxEntries[hoverBoxIndex].box.id);
      }
      else if (hoverIndex >= 0) {
        releasePointerForModal();
        onSelect?.(slotEntries[hoverIndex].slot.id);
      }
      else if (hoverConsumerUnit) setWarehousePower(!warehousePowerOn);
      else if (hoverDockDoorIndex >= 0) toggleDockDoor(hoverDockDoorIndex);
      else if (forkliftSelected) {
        // Give immediate feedback on the first click of a double-click. The
        // second click still owns the actual move command below.
        const floorHit = raycaster.intersectObject(floor, false)[0];
        if (floorHit) showTargetRipple(floorHit.point);
      }
    }
    down = null;
    isCameraDragging = false;
    if (wasCameraDragging) canvas.style.cursor = 'default';
  };
  const onPointerLeave = () => {
    if (hoverIndex >= 0 && slotMesh) {
      slotMesh.setColorAt(hoverIndex, baseColor(hoverIndex));
      slotMesh.instanceColor.needsUpdate = true;
    }
    if (hoverBoxIndex >= 0 && boxMesh) {
      boxMesh.setColorAt(hoverBoxIndex, boxEntries[hoverBoxIndex].color);
      boxMesh.instanceColor.needsUpdate = true;
    }
    hoverRing.visible = false;
    hoverOutline.visible = false;
    hoverShell.visible = false;
    consumerHoverOutline.visible = false;
    consumerHoverShell.visible = false;
    hoverIndex = -1;
    hoverBoxIndex = -1;
    hoverConsumerUnit = false;
    hoverDockDoorIndex = -1;
    hoverForklift = false;
    hoverStagingBox = null;
    hoverStagingMesh = null;
    labelObject.visible = false;
    canvas.style.cursor = 'default';
    window.setTimeout(() => {
      if (!actionPointerOver) hideRackAction();
    }, 0);
  };
  canvas.addEventListener('pointermove', onPointerMove, { passive: true });
  canvas.addEventListener('pointerdown', onPointerDown, { passive: true });
  canvas.addEventListener('pointerup', onPointerUp, { passive: true });
  canvas.addEventListener('pointerleave', onPointerLeave, { passive: true });
  const onDoubleClick = (event) => {
    if (firstPerson) return;
    if (!forkliftSelected || !forkliftRoot) return;
    setPointerFromEvent(event);
    const hit = raycaster.intersectObject(floor, false)[0];
    if (hit) moveForkliftTo(hit.point);
  };
  canvas.addEventListener('dblclick', onDoubleClick);

  const resize = () => {
    const width = Math.max(320, stage.clientWidth);
    const height = Math.max(320, stage.clientHeight);
    renderer.setSize(width, height, false);
    labelRenderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  resize();

  const assets = assetPipeline(renderer);
  let disposed = false;
  const loadExitAsset = (url, name, height, position) => assets.load(url).then(({ scene: asset }) => {
    if (disposed) return;
    asset.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
      if (name === 'emergency-exit-sign' && object.material) {
        object.material = object.material.clone();
        object.material.color.setHex(0xffec62);
        if ('emissive' in object.material) {
          object.material.emissive.setHex(0xffd52f);
          object.material.emissiveIntensity = 2.5;
        }
      }
    });
    const rawBounds = new THREE.Box3().setFromObject(asset);
    const rawSize = rawBounds.getSize(new THREE.Vector3());
    const scale = height / Math.max(rawSize.y, 0.01);
    asset.scale.setScalar(scale);
    const scaledBounds = new THREE.Box3().setFromObject(asset);
    const scaledCenter = scaledBounds.getCenter(new THREE.Vector3());
    const root = new THREE.Group();
    root.name = name;
    root.userData.asset = url;
    asset.position.set(-scaledCenter.x, -scaledBounds.min.y, -scaledCenter.z);
    root.add(asset);
    root.position.copy(position);
    // Face the warehouse aisle; double-sided GLB materials still read from
    // either camera direction if an asset was authored with reversed winding.
    root.rotation.y = Math.PI;
    scene.add(root);
  }).catch((error) => console.warn(`[Warehouse3D] ${name} asset could not be loaded.`, error));
  // The green mark in the reference is the clear back-wall bay, left of the
  // rack block. Keep the exit door flush to that wall and its sign above it.
  const exitWallZ = center.z + halfWarehouseDepth - 0.18;
  const exitX = center.x - halfWarehouseWidth * 0.58;
  loadExitAsset(
    '/models/fire_exit_door.glb',
    'fire-exit-door',
    2.3,
    new THREE.Vector3(exitX, warehouseFloorY + 0.01, exitWallZ),
  );
  loadExitAsset(
    '/models/emergency_exit_low_poly.glb',
    'emergency-exit-sign',
    0.34,
    new THREE.Vector3(exitX, warehouseFloorY + 2.56, exitWallZ - 0.025),
  );
  // Use the supplied manufacturer pallet model for both stored cartons and
  // the staging bay. The placement list is still derived only from DB boxes.
  assets.load('/models/wooden_pallets.glb').then(({ scene: palletTemplate }) => {
    if (disposed) return;
    palletTemplate.traverse((object) => {
      if (!object.isMesh) return;
      // This GLB contains two pallet variants. Pallet_2 has the solid,
      // close-boarded top deck requested for the warehouse; discard the open
      // slatted alternative so every displayed pallet uses the same type.
      if (object.name !== 'Pallet_2_Pallet_2_0') {
        object.removeFromParent();
        return;
      }
      // Preserve the source wood grain but warm the albedo to match a real
      // timber pallet rather than the washed-out grey seen under warehouse LEDs.
      object.material = object.material.clone();
      object.material.color.setHex(0xc08a57);
      object.material.roughness = 0.78;
      object.material.metalness = 0;
      if ('emissive' in object.material) {
        object.material.emissive.setHex(0x1c0d05);
        object.material.emissiveIntensity = 0.08;
      }
      object.castShadow = true;
      object.receiveShadow = true;
    });
    const rawBounds = new THREE.Box3().setFromObject(palletTemplate);
    const rawSize = rawBounds.getSize(new THREE.Vector3());
    const rawCenter = rawBounds.getCenter(new THREE.Vector3());
    const addPallet = (position, quaternion, width, depth, yOffset = 0, stagingBoxId = '') => {
      const pallet = palletTemplate.clone(true);
      if (stagingBoxId) {
        pallet.userData.stagingBoxId = stagingBoxId;
        pallet.traverse((object) => { object.userData.stagingBoxId = stagingBoxId; });
      }
      // Every pallet footprint is 1.00 × 1.20 m. Keep Y proportional to the
      // smaller horizontal scale so the source model's feet remain realistic.
      const scaleX = width / Math.max(rawSize.x, 0.01);
      const scaleZ = depth / Math.max(rawSize.z, 0.01);
      const scaleY = Math.min(scaleX, scaleZ);
      pallet.position.copy(position);
      pallet.position.y += yOffset;
      pallet.quaternion.copy(quaternion);
      pallet.scale.set(scaleX, scaleY, scaleZ);
      const baseOffset = new THREE.Vector3(
        -rawCenter.x * scaleX,
        -rawBounds.min.y * scaleY,
        -rawCenter.z * scaleZ,
      ).applyQuaternion(quaternion);
      pallet.position.add(baseOffset);
      scene.add(pallet);
      // The downloaded asset has a very thin silhouette under a loaded box.
      // Add the real deck boards and runners so the pallet is visibly a
      // pallet from aisle height — shared by rack stock and staging stock.
      const timber = new THREE.MeshStandardMaterial({ color: 0xb97a3e, roughness: 0.8, metalness: 0 });
      const addTimber = (sx, sy, sz, localX, localY, localZ) => {
        const board = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), timber);
        if (stagingBoxId) board.userData.stagingBoxId = stagingBoxId;
        board.position.copy(new THREE.Vector3(localX, localY + yOffset, localZ).applyQuaternion(quaternion).add(position));
        board.quaternion.copy(quaternion);
        board.castShadow = board.receiveShadow = true;
        scene.add(board);
      };
      [-0.43, -0.215, 0, 0.215, 0.43].forEach((localZ) => addTimber(width * 0.94, 0.04, depth * 0.15, 0, 0.16, localZ * depth));
      [-0.38, 0, 0.38].forEach((localZ) => addTimber(width * 0.72, 0.11, depth * 0.13, 0, 0.075, localZ * depth));
      [-0.37, 0.37].forEach((localZ) => addTimber(width * 0.94, 0.035, depth * 0.11, 0, 0.018, localZ * depth));
    };
    boxEntries.concat(stagingEntries).forEach((entry) => {
      const palletWidth = 1.0;
      const palletDepth = 1.2;
      const palletCenter = entry.position.clone();
      palletCenter.y -= entry.scale.y / 2 + 0.085;
      addPallet(
        palletCenter,
        entry.quaternion,
        palletWidth,
        palletDepth,
        0,
        stagingEntries.includes(entry) ? entry.box.id : '',
      );
    });
  }).catch((error) => console.warn('[Warehouse3D] Wooden pallet asset could not be loaded.', error));
  // CC BY model: "Forklift" by brezineman. Keep the original attribution
  // alongside the asset rather than baking it into an unrelated warehouse mesh.
  assets.load('/models/forklift.glb').then(({ scene: forklift }) => {
    if (disposed) return;
    forklift.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
      forkliftPickMeshes.push(object);
      // The real tyres are authored together in Object_0. Split their vertices
      // into the four physical wheel regions so the original model—not added
      // placeholder meshes—can roll around its own axle.
      if (object.name !== 'Object_0') return;
      const position = object.geometry.getAttribute('position');
      const normal = object.geometry.getAttribute('normal');
      if (!position) return;
      const basePositions = position.array.slice();
      const wheels = [
        { centerX: -0.41, centerY: -0.785, centerZ: 0.265, vertices: [] },
        { centerX: 0.41, centerY: -0.785, centerZ: 0.265, vertices: [] },
        { centerX: -0.41, centerY: 0.615, centerZ: 0.215, vertices: [] },
        { centerX: 0.41, centerY: 0.615, centerZ: 0.215, vertices: [] },
      ];
      for (let index = 0; index < position.count; index += 1) {
        const offset = index * 3;
        const x = basePositions[offset];
        const y = basePositions[offset + 1];
        const z = basePositions[offset + 2];
        for (const wheel of wheels) {
          if (Math.abs(x - wheel.centerX) <= 0.16
            && Math.hypot(y - wheel.centerY, z - wheel.centerZ) <= 0.34) {
            wheel.vertices.push(index);
            break;
          }
        }
      }
      if (wheels.every((wheel) => wheel.vertices.length > 40)) {
        forkliftWheelMeshes.push({ position, normal, wheels, radius: 0.265 });
      } else {
        console.warn('[Warehouse3D] Could not isolate all four forklift wheels from the source model.');
      }
    });
    const rawBounds = new THREE.Box3().setFromObject(forklift);
    const rawSize = rawBounds.getSize(new THREE.Vector3());
    // Normalize downloaded assets to a real warehouse forklift footprint,
    // without depending on the arbitrary authoring unit of the GLB file.
    // Keep the downloaded forklift close to the warehouse reference scale.
    // The previous 3.25 m footprint made it visibly oversized next to the
    // electrical cabinet and narrowed the driving lane unnecessarily.
    // Medium-duty 2–3 tonne truck: about 2.6 m body footprint (excluding
    // forks), suitable for a standard loaded warehouse pallet.
    const scale = 2.65 / Math.max(rawSize.x, rawSize.z, 0.01);
    forklift.scale.setScalar(scale);
    const scaledBounds = new THREE.Box3().setFromObject(forklift);
    const scaledSize = scaledBounds.getSize(new THREE.Vector3());
    // The path grid already respects the physical rack envelope. Keeping an
    // extra 0.55–0.72 m buffer is enough for safe steering without closing a
    // real 4 m forklift aisle completely.
    forkliftClearance = Math.min(0.72, Math.max(0.55, Math.max(scaledSize.x, scaledSize.z) * 0.22));
    forklift.position.x -= scaledBounds.min.x + scaledSize.x / 2;
    forklift.position.z -= scaledBounds.min.z + scaledSize.z / 2;
    forklift.position.y -= scaledBounds.min.y;

    forkliftRoot = new THREE.Group();
    forkliftRoot.name = 'forklift';
    forkliftRoot.userData.attribution = 'Forklift by brezineman (CC BY)';
    forkliftRoot.add(forklift);
    const initialForkliftPosition = savedForklift?.position || {};
    forkliftRoot.position.set(
      Number.isFinite(Number(initialForkliftPosition.x)) ? Number(initialForkliftPosition.x) : center.x + rackBoundaryWidth * 0.34,
      Number.isFinite(Number(initialForkliftPosition.y)) ? Number(initialForkliftPosition.y) : warehouseFloorY + 0.012,
      Number.isFinite(Number(initialForkliftPosition.z)) ? Number(initialForkliftPosition.z) : aisleCenterZ,
    );
    forkliftRoot.rotation.y = Number.isFinite(Number(savedForklift?.rotationY)) ? Number(savedForklift.rotationY) : -Math.PI * 0.5;
    scene.add(forkliftRoot);
    forkliftWheelMeshes.forEach((wheelMesh) => {
      wheelMesh.radius *= scale;
    });
    forkliftSelection = new THREE.BoxHelper(forkliftRoot, 0xa8ff2b);
    forkliftSelection.material.depthTest = false;
    forkliftSelection.material.transparent = true;
    forkliftSelection.material.opacity = 0.95;
    forkliftSelection.renderOrder = 16;
    forkliftSelection.visible = false;
    scene.add(forkliftSelection);
  }).catch((error) => console.warn('[Warehouse3D] Forklift asset could not be loaded.', error));
  const perf = hud.querySelector('.loc3d-perf');
  let frames = 0;
  let lastFpsAt = performance.now();
  let lastAnimateAt = performance.now();
  const movementDirection = new THREE.Vector3();
  const movementQuaternion = new THREE.Quaternion();
  const movementEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const walkForward = new THREE.Vector3();
  const walkRight = new THREE.Vector3();
  const walkCandidate = new THREE.Vector3();
  const animate = () => {
    const frameNow = performance.now();
    const deltaSeconds = Math.min(0.05, Math.max(0, (frameNow - lastAnimateAt) / 1000));
    lastAnimateAt = frameNow;
    if (forkliftMotion && forkliftRoot) {
      const destination = forkliftMotion.path[forkliftMotion.index];
      movementDirection.subVectors(destination, forkliftRoot.position);
      movementDirection.y = 0;
      const remaining = movementDirection.length();
      if (remaining < 0.035) {
        forkliftRoot.position.copy(destination);
        forkliftMotion.index += 1;
        if (forkliftMotion.index >= forkliftMotion.path.length) {
          saveForkliftPosition();
          const pickupMesh = forkliftMotion.pickupMesh;
          if (pickupMesh && pickupMesh.parent) {
            const pickupId = pickupMesh.userData.stagingBox?.id || pickupMesh.userData.stagingBoxId || '';
            // Keep each loaded pallet as one assembly.  Re-parenting every
            // mesh independently used to break the source pallet hierarchy
            // and retained its world position beside/behind the truck.
            const pickupRoots = [];
            scene.traverse((object) => {
              if (object.userData?.stagingBoxId !== pickupId) return;
              if (object.parent?.userData?.stagingBoxId === pickupId) return;
              pickupRoots.push(object);
            });
            if (pickupRoots.length) {
              const loadAssembly = new THREE.Group();
              loadAssembly.name = `forklift-load-${pickupId}`;
              loadAssembly.userData.stagingBoxId = pickupId;
              // Establish the assembly origin at the selected pallet before
              // re-parenting.  Starting at (0,0,0) leaves every child with a
              // world-sized offset, which is why a lifted box appeared at the
              // opposite end of the warehouse.
              pickupMesh.getWorldPosition(loadAssembly.position);
              scene.add(loadAssembly);
              pickupRoots.forEach((object) => loadAssembly.attach(object));
              forkliftRoot.attach(loadAssembly);
              // ForkliftRoot's local +Z is the direction of the original
              // model's forks.  Place the pallet centre just above the forks
              // rather than preserving its former staging-bay coordinates.
              // Seat the deck directly over the fork carriage: lift it clear
              // of the floor and keep the pallet holes around the fork tips.
              loadAssembly.position.set(0, 0.78, 1.08);
              // Turn the pallet so its fork pockets face the mast/forks,
              // rather than exposing the pocket openings sideways.
              loadAssembly.rotation.set(0, Math.PI * 0.5, 0);
              forkliftLoadAssembly = loadAssembly;
            }
            window.toast?.('ยกพาเลทพร้อมกล่องขึ้นงาแล้ว', `${pickupId} · พร้อมนำไป Putaway`, 'ok');
          saveForkliftPosition();
          }
          forkliftMotion = null;
          routeLine.visible = false;
          missionBeacon.visible = false;
        }
      } else {
        movementDirection.normalize();
        const distanceTravelled = Math.min(remaining, forkliftMotion.speed * deltaSeconds);
        forkliftRoot.position.addScaledVector(movementDirection, distanceTravelled);
        forkliftWheelMeshes.forEach((wheelMesh) => {
          const rotation = -distanceTravelled / wheelMesh.radius;
          wheelMesh.wheels.forEach((wheel) => {
            const cos = Math.cos(rotation);
            const sin = Math.sin(rotation);
            wheel.vertices.forEach((vertex) => {
              const offset = vertex * 3;
              const y = wheelMesh.position.array[offset] - wheel.centerY;
              const z = wheelMesh.position.array[offset + 2] - wheel.centerZ;
              wheelMesh.position.array[offset + 1] = wheel.centerY + y * cos - z * sin;
              wheelMesh.position.array[offset + 2] = wheel.centerZ + y * sin + z * cos;
              if (wheelMesh.normal) {
                const normalY = wheelMesh.normal.array[offset + 1];
                const normalZ = wheelMesh.normal.array[offset + 2];
                wheelMesh.normal.array[offset + 1] = normalY * cos - normalZ * sin;
                wheelMesh.normal.array[offset + 2] = normalY * sin + normalZ * cos;
              }
            });
          });
          wheelMesh.position.needsUpdate = true;
          if (wheelMesh.normal) wheelMesh.normal.needsUpdate = true;
        });
        movementEuler.set(0, Math.atan2(movementDirection.x, movementDirection.z), 0);
        movementQuaternion.setFromEuler(movementEuler);
        forkliftRoot.quaternion.slerp(movementQuaternion, 1 - Math.exp(-8 * deltaSeconds));
      }
      forkliftSelection?.update();
    }
    if (forkliftSelection?.visible) {
      forkliftSelection.material.opacity = 0.68 + Math.sin(frameNow * 0.01) * 0.25;
      forkliftSelection.update();
    }
    if (targetMarker.visible) {
      const pulse = 1 + Math.sin(frameNow * 0.009) * 0.16;
      targetMarker.scale.setScalar(pulse);
    }
    if (missionBeacon.visible) {
      const pulse = 1 + Math.sin(frameNow * 0.011) * 0.18;
      missionBeacon.scale.setScalar(pulse);
      missionBeaconMaterial.opacity = 0.55 + Math.sin(frameNow * 0.011) * 0.28;
    }
    if (targetRipple.visible) {
      const elapsed = Math.min(1, (frameNow - targetRippleStartedAt) / 720);
      targetRipple.scale.setScalar(0.45 + elapsed * 2.3);
      targetRippleMaterial.opacity = (1 - elapsed) * 0.98;
      if (elapsed >= 1) targetRipple.visible = false;
    }
    dockDoors.forEach((door) => {
      const target = door.open ? 1 : 0;
      door.progress += (target - door.progress) * (1 - Math.exp(-8 * deltaSeconds));
      // A sectional door retracts upward: preserve its top edge while the
      // leaf compresses into the lintel, leaving the dock clear when open.
      const scaleY = 1 - door.progress * 0.92;
      door.leaf.scale.y = scaleY;
      door.leaf.position.y = warehouseFloorY + (1 - scaleY) * door.height;
      door.openingMaterial.opacity = door.progress;
    });
    // The load is anchored to the vehicle's local fork coordinate every
    // frame, never to a former world coordinate in the staging bay.
    if (forkliftLoadAssembly?.parent === forkliftRoot) {
      forkliftLoadAssembly.position.set(0, 0.78, 1.08);
      forkliftLoadAssembly.rotation.set(0, Math.PI * 0.5, 0);
    }
    if (firstPerson) {
      camera.getWorldDirection(walkForward);
      walkForward.y = 0;
      walkForward.normalize();
      walkRight.crossVectors(walkForward, up).normalize();
      walkCandidate.set(0, 0, 0);
      if (walkKeys.has('KeyW')) walkCandidate.add(walkForward);
      if (walkKeys.has('KeyS')) walkCandidate.sub(walkForward);
      if (walkKeys.has('KeyD')) walkCandidate.add(walkRight);
      if (walkKeys.has('KeyA')) walkCandidate.sub(walkRight);
      const isWalking = walkCandidate.lengthSq() > 0;
      if (isWalking) {
        const running = walkKeys.has('ShiftLeft') || walkKeys.has('ShiftRight');
        const speed = running ? 4.3 : 2.15;
        walkCandidate.normalize().multiplyScalar(speed * deltaSeconds).add(camera.position);
        const blockedRack = rackEntries.some(({ collisionBox }) => collisionBox?.clone().expandByScalar(0.3).containsPoint(walkCandidate));
        const blockedBox = boxEntries.concat(stagingEntries).some((entry) => {
          const halfX = entry.scale.x * 0.5 + 0.28;
          const halfZ = entry.scale.z * 0.5 + 0.28;
          return Math.abs(walkCandidate.x - entry.position.x) <= halfX
            && Math.abs(walkCandidate.z - entry.position.z) <= halfZ;
        });
        const blockedWalk = blockedRack || blockedBox;
        if (!blockedWalk) {
          camera.position.x = walkCandidate.x;
          camera.position.z = walkCandidate.z;
        }
        walkHeadBobPhase += deltaSeconds * (running ? 15 : 10);
        walkHeadBobOffset = Math.sin(walkHeadBobPhase) * (running ? 0.045 : 0.028);
      } else {
        walkHeadBobOffset *= Math.exp(-14 * deltaSeconds);
      }
      walkVerticalVelocity -= 15.5 * deltaSeconds;
      walkJumpHeight += walkVerticalVelocity * deltaSeconds;
      if (walkJumpHeight <= 0) {
        walkJumpHeight = 0;
        walkVerticalVelocity = 0;
      }
      const crouching = walkKeys.has('ControlLeft') || walkKeys.has('ControlRight');
      camera.position.y = warehouseFloorY + (crouching ? 1.12 : walkEyeHeight) + walkJumpHeight + walkHeadBobOffset;
    } else controls.update();
    keepCameraInsideWarehouse();
    updateRackLabelMode();
    updateOccupancyOverlay();
    if (hoverRing.visible) {
      const pulse = 1 + Math.sin(performance.now() * 0.008) * 0.12;
      hoverRing.scale.setScalar((hoverRing.userData.baseScale || 1) * pulse);
      hoverRingMaterial.opacity = 0.74 + Math.sin(performance.now() * 0.008) * 0.22;
      hoverOutlineMaterial.opacity = 0.7 + Math.sin(performance.now() * 0.012) * 0.25;
    }
    if (consumerHoverOutline.visible) {
      const pulse = 1 + Math.sin(performance.now() * 0.009) * 0.045;
      consumerHoverOutline.scale.setScalar(pulse);
      consumerHoverShell.scale.setScalar(pulse);
      consumerHoverMaterial.opacity = 0.72 + Math.sin(performance.now() * 0.009) * 0.24;
    }
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    frames += 1;
    const now = performance.now();
    if (now - lastFpsAt >= 1000) {
      const fps = Math.round(frames * 1000 / (now - lastFpsAt));
      // WebGPU accumulates this counter until info.reset(); WebGL normally
      // resets it every frame. Normalize the HUD so both report calls/frame.
      const renderedCalls = renderer.info.render.calls;
      const drawCalls = renderer.isWebGPURenderer
        ? Math.round(renderedCalls / Math.max(frames, 1))
        : renderedCalls;
      if (perf) perf.textContent = `${fps} FPS · ${drawCalls} draw calls/frame`;
      if (renderer.isWebGPURenderer) renderer.info.reset?.();
      frames = 0;
      lastFpsAt = now;
    }
  };
  // Browser-synchronized rendering follows the active display's refresh rate
  // (60/120/144 Hz, etc.). Do not introduce a fixed 60 FPS throttle here.
  renderer.setAnimationLoop(animate);
  stage.querySelector('.loc3d-loading')?.remove();

  return {
    assets,
    setLanguage() {
      updateFirstPersonCopy();
    },
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      if (pointerFrame) cancelAnimationFrame(pointerFrame);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('dblclick', onDoubleClick);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      fullscreenButton.removeEventListener('click', toggleFullscreen);
      fullscreenButton.remove();
      window.removeEventListener('keydown', onFullscreenShortcut);
      firstPersonButton.removeEventListener('click', toggleFirstPerson);
      firstPersonButton.remove();
      window.removeEventListener('keydown', onFirstPersonShortcut);
      firstPersonHint.remove();
      firstPersonOverlay.remove();
      window.removeEventListener('keydown', onWalkKey);
      window.removeEventListener('keyup', onWalkKey);
      window.removeEventListener('keydown', onFirstPersonBrowserShortcut, { capture: true });
      if (document.pointerLockElement === canvas) document.exitPointerLock?.();
      document.removeEventListener('fullscreenchange', syncFullscreenPortals);
      modalPointerObserver.disconnect();
      if (fallbackFullscreen) setFallbackFullscreen(false);
      syncFullscreenPortals();
      rackActionButton.remove();
      warehouseTitle.remove();
      controls.dispose();
      assets.dispose();
      labelRenderer.domElement.remove();
      hud.remove();
      scene.traverse((object) => {
        if (object.geometry && object.geometry !== UNIT_BOX) object.geometry.dispose?.();
        const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
        materials.forEach((material) => material.dispose?.());
      });
      floorTexture.dispose();
      floorMarkTextures.forEach((texture) => texture.dispose());
      wallDetailTextures.forEach((texture) => texture.dispose());
      labelTextures.forEach((texture) => texture.dispose());
      renderer.dispose();
    },
  };
}

async function mount(canvas, locations, occupancy, onSelect, onBoxSelect, warehouseName, onWarehouseNavigate) {
  if (!canvas) return null;
  const currentGeneration = ++generation;
  activeController?.dispose();
  activeController = null;
  const stage = canvas.parentElement;
  try {
    const model = await loadModel(locations || [], occupancy || {});
    if (!model.warehouseName && warehouseName) model.warehouseName = warehouseName;
    if (currentGeneration !== generation || !canvas.isConnected) return null;
    const controller = await createScene(canvas, model, onSelect, onBoxSelect, onWarehouseNavigate);
    if (currentGeneration !== generation || !canvas.isConnected) {
      controller.dispose();
      return null;
    }
    activeController = controller;
    return controller;
  } catch (error) {
    console.error('[Warehouse3D] scene initialization failed.', error);
    const loading = stage?.querySelector('.loc3d-loading');
    if (loading) loading.textContent = 'เปิดมุมมอง 3D ไม่สำเร็จ';
    return null;
  }
}

function unmount() {
  generation += 1;
  activeController?.dispose();
  activeController = null;
}

window.LocationWarehouse3D = { mount, unmount, scaleToMetres: CM_TO_M };
const previousLanguageHook = window.btLangChanged;
window.btLangChanged = (language) => {
  previousLanguageHook?.(language);
  activeController?.setLanguage?.(language);
};
