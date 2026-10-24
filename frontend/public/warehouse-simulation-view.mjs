import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSimulation } from './warehouse-simulation-engine.mjs';

// This scene consumes only the simulation engine and local static modules.
// Every box transform comes from its engine snapshot, including carried loads.
const canvas = document.querySelector('#warehouse');
const orbitButton = document.querySelector('#orbit-view');
const firstPersonButton = document.querySelector('#first-person-view');
const abort = new AbortController();
const eventOptions = { signal: abort.signal };
const geometries = new Map();
const materials = new Set();
const textures = new Set();
const instances = new Set();
let renderer;
let controls;
let simulation;
let frame = 0;
let stopped = false;
let started = false;
let exited = false;
let previousTime = null;

const tellParent = (type, extra = {}) => {
  window.parent.postMessage({ type, ...extra }, window.location.origin);
};

function cleanup() {
  if (stopped) return;
  stopped = true;
  cancelAnimationFrame(frame);
  abort.abort();
  controls?.dispose();
  simulation?.dispose();
  for (const mesh of instances) mesh.dispose();
  for (const geometry of geometries.values()) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
  renderer?.dispose();
}

function fail(error) {
  tellParent('warehouse-simulation-error', {
    message: error?.message || 'The warehouse simulation could not render.',
  });
  cleanup();
}

window.addEventListener('pagehide', cleanup, eventOptions);
window.addEventListener('error', (event) => fail(event.error || new Error(event.message)), eventOptions);
window.addEventListener('unhandledrejection', (event) => fail(event.reason), eventOptions);

function material(color, roughness = 0.72, metalness = 0) {
  const result = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  materials.add(result);
  return result;
}

function geometry(kind, ...dimensions) {
  const key = `${kind}:${dimensions.join(',')}`;
  if (!geometries.has(key)) {
    geometries.set(key, kind === 'box'
      ? new THREE.BoxGeometry(...dimensions)
      : kind === 'cylinder'
        ? new THREE.CylinderGeometry(...dimensions)
        : new THREE.PlaneGeometry(...dimensions));
  }
  return geometries.get(key);
}

function cuboid(parent, size, position, surface, castShadow = true) {
  const mesh = new THREE.Mesh(geometry('box', ...size), surface);
  mesh.position.set(...position);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function sign(parent, text, width, height, position, options = {}) {
  const backing = document.createElement('canvas');
  backing.width = 1024;
  backing.height = Math.max(96, Math.round(1024 * height / width));
  const context = backing.getContext('2d');
  context.fillStyle = options.background || '#123d65';
  context.fillRect(0, 0, backing.width, backing.height);
  context.fillStyle = options.color || '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `600 ${Math.floor(backing.height * 0.57)}px "Segoe UI", Arial, sans-serif`;
  context.fillText(text, backing.width / 2, backing.height / 2, backing.width * 0.92);
  const texture = new THREE.CanvasTexture(backing);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  textures.add(texture);
  const surface = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
  materials.add(surface);
  const mesh = new THREE.Mesh(geometry('plane', width, height), surface);
  mesh.position.set(...position);
  mesh.rotation.y = Math.PI;
  if (options.floor) mesh.rotation.set(-Math.PI / 2, 0, Math.PI);
  parent.add(mesh);
  return mesh;
}

function initialize() {
  simulation = createSimulation();
  const { layout } = simulation;
  if (layout.racks.length !== 5 || simulation.getState().boxes.length !== 10) {
    throw new Error('The simulation layout must contain five racks and ten boxes.');
  }
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdce5eb);
  scene.fog = new THREE.Fog(0xdce5eb, 110, 225);
  const camera = new THREE.PerspectiveCamera(47, 1, 0.08, 260);
  const bounds = layout.floorBounds;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const floorWidth = bounds.maxX - bounds.minX;
  const floorDepth = bounds.maxZ - bounds.minZ;

  const surfaces = {
    floor: material(0xc1ced4, 0.94), seam: material(0xaebdc5),
    blue: material(0x1760a1, 0.49, 0.35), orange: material(0xee7e26, 0.58, 0.15),
    steel: material(0x8697a1, 0.55, 0.6), dark: material(0x25333c, 0.56, 0.25),
    wall: material(0xe7edf0), upperWall: material(0xa7bac8), white: material(0xf3f4ef),
    yellow: material(0xf4bd25, 0.4, 0.3), tire: material(0x22292e, 0.95),
    rim: material(0xb2bbc1, 0.35, 0.7), seat: material(0x29343c, 0.93),
    wood: material(0xbb8b53, 0.95), woodLight: material(0xd4aa70, 0.93),
    carton: material(0xc99a63, 0.96), tape: material(0xe4c792, 0.86),
    stripe: material(0xf1c950, 0.82), light: material(0xffefbd, 0.35),
  };

  scene.add(new THREE.HemisphereLight(0xf5fbff, 0x73838b, 2.6));
  const sun = new THREE.DirectionalLight(0xfff5df, 3.7);
  sun.position.set(-24, 44, -24);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -65, right: 65, top: 50, bottom: -40, near: 1, far: 130 });
  sun.shadow.normalBias = 0.035;
  sun.shadow.bias = -0.00015;
  sun.target.position.set(centerX, 0, centerZ);
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0xd0e8ff, 1.05);
  fill.position.set(20, 15, 20);
  scene.add(fill);

  cuboid(scene, [floorWidth, 0.24, floorDepth], [centerX, -0.15, centerZ], surfaces.floor, false);
  for (let x = bounds.minX + 5; x < bounds.maxX; x += 5) {
    cuboid(scene, [0.018, 0.004, floorDepth], [x, -0.025, centerZ], surfaces.seam, false);
  }
  for (let z = bounds.minZ + 5; z < bounds.maxZ; z += 5) {
    cuboid(scene, [floorWidth, 0.004, 0.018], [centerX, -0.025, z], surfaces.seam, false);
  }
  // A low enclosure keeps every bay readable from the management view.
  cuboid(scene, [floorWidth, 0.65, 0.35], [centerX, 0.3, bounds.maxZ], surfaces.wall);
  cuboid(scene, [0.35, 0.65, floorDepth], [bounds.minX, 0.3, centerZ], surfaces.wall);
  cuboid(scene, [0.35, 0.65, floorDepth], [bounds.maxX, 0.3, centerZ], surfaces.wall);
  for (let x = bounds.minX + 2; x < bounds.maxX; x += 8) {
    cuboid(scene, [0.14, 6.6, 0.14], [x, 3.3, bounds.maxZ - 0.15], surfaces.upperWall);
    cuboid(scene, [7.9, 0.09, 0.12], [x + 4, 6.6, bounds.maxZ - 0.15], surfaces.upperWall);
  }
  cuboid(scene, [floorWidth - 4, 0.016, 0.12], [centerX, -0.014, -2.65], surfaces.stripe, false);
  cuboid(scene, [floorWidth - 4, 0.016, 0.12], [centerX, -0.014, 3.5], surfaces.stripe, false);
  sign(scene, 'TRANSFER AISLE', 8, 1.1, [centerX + 27, -0.001, 0.4], {
    floor: true, background: '#b9c7ce', color: '#647d8b',
  });

  layout.racks.forEach((rack, rackIndex) => {
    const frontZ = rack.z - rack.depth / 2;
    const rearZ = rack.z + rack.depth / 2;
    const top = Math.max(...rack.shelfHeights) + 1.85;
    const bayWidth = rack.width / 5;
    for (let channel = 0; channel <= 5; channel += 1) {
      const x = rack.x - rack.width / 2 + channel * bayWidth;
      for (const z of [frontZ, rearZ]) {
        cuboid(scene, [0.12, top, 0.14], [x, top / 2, z], surfaces.blue);
        cuboid(scene, [0.3, 0.045, 0.32], [x, 0.02, z], surfaces.dark);
        // Small upright slots read as perforated steel at close range.
        for (let y = 0.45; y < top; y += 0.36) {
          cuboid(scene, [0.035, 0.08, 0.006], [x, y, z - 0.074], surfaces.dark, false);
        }
      }
      for (let level = 0; level < rack.shelfHeights.length - 1; level += 1) {
        const bottom = rack.shelfHeights[level];
        const height = rack.shelfHeights[level + 1] - bottom;
        const brace = cuboid(scene, [0.055, Math.hypot(height, rack.depth), 0.055], [x, bottom + height / 2, rack.z], surfaces.steel);
        brace.rotation.x = (level % 2 ? -1 : 1) * Math.atan2(rack.depth, height);
      }
    }
    rack.shelfHeights.forEach((y, shelf) => {
      for (const z of [frontZ, rearZ]) {
        cuboid(scene, [rack.width, 0.19, 0.13], [rack.x, y - 0.095, z], surfaces.orange);
      }
      rack.slotCenters.forEach((x, slot) => {
        for (const localX of [-bayWidth * 0.28, 0, bayWidth * 0.28]) {
          cuboid(scene, [0.065, 0.06, rack.depth], [x + localX, y - 0.03, rack.z], surfaces.steel);
        }
        sign(scene, `${shelf + 1} · ${String(slot + 1).padStart(2, '0')}`, 0.63, 0.14, [x, y - 0.1, frontZ - 0.071], { background: '#f1f0e8', color: '#23455c' });
      });
    });
    sign(scene, `R${String(rackIndex + 1).padStart(2, '0')}`, 3.3, 0.72, [rack.x, top - 0.28, frontZ - 0.09]);
    // Two small bollards protect the end frames without blocking bay access.
    for (const x of [rack.x - rack.width / 2, rack.x + rack.width / 2]) {
      cuboid(scene, [0.28, 0.7, 0.28], [x, 0.35, frontZ - 0.2], surfaces.yellow);
      cuboid(scene, [0.29, 0.13, 0.29], [x, 0.45, frontZ - 0.2], surfaces.dark);
    }
  });

  layout.floorPositions.forEach((position, index) => {
    const w = 1.55;
    for (const x of [-w / 2, w / 2]) cuboid(scene, [0.045, 0.012, 1.55], [position.x + x, -0.012, position.z], surfaces.stripe, false);
    for (const z of [-0.775, 0.775]) cuboid(scene, [w, 0.012, 0.045], [position.x, -0.012, position.z + z], surfaces.stripe, false);
    sign(scene, String(index + 1).padStart(2, '0'), 0.66, 0.42, [position.x, -0.001, position.z - 1.15], { floor: true, background: '#bdcbd2', color: '#657e8c' });
  });
  sign(scene, 'STAGING / DISPATCH', 10.5, 0.9, [centerX, -0.001, -14.2], { floor: true, background: '#bdcbd2', color: '#657e8c' });

  const boxes = new Map();
  simulation.getState().boxes.forEach((box, index) => {
    const group = new THREE.Group();
    group.name = box.id;
    // Fork pockets run along Z. The group origin is the pallet underside.
    for (const x of [-0.49, 0, 0.49]) cuboid(group, [0.17, 0.075, 1.1], [x, 0.0375, 0], surfaces.wood);
    for (let slat = 0; slat < 6; slat += 1) cuboid(group, [1.2, 0.055, 0.155], [0, 0.1425, -0.47 + slat * 0.188], surfaces.woodLight);
    for (const x of [-0.49, 0, 0.49]) {
      for (const z of [-0.44, 0.44]) cuboid(group, [0.17, 0.04, 0.13], [x, 0.095, z], surfaces.wood);
    }
    cuboid(group, [1.04, 1.01, 0.98], [0, 0.675, 0], surfaces.carton);
    cuboid(group, [0.095, 0.012, 0.99], [0, 1.186, 0], surfaces.tape, false);
    for (const z of [-0.496, 0.496]) cuboid(group, [0.095, 1.01, 0.006], [0, 0.675, z], surfaces.tape, false);
    sign(group, `BOX ${String(index + 1).padStart(2, '0')}`, 0.68, 0.3, [0, 0.76, -0.497], { background: '#eee8d8', color: '#3b4548' });
    const rearLabel = sign(group, `BOX ${String(index + 1).padStart(2, '0')}`, 0.68, 0.3, [0, 0.76, 0.497], { background: '#eee8d8', color: '#3b4548' });
    rearLabel.rotation.y = 0;
    scene.add(group);
    boxes.set(box.id, group);
  });

  const forklift = new THREE.Group();
  forklift.name = 'simulation-forklift';
  scene.add(forklift);
  cuboid(forklift, [1.36, 0.48, 1.62], [0, 0.6, -0.15], surfaces.yellow);
  cuboid(forklift, [1.3, 0.24, 0.5], [0, 0.94, -0.72], surfaces.yellow);
  cuboid(forklift, [1.36, 0.12, 1.65], [0, 0.31, -0.15], surfaces.dark);
  cuboid(forklift, [0.6, 0.18, 0.58], [0, 1.03, -0.25], surfaces.seat);
  const seatBack = cuboid(forklift, [0.6, 0.65, 0.13], [0, 1.4, -0.52], surfaces.seat);
  seatBack.rotation.x = -0.12;
  cuboid(forklift, [0.85, 0.22, 0.25], [0, 1.13, 0.36], surfaces.dark);
  const steering = new THREE.Mesh(geometry('cylinder', 0.19, 0.19, 0.05, 18), surfaces.dark);
  steering.position.set(-0.24, 1.43, 0.3);
  steering.rotation.x = 0.55;
  forklift.add(steering);
  for (const x of [-0.59, 0.59]) {
    for (const z of [-0.77, 0.44]) cuboid(forklift, [0.075, 1.62, 0.075], [x, 1.68, z], surfaces.dark);
  }
  cuboid(forklift, [1.42, 0.12, 1.5], [0, 2.52, -0.14], surfaces.yellow);
  for (const x of [-0.45, -0.15, 0.15, 0.45]) cuboid(forklift, [0.065, 0.06, 1.35], [x, 2.6, -0.14], surfaces.dark);
  cuboid(forklift, [0.12, 0.2, 0.12], [0.42, 2.68, -0.45], surfaces.orange);
  for (const x of [-0.51, 0.51]) cuboid(forklift, [0.2, 0.14, 0.04], [x, 0.78, -1.005], surfaces.light);
  sign(forklift, '01', 0.5, 0.24, [0, 0.67, -0.966]);

  const wheels = [];
  for (const x of [-0.73, 0.73]) {
    for (const z of [-0.67, 0.52]) {
      const wheel = new THREE.Group();
      wheel.position.set(x, 0.36, z);
      const tire = new THREE.Mesh(geometry('cylinder', 0.36, 0.36, 0.24, 20), surfaces.tire);
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      wheel.add(tire);
      const hub = new THREE.Mesh(geometry('cylinder', 0.19, 0.19, 0.255, 16), surfaces.rim);
      hub.rotation.z = Math.PI / 2;
      wheel.add(hub);
      // An asymmetric hub spoke makes driven wheel rotation visible.
      cuboid(wheel, [0.26, 0.052, 0.3], [0, 0, 0], surfaces.dark);
      forklift.add(wheel);
      wheels.push(wheel);
    }
  }
  for (const x of [-0.48, 0.48]) cuboid(forklift, [0.13, 3.08, 0.17], [x, 1.58, 0.81], surfaces.dark);
  cuboid(forklift, [1.08, 0.13, 0.17], [0, 3.05, 0.81], surfaces.dark);
  const carriage = new THREE.Group();
  forklift.add(carriage);
  for (const x of [-0.42, 0, 0.42]) cuboid(carriage, [0.06, 0.96, 0.07], [x, 0.58, 0.93], surfaces.dark);
  for (const y of [0.18, 0.65, 1.04]) cuboid(carriage, [1.03, 0.06, 0.07], [0, y, 0.93], surfaces.dark);
  for (const x of [-0.34, 0.34]) {
    cuboid(carriage, [0.13, 0.05, 1.25], [x, 0.09, 1.525], surfaces.steel);
    cuboid(carriage, [0.13, 0.44, 0.08], [x, 0.28, 0.94], surfaces.steel);
  }
  const piston = cuboid(forklift, [0.06, 1, 0.06], [0, 1, 0.81], surfaces.rim);

  // Static rack details share a few GPU draws. Movable box/forklift groups and
  // their engine-owned transforms remain individual scene objects.
  const batches = new Map();
  for (const mesh of [...scene.children]) {
    if (!mesh.isMesh || !mesh.material.isMeshStandardMaterial) continue;
    const key = `${mesh.geometry.uuid}:${mesh.material.uuid}:${mesh.castShadow}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(mesh);
  }
  for (const meshes of batches.values()) {
    if (meshes.length < 2) continue;
    const batch = new THREE.InstancedMesh(meshes[0].geometry, meshes[0].material, meshes.length);
    instances.add(batch);
    batch.castShadow = meshes[0].castShadow;
    batch.receiveShadow = true;
    meshes.forEach((mesh, index) => {
      mesh.updateMatrix();
      batch.setMatrixAt(index, mesh.matrix);
      scene.remove(mesh);
    });
    batch.computeBoundingSphere();
    scene.add(batch);
  }

  const initialDistance = Math.max(floorWidth * 0.8, floorDepth * 1.5);
  camera.position.set(centerX + initialDistance * 0.24, initialDistance * 0.57, centerZ - initialDistance * 0.82);
  controls = new OrbitControls(camera, canvas);
  controls.target.set(centerX, 1.8, 4);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.maxPolarAngle = Math.PI / 2 - 0.015;
  controls.minDistance = 2;
  controls.maxDistance = 150;
  controls.update();

  let view = 'orbit';
  let orbitSnapshot = null;
  let walkingPosition = new THREE.Vector3(centerX - 15, 1.72, -4);
  let lookYaw = Math.PI;
  let lookPitch = 0;
  let dragging = false;
  let lookPointer = null;
  const keys = new Set();
  const walkDirection = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let wheelAngle = 0;
  let lastForkliftPosition = null;

  function setView(next) {
    if (view === next) return;
    keys.clear();
    dragging = false;
    if (next === 'first-person') {
      orbitSnapshot = { position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom };
      controls.enabled = false;
      camera.position.copy(walkingPosition);
      camera.rotation.set(lookPitch, lookYaw, 0, 'YXZ');
    } else {
      walkingPosition.copy(camera.position);
      lookYaw = camera.rotation.y;
      lookPitch = camera.rotation.x;
      // Clear any residual orbit damping before restoring the saved view.
      // Otherwise a last drag just before switching could nudge the snapshot.
      controls.enableDamping = false;
      controls.update();
      camera.position.copy(orbitSnapshot.position);
      camera.zoom = orbitSnapshot.zoom;
      controls.target.copy(orbitSnapshot.target);
      controls.enabled = true;
      controls.update();
      controls.enableDamping = true;
      camera.updateProjectionMatrix();
    }
    view = next;
    canvas.dataset.view = view;
    orbitButton.setAttribute('aria-pressed', String(view === 'orbit'));
    firstPersonButton.setAttribute('aria-pressed', String(view === 'first-person'));
  }

  orbitButton.addEventListener('click', () => setView('orbit'), eventOptions);
  firstPersonButton.addEventListener('click', () => setView('first-person'), eventOptions);
  const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      started = false;
      exited = true;
      keys.clear();
      tellParent('warehouse-simulation-exit');
    } else if (view === 'first-person' && movementKeys.has(event.code)) {
      event.preventDefault();
      keys.add(event.code);
    }
  }, eventOptions);
  window.addEventListener('keyup', (event) => keys.delete(event.code), eventOptions);
  window.addEventListener('blur', () => { keys.clear(); dragging = false; }, eventOptions);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault(), eventOptions);
  canvas.addEventListener('pointerdown', (event) => {
    if (view !== 'first-person' || event.button !== 0) return;
    dragging = true;
    lookPointer = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
  }, eventOptions);
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging || view !== 'first-person' || event.pointerId !== lookPointer) return;
    lookYaw -= event.movementX * 0.003;
    lookPitch = THREE.MathUtils.clamp(lookPitch - event.movementY * 0.003, -1.35, 1.35);
    camera.rotation.set(lookPitch, lookYaw, 0, 'YXZ');
  }, eventOptions);
  const endDrag = () => { dragging = false; lookPointer = null; };
  canvas.addEventListener('pointerup', endDrag, eventOptions);
  canvas.addEventListener('pointercancel', endDrag, eventOptions);
  canvas.addEventListener('lostpointercapture', endDrag, eventOptions);
  document.addEventListener('visibilitychange', () => { previousTime = null; keys.clear(); dragging = false; }, eventOptions);
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    if (event.data?.type !== 'warehouse-simulation-start' || started || exited) return;
    started = true;
    previousTime = null;
  }, eventOptions);
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    fail(new Error('The 3D graphics context was lost. Please start the simulation again.'));
  }, eventOptions);

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize, eventOptions);
  resize();

  function applyState(state) {
    const position = state.forklift.position;
    if (lastForkliftPosition) {
      const dx = position.x - lastForkliftPosition.x;
      const dz = position.z - lastForkliftPosition.z;
      const distance = Math.hypot(dx, dz);
      const forward = Math.sign(dx * Math.sin(state.forklift.yaw) + dz * Math.cos(state.forklift.yaw));
      wheelAngle += distance * forward / 0.36;
    }
    lastForkliftPosition = { x: position.x, z: position.z };
    forklift.position.set(position.x, position.y, position.z);
    forklift.rotation.y = state.forklift.yaw;
    carriage.position.y = state.forklift.liftHeight;
    piston.scale.y = Math.max(0.4, state.forklift.liftHeight + 0.55);
    piston.position.y = 0.45 + piston.scale.y / 2;
    wheels.forEach((wheel) => { wheel.rotation.x = wheelAngle; });
    state.boxes.forEach((box) => {
      const object = boxes.get(box.id);
      if (!object) throw new Error('The simulation returned an unknown box.');
      object.position.set(box.position.x, box.position.y, box.position.z);
      object.rotation.y = box.rotationY;
    });
  }

  function moveCamera(delta) {
    const forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
    const sideways = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    if (!forward && !sideways) return;
    walkDirection.set(sideways, 0, -forward).normalize().applyAxisAngle(up, lookYaw).multiplyScalar(delta * 5);
    const nextX = THREE.MathUtils.clamp(camera.position.x + walkDirection.x, bounds.minX + 0.5, bounds.maxX - 0.5);
    const nextZ = THREE.MathUtils.clamp(camera.position.z + walkDirection.z, bounds.minZ + 0.5, bounds.maxZ - 0.5);
    const obstructed = layout.racks.some((rack) => Math.abs(nextX - rack.x) < rack.width / 2 + 0.35 && Math.abs(nextZ - rack.z) < rack.depth / 2 + 0.35);
    if (!obstructed) camera.position.set(nextX, 1.72, nextZ);
  }

  applyState(simulation.getState());
  renderer.render(scene, camera);
  tellParent('warehouse-simulation-ready');
  function animate(time) {
    if (stopped) return;
    try {
      const delta = previousTime === null || document.hidden ? 0 : Math.min(0.1, Math.max(0, (time - previousTime) / 1000));
      previousTime = document.hidden ? null : time;
      if (started && delta > 0) applyState(simulation.step(delta));
      if (view === 'orbit') controls.update();
      else if (!document.hidden) moveCamera(delta);
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    } catch (error) { fail(error); }
  }
  frame = requestAnimationFrame(animate);
}

try { initialize(); } catch (error) { fail(error); }
