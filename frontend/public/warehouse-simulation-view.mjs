import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSimulation } from './warehouse-simulation-engine.mjs';
import { createWarehouseScene } from './warehouse-simulation-scene.mjs';
import { createSimulationAudio } from './warehouse-simulation-audio.mjs';

// The host owns fullscreen/live-state restoration; this frame owns only the
// isolated engine, local graphics, camera and input lifecycle.
const canvas = document.querySelector('#warehouse');
const orbitButton = document.querySelector('#orbit-view');
const firstPersonButton = document.querySelector('#first-person-view');
const uiButton = document.querySelector('#toggle-ui');
const help = document.querySelector('#controls-help');
const abort = new AbortController();
const eventOptions = { signal: abort.signal };
let renderer, controls, simulation, warehouse, audio;
let frame = 0, stopped = false, started = false, exited = false;
let previousTime = null;
let helpTimeout = 0, uiHidden = false;
let audioHintShown = false;
const tellParent = (type, extra = {}) => window.parent.postMessage({ type, ...extra }, window.location.origin);

function showHelp(message) {
  if (stopped) return;
  clearTimeout(helpTimeout);
  help.textContent = message;
  help.hidden = uiHidden;
  helpTimeout = window.setTimeout(() => { help.hidden = true; }, 6000);
}
function toggleUI() {
  uiHidden = !uiHidden;
  document.body.dataset.uiHidden = String(uiHidden);
  if (uiHidden) help.hidden = true;
}
function enableAudio() {
  if (!started || stopped) return;
  // Call synchronously from the gesture; decoding can finish asynchronously.
  audio?.resume().then(enabled => {
    if (!enabled && !stopped && !audioHintShown) {
      audioHintShown = true;
      showHelp('Sound is unavailable or blocked by the browser. Click the scene to retry · H hide UI · ? controls · Esc exit');
    }
  });
}
function cleanup() {
  if (stopped) return;
  stopped = true;
  cancelAnimationFrame(frame);
  clearTimeout(helpTimeout);
  abort.abort();
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  controls?.dispose();
  audio?.dispose();
  simulation?.dispose();
  warehouse?.dispose();
  renderer?.dispose();
}
function exitSimulation() {
  if (exited || stopped) return;
  exited = true;
  started = false;
  tellParent('warehouse-simulation-exit');
  cleanup();
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
  exitSimulation();
}, eventOptions);
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return;
  if (event.data?.type !== 'warehouse-simulation-start' || started || exited || stopped) return;
  started = true;
  previousTime = null;
  enableAudio();
}, eventOptions);
window.addEventListener('pointerdown', enableAudio, eventOptions);
window.addEventListener('keydown', event => { if (!event.repeat) enableAudio(); }, eventOptions);

async function initialize() {
  simulation = createSimulation();
  audio = createSimulationAudio({ signal: abort.signal });
  let state = simulation.getState();
  const { layout } = simulation;
  const bounds = layout.floorBounds;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  warehouse = createWarehouseScene(renderer, layout, state, abort.signal);
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
  canvas.dataset.view = view;
  const walkingPosition = new THREE.Vector3(-17, 1.72, -27);
  let lookYaw = -2.2, lookPitch = 0;
  let lookPointer = null, touchX = 0, touchY = 0;
  let hadPointerLock = false, expectedUnlock = false, requestingLock = false, focusLost = false;
  const keys = new Set();
  const walkDirection = new THREE.Vector3();
  const forwardDirection = new THREE.Vector3();
  const rightDirection = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const modeHelp = () => view === 'orbit'
    ? 'Orbit: drag to rotate · scroll to zoom · WASD / arrows to fly · Space up · Shift down · F first person · H hide UI · ? help · Esc exit'
    : 'First person: move mouse to look · WASD / arrows to walk · touch: drag to look · F orbit · H hide UI · ? help · Esc exit';
  function pointerLockRefused() {
    requestingLock = false;
    if (view === 'first-person') showHelp('Mouse look needs browser permission. Click the scene to try again · F orbit · H hide UI · Esc exit. Touch: drag to look.');
  }
  function requestMouseLook() {
    if (stopped || view !== 'first-person' || document.pointerLockElement === canvas || requestingLock) return;
    if (!canvas.requestPointerLock) { pointerLockRefused(); return; }
    requestingLock = true;
    try {
      // Keep this synchronous in the click/key handler so transient user
      // activation is still available to the browser.
      const request = canvas.requestPointerLock();
      request?.catch(pointerLockRefused);
    } catch { pointerLockRefused(); }
  }
  function releaseMouseLook() {
    if (document.pointerLockElement !== canvas) return;
    expectedUnlock = true;
    document.exitPointerLock();
  }
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    requestingLock = false;
    if (locked) {
      hadPointerLock = true;
      expectedUnlock = false;
      if (view !== 'first-person') releaseMouseLook();
      return;
    }
    const wasLocked = hadPointerLock;
    hadPointerLock = false;
    if (expectedUnlock) { expectedUnlock = false; return; }
    if (!wasLocked || view !== 'first-person') return;
    keys.clear();
    // Browsers often consume Escape before dispatching keydown. An unasked
    // unlock while this frame is focused is the equivalent exit signal.
    if (!focusLost && !document.hidden && document.hasFocus()) exitSimulation();
    else showHelp('Click the scene to resume mouse look · F orbit · H hide UI · Esc exit');
  }, eventOptions);
  document.addEventListener('pointerlockerror', pointerLockRefused, eventOptions);

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
    keys.clear(); lookPointer = null;
    if (next === 'first-person') {
      orbitSnapshot = { position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom };
      controls.enabled = false;
      camera.position.copy(walkingPosition);
      camera.rotation.set(lookPitch, lookYaw, 0, 'YXZ');
    } else {
      releaseMouseLook();
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
    showHelp(modeHelp());
  }
  orbitButton.addEventListener('click', () => setView('orbit'), eventOptions);
  firstPersonButton.addEventListener('click', event => {
    setView('first-person');
    if (event.pointerType !== 'touch') requestMouseLook();
  }, eventOptions);
  uiButton.addEventListener('click', toggleUI, eventOptions);
  const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight']);
  window.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (movementKeys.has(event.code)) { event.preventDefault(); keys.add(event.code); }
    if (event.repeat) return;
    if (event.code === 'KeyF') {
      event.preventDefault();
      setView(view === 'orbit' ? 'first-person' : 'orbit');
      if (view === 'first-person') requestMouseLook();
    } else if (event.code === 'KeyH') {
      event.preventDefault(); toggleUI();
    } else if (event.key === '?') {
      event.preventDefault(); showHelp(modeHelp());
    }
  }, eventOptions);
  window.addEventListener('keyup', event => keys.delete(event.code), eventOptions);
  window.addEventListener('blur', () => { keys.clear(); lookPointer = null; focusLost = true; }, eventOptions);
  window.addEventListener('focus', () => { focusLost = false; }, eventOptions);
  canvas.addEventListener('contextmenu', event => event.preventDefault(), eventOptions);
  canvas.addEventListener('pointerdown', event => {
    if (view !== 'first-person' || event.button !== 0) return;
    if (event.pointerType !== 'touch') { requestMouseLook(); return; }
    lookPointer = event.pointerId; touchX = event.clientX; touchY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  }, eventOptions);
  function lookAround(dx, dy) {
    lookYaw -= dx * 0.003;
    lookPitch = THREE.MathUtils.clamp(lookPitch - dy * 0.003, -1.35, 1.35);
    camera.rotation.set(lookPitch, lookYaw, 0, 'YXZ');
  }
  document.addEventListener('mousemove', event => {
    if (view === 'first-person' && document.pointerLockElement === canvas) lookAround(event.movementX, event.movementY);
  }, eventOptions);
  canvas.addEventListener('pointermove', event => {
    if (view !== 'first-person' || event.pointerType !== 'touch' || event.pointerId !== lookPointer) return;
    lookAround(event.clientX - touchX, event.clientY - touchY);
    touchX = event.clientX; touchY = event.clientY;
  }, eventOptions);
  const endDrag = () => { lookPointer = null; };
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, endDrag, eventOptions);
  document.addEventListener('visibilitychange', () => {
    previousTime = null; keys.clear(); lookPointer = null;
    void audio.setPaused(document.hidden);
  }, eventOptions);
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
    if (view === 'orbit') {
      const vertical = Number(keys.has('Space')) - Number(keys.has('ShiftLeft') || keys.has('ShiftRight'));
      if (!forward && !sideways && !vertical) return;
      camera.getWorldDirection(forwardDirection);
      forwardDirection.y = 0;
      forwardDirection.normalize();
      rightDirection.crossVectors(forwardDirection, up);
      walkDirection.copy(forwardDirection).multiplyScalar(forward).addScaledVector(rightDirection, sideways);
      walkDirection.y = vertical;
      walkDirection.normalize().multiplyScalar(delta * 5);
      // Clamp the shared displacement, preserving the camera-target offset
      // even when either endpoint reaches a wall, floor or roof.
      for (const [axis, min, max] of [['x', bounds.minX + 0.5, bounds.maxX - 0.5], ['z', bounds.minZ + 0.5, bounds.maxZ - 0.5]]) {
        walkDirection[axis] = THREE.MathUtils.clamp(walkDirection[axis], Math.max(min - camera.position[axis], min - controls.target[axis]), Math.min(max - camera.position[axis], max - controls.target[axis]));
      }
      walkDirection.y = THREE.MathUtils.clamp(walkDirection.y, Math.max(0.6 - camera.position.y, 0.6 - controls.target.y), Math.min(warehouse.roofHeight(camera.position.x + walkDirection.x) - 0.5 - camera.position.y, 10.6 - controls.target.y));
      camera.position.add(walkDirection);
      controls.target.add(walkDirection);
      return;
    }
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
  warehouse.update(state);
  renderer.render(warehouse.scene, camera);
  // Some browsers leave resume() pending instead of rejecting autoplay. Give
  // the gesture hint on entry without waiting for that promise to settle.
  showHelp(`${modeHelp()} · Click the scene if sound is muted`);
  tellParent('warehouse-simulation-ready');
  function animate(time) {
    if (stopped) return;
    try {
      const delta = previousTime === null || document.hidden ? 0 : Math.max(0, (time - previousTime) / 1000);
      previousTime = document.hidden ? null : time;
      if (started && delta > 0) {
        state = simulation.step(delta);
        warehouse.update(state);
      }
      if (view === 'orbit') controls.update();
      if (!document.hidden) moveCamera(Math.min(0.1, delta));
      if (view === 'orbit') constrainOrbit();
      if (started) audio.update(state, camera);
      renderer.render(warehouse.scene, camera);
      frame = requestAnimationFrame(animate);
    } catch (error) { fail(error); }
  }
  frame = requestAnimationFrame(animate);
}
initialize().catch(fail);
