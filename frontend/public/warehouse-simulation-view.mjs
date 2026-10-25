import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSimulation } from './warehouse-simulation-engine.mjs';
import { createWarehouseScene } from './warehouse-simulation-scene.mjs';

// The host owns fullscreen/live-state restoration; this frame owns only the
// isolated engine, local graphics, camera and input lifecycle.
const canvas = document.querySelector('#warehouse');
const orbitButton = document.querySelector('#orbit-view');
const firstPersonButton = document.querySelector('#first-person-view');
const abort = new AbortController();
const eventOptions = { signal: abort.signal };
let renderer, controls, simulation, warehouse;
let frame = 0, stopped = false, started = false, exited = false;
let previousTime = null;
const tellParent = (type, extra = {}) => window.parent.postMessage({ type, ...extra }, window.location.origin);

function cleanup() {
  if (stopped) return;
  stopped = true;
  cancelAnimationFrame(frame);
  abort.abort();
  controls?.dispose();
  simulation?.dispose();
  warehouse?.dispose();
  renderer?.dispose();
}
function fail(error) {
  if (stopped) return;
  tellParent('warehouse-simulation-error', { message: error?.message || 'The warehouse simulation could not render.' });
  cleanup();
}
window.addEventListener('pagehide', cleanup, eventOptions);
window.addEventListener('error', event => fail(event.error || new Error(event.message)), eventOptions);
window.addEventListener('unhandledrejection', event => fail(event.reason), eventOptions);
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  exited = true;
  started = false;
  tellParent('warehouse-simulation-exit');
  cleanup();
}, eventOptions);
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return;
  if (event.data?.type !== 'warehouse-simulation-start' || started || exited || stopped) return;
  started = true;
  previousTime = null;
}, eventOptions);

async function initialize() {
  simulation = createSimulation();
  const { layout } = simulation;
  const bounds = layout.floorBounds;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  warehouse = createWarehouseScene(renderer, layout, simulation.getState(), abort.signal);
  const camera = new THREE.PerspectiveCamera(68, 1, 0.08, 170);
  // Start on the indoor pedestrian side, below the roof and beside the rows.
  camera.position.set(-18, 10, -34);
  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1, -16);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.minDistance = 1.2;
  controls.maxDistance = 65;
  controls.minPolarAngle = 0.05;
  controls.maxPolarAngle = Math.PI - 0.05;
  controls.update();

  let view = 'orbit', orbitSnapshot = null;
  const walkingPosition = new THREE.Vector3(-17, 1.72, -27);
  let lookYaw = -2.2, lookPitch = 0;
  let dragging = false, lookPointer = null;
  const keys = new Set();
  const walkDirection = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  function constrainOrbit() {
    const position = camera.position;
    position.x = THREE.MathUtils.clamp(position.x, bounds.minX + 0.5, bounds.maxX - 0.5);
    position.z = THREE.MathUtils.clamp(position.z, bounds.minZ + 0.5, bounds.maxZ - 0.5);
    position.y = THREE.MathUtils.clamp(position.y, 0.6, warehouse.roofHeight(position.x) - 0.5);
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, bounds.minX + 0.5, bounds.maxX - 0.5);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, bounds.minZ + 0.5, bounds.maxZ - 0.5);
    controls.target.y = THREE.MathUtils.clamp(controls.target.y, 0.6, 10.6);
    camera.lookAt(controls.target);
  }
  function setView(next) {
    if (view === next) return;
    keys.clear(); dragging = false;
    if (next === 'first-person') {
      orbitSnapshot = { position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom };
      controls.enabled = false;
      camera.position.copy(walkingPosition);
      camera.rotation.set(lookPitch, lookYaw, 0, 'YXZ');
    } else {
      walkingPosition.copy(camera.position);
      lookYaw = camera.rotation.y; lookPitch = camera.rotation.x;
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
  window.addEventListener('keydown', event => {
    if (view === 'first-person' && movementKeys.has(event.code)) { event.preventDefault(); keys.add(event.code); }
  }, eventOptions);
  window.addEventListener('keyup', event => keys.delete(event.code), eventOptions);
  window.addEventListener('blur', () => { keys.clear(); dragging = false; }, eventOptions);
  canvas.addEventListener('contextmenu', event => event.preventDefault(), eventOptions);
  canvas.addEventListener('pointerdown', event => {
    if (view !== 'first-person' || event.button !== 0) return;
    dragging = true; lookPointer = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
  }, eventOptions);
  canvas.addEventListener('pointermove', event => {
    if (!dragging || view !== 'first-person' || event.pointerId !== lookPointer) return;
    lookYaw -= event.movementX * 0.003;
    lookPitch = THREE.MathUtils.clamp(lookPitch - event.movementY * 0.003, -1.35, 1.35);
    camera.rotation.set(lookPitch, lookYaw, 0, 'YXZ');
  }, eventOptions);
  const endDrag = () => { dragging = false; lookPointer = null; };
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, endDrag, eventOptions);
  document.addEventListener('visibilitychange', () => { previousTime = null; keys.clear(); dragging = false; }, eventOptions);
  canvas.addEventListener('webglcontextlost', event => {
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
  function moveCamera(delta) {
    const forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
    const sideways = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    if (!forward && !sideways) return;
    walkDirection.set(sideways, 0, -forward).normalize().applyAxisAngle(up, lookYaw).multiplyScalar(delta * 5);
    const nextX = THREE.MathUtils.clamp(camera.position.x + walkDirection.x, bounds.minX + 0.5, bounds.maxX - 0.5);
    const nextZ = THREE.MathUtils.clamp(camera.position.z + walkDirection.z, bounds.minZ + 0.5, bounds.maxZ - 0.5);
    const blocked = (x, z) => layout.racks.some(rack => Math.abs(x - rack.x) < rack.width / 2 + 0.6 && Math.abs(z - rack.z) < rack.depth / 2 + 0.6);
    if (!blocked(nextX, camera.position.z)) camera.position.x = nextX;
    if (!blocked(camera.position.x, nextZ)) camera.position.z = nextZ;
    camera.position.y = 1.72;
  }

  await warehouse.ready;
  if (stopped || exited) return;
  constrainOrbit();
  warehouse.update(simulation.getState());
  renderer.render(warehouse.scene, camera);
  tellParent('warehouse-simulation-ready');
  function animate(time) {
    if (stopped) return;
    try {
      const delta = previousTime === null || document.hidden ? 0 : Math.max(0, (time - previousTime) / 1000);
      previousTime = document.hidden ? null : time;
      if (started && delta > 0) warehouse.update(simulation.step(delta));
      if (view === 'orbit') { controls.update(); constrainOrbit(); }
      else if (!document.hidden) moveCamera(Math.min(0.1, delta));
      renderer.render(warehouse.scene, camera);
      frame = requestAnimationFrame(animate);
    } catch (error) { fail(error); }
  }
  frame = requestAnimationFrame(animate);
}
initialize().catch(fail);
