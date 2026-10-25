// Audio is owned by the isolated simulation frame. No application state or
// storage is read here, and a failed/blocked audio device cannot stop the view.
const assetNames = ['engine-start', 'engine-idle', 'engine-stop', 'reverse', 'hydraulics', 'gate-open', 'gate-close'];
const volumes = { 'engine-start': 0.55, 'engine-idle': 0.42, 'engine-stop': 0.55, reverse: 0.55, hydraulics: 0.42, 'gate-open': 0.6, 'gate-close': 0.65 };

export function createSimulationAudio({ signal, layout } = {}) {
  const loading = new AbortController();
  const vehicles = new Map();
  const shutters = new Map();
  const gateMotion = new Map();
  let context = null, master = null, compressor = null, buffers = null;
  let decoding = null, disposed = false, paused = false;
  let lastState = null, lastCamera = null;
  const ready = Promise.all(assetNames.map(async name => {
    const response = await fetch(new URL(`./audio/warehouse/${name}.wav`, import.meta.url), { signal: loading.signal });
    if (!response.ok) throw new Error(`Unable to load simulation audio: ${name}`);
    return [name, await response.arrayBuffer()];
  })).then(entries => disposed ? null : new Map(entries)).catch(() => null);

  const value = (parameter, next) => parameter?.setValueAtTime(next, context.currentTime);
  function disconnect(node) { try { node?.disconnect(); } catch { /* Already released. */ } }
  function stopSound(vehicle, name) {
    const sound = vehicle.sounds.get(name);
    if (!sound) return;
    vehicle.sounds.delete(name);
    sound.source.onended = null;
    // Stop scheduled sources too, including an idle loop waiting for startup.
    try { sound.source.stop(); } catch { /* May have ended naturally. */ }
    disconnect(sound.source);
    disconnect(sound.gain);
  }
  function releaseEmitter(vehicle) {
    for (const name of [...vehicle.sounds.keys()]) stopSound(vehicle, name);
    disconnect(vehicle.panner);
  }
  function sound(vehicle, name, { loop = false, at = context.currentTime, fadeIn = 0 } = {}) {
    if (vehicle.sounds.has(name)) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffers.get(name);
    source.loop = loop;
    gain.gain.setValueAtTime(fadeIn ? 0 : volumes[name], at);
    if (fadeIn) gain.gain.linearRampToValueAtTime(volumes[name], at + fadeIn);
    source.connect(gain);
    gain.connect(vehicle.panner);
    const playback = { source, gain };
    vehicle.sounds.set(name, playback);
    source.onended = () => {
      if (vehicle.sounds.get(name) === playback) vehicle.sounds.delete(name);
      disconnect(source); disconnect(gain);
    };
    source.start(at);
    return playback;
  }
  function createEmitter() {
    const panner = context.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 3;
    panner.maxDistance = 75;
    panner.rolloffFactor = 1.35;
    // Each truck and shutter has its own source position and radiates in every
    // direction, independent of the selected or nearest object.
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 360;
    panner.connect(master);
    return { panner, running: false, sounds: new Map() };
  }
  function updateListener(camera) {
    if (!camera?.matrixWorld) return;
    camera.updateMatrixWorld?.();
    const m = camera.matrixWorld.elements;
    const listener = context.listener;
    if (listener.positionX) {
      value(listener.positionX, m[12]); value(listener.positionY, m[13]); value(listener.positionZ, m[14]);
      value(listener.forwardX, -m[8]); value(listener.forwardY, -m[9]); value(listener.forwardZ, -m[10]);
      value(listener.upX, m[4]); value(listener.upY, m[5]); value(listener.upZ, m[6]);
    } else {
      listener.setPosition(m[12], m[13], m[14]);
      listener.setOrientation(-m[8], -m[9], -m[10], m[4], m[5], m[6]);
    }
  }
  function sync() {
    if (disposed || paused || !buffers || context?.state !== 'running' || !lastState) return;
    updateListener(lastCamera);
    const seen = new Set();
    for (const truck of lastState.forklifts || []) {
      seen.add(truck.id);
      let vehicle = vehicles.get(truck.id);
      if (!vehicle) { vehicle = createEmitter(); vehicles.set(truck.id, vehicle); }
      const p = truck.position;
      const panner = vehicle.panner;
      if (panner.positionX) {
        value(panner.positionX, p.x); value(panner.positionY, p.y + 0.8); value(panner.positionZ, p.z);
        value(panner.orientationX, Math.sin(truck.yaw || 0)); value(panner.orientationY, 0); value(panner.orientationZ, Math.cos(truck.yaw || 0));
      } else {
        panner.setPosition(p.x, p.y + 0.8, p.z);
        panner.setOrientation(Math.sin(truck.yaw || 0), 0, Math.cos(truck.yaw || 0));
      }
      const running = Boolean(truck.engineRunning);
      if (running !== vehicle.running) {
        vehicle.running = running;
        if (running) {
          stopSound(vehicle, 'engine-stop');
          const start = sound(vehicle, 'engine-start');
          const crossfade = 0.08;
          const idleAt = context.currentTime + buffers.get('engine-start').duration - crossfade;
          start.gain.gain.setValueAtTime(volumes['engine-start'], idleAt);
          start.gain.gain.linearRampToValueAtTime(0, idleAt + crossfade);
          sound(vehicle, 'engine-idle', { loop: true, at: idleAt, fadeIn: crossfade });
        } else {
          stopSound(vehicle, 'engine-start'); stopSound(vehicle, 'engine-idle');
          // A truck disappearing inside its gate still gets one shutdown tail.
          sound(vehicle, 'engine-stop');
        }
      }
      const reverse = running && truck.visible !== false && truck.speed < -0.015;
      const lifting = running && truck.visible !== false && Math.abs(truck.liftVelocity || 0) > 0.005;
      if (reverse) sound(vehicle, 'reverse', { loop: true }); else stopSound(vehicle, 'reverse');
      if (lifting) sound(vehicle, 'hydraulics', { loop: true }); else stopSound(vehicle, 'hydraulics');
    }
    for (const [id, vehicle] of vehicles) {
      if (!seen.has(id)) { releaseEmitter(vehicle); vehicles.delete(id); }
    }
    for (const [id, location] of [['in', layout?.gateIn], ['out', layout?.gateOut]]) {
      const motion = gateMotion.get(id);
      if (!location || !motion) {
        const shutter = shutters.get(id);
        if (shutter) { releaseEmitter(shutter); shutters.delete(id); }
        continue;
      }
      let shutter = shutters.get(id);
      if (!shutter) { shutter = createEmitter(); shutters.set(id, shutter); }
      const panner = shutter.panner;
      if (panner.positionX) {
        value(panner.positionX, location.x); value(panner.positionY, location.y + 4.7); value(panner.positionZ, location.z);
      } else panner.setPosition(location.x, location.y + 4.7, location.z);
      const name = motion.direction > 0 ? 'gate-open' : motion.direction < 0 ? 'gate-close' : null;
      for (const effect of ['gate-open', 'gate-close']) {
        if (effect === name) sound(shutter, effect, { loop: true, fadeIn: 0.035 });
        else stopSound(shutter, effect);
      }
    }
  }
  function update(state, camera) {
    if (disposed) return;
    for (const id of ['in', 'out']) {
      const openness = state.gates?.[id];
      if (!Number.isFinite(openness)) { gateMotion.delete(id); continue; }
      const previous = gateMotion.get(id)?.openness;
      const delta = previous === undefined ? 0 : openness - previous;
      // Endpoints are already stationary. Calculate only on a new snapshot,
      // so resume/unlock can sync the graph without misreading a frozen frame.
      const direction = openness <= 0 || openness >= 1 || Math.abs(delta) < 1e-6 ? 0 : Math.sign(delta);
      gateMotion.set(id, { openness, direction });
    }
    lastState = state; lastCamera = camera;
    try { sync(); } catch { dispose(); }
  }
  async function resume() {
    if (disposed || paused) return false;
    try {
      if (!context) {
        const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AudioContext) return false;
        context = new AudioContext();
        master = context.createGain();
        master.gain.value = 0.8;
        compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -8;
        compressor.knee.value = 12;
        compressor.ratio.value = 5;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.15;
        master.connect(compressor); compressor.connect(context.destination);
      }
      // Invoke resume before the first await so the click/key activation is
      // available even while files are still loading/decoding.
      const unlocking = context.state === 'running' ? Promise.resolve() : context.resume();
      if (!decoding) decoding = ready.then(async bytes => {
        if (!bytes || disposed) return null;
        const decoded = await Promise.all([...bytes].map(async ([name, data]) => [name, await context.decodeAudioData(data.slice(0))]));
        return disposed ? null : new Map(decoded);
      }).catch(() => null);
      const [decoded] = await Promise.all([decoding, unlocking]);
      if (disposed || !decoded) { if (!disposed) dispose(); return false; }
      buffers = decoded;
      if (paused) { await context.suspend(); return false; }
      sync();
      return context.state === 'running';
    } catch { return false; }
  }
  async function setPaused(next) {
    paused = Boolean(next);
    if (disposed || !context) return false;
    try {
      if (paused) await context.suspend();
      else { await context.resume(); sync(); }
      return !disposed;
    } catch { return false; }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    loading.abort();
    signal?.removeEventListener('abort', dispose);
    for (const vehicle of vehicles.values()) releaseEmitter(vehicle);
    vehicles.clear();
    for (const shutter of shutters.values()) releaseEmitter(shutter);
    shutters.clear(); gateMotion.clear();
    disconnect(master); disconnect(compressor);
    if (context && context.state !== 'closed') {
      try { context.close()?.catch(() => {}); } catch { /* Device already closed. */ }
    }
    buffers = null; lastState = null; lastCamera = null;
  }
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();
  return { ready: ready.then(Boolean), resume, update, setPaused, dispose };
}
