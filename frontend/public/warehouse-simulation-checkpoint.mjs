// Tiny per-account browser checkpoint. It never contains real stock or tokens.
const PREFIX = 'boxtrace:warehouse-simulation:';
const MAX_BYTES = 8192;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const vector = value => Array.isArray(value) && value.length === 3 && value.every(item => finite(item) && Math.abs(item) <= 1000);
const orbit = value => value && vector(value.position) && vector(value.target) && finite(value.zoom) && value.zoom >= 0.1 && value.zoom <= 10;

export function checkpointProfile(storage, accountToken) {
  try {
    const token = accountToken === undefined ? (storage.getItem('smarttrace_jwt') || storage.getItem('boxtrace_jwt')) : accountToken;
    if (!token) return 'local';
    const payload = JSON.parse(decodeURIComponent(Array.from(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), char => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')));
    if (payload.sub === undefined || payload.sub === null) return 'local';
    return `${payload.employeeId ? 'employee' : 'user'}:${String(payload.employeeId || payload.sub)}`.slice(0, 256);
  } catch { return 'local'; }
}

function validView(view) {
  return view && ['orbit', 'first-person'].includes(view.mode) && orbit(view.orbit)
    && vector(view.walkingPosition) && finite(view.lookYaw) && Math.abs(view.lookYaw) <= 1000000
    && finite(view.lookPitch) && Math.abs(view.lookPitch) <= 1.35
    && typeof view.buildingVisible === 'boolean' && typeof view.uiHidden === 'boolean';
}

export function createCheckpointStore({ storage, profile = 'local', onError = () => {} }) {
  const key = PREFIX + encodeURIComponent(profile.slice(0, 256));
  let reported = false;
  const report = () => { if (!reported) { reported = true; onError(); } };
  return {
    load() {
      try {
        const raw = storage.getItem(key);
        if (!raw || raw.length > MAX_BYTES) return null;
        const value = JSON.parse(raw);
        return value?.version === 1 && validView(value.view) && value.engine ? value : null;
      } catch { report(); return null; }
    },
    save(engine, view) {
      try {
        if (!validView(view)) return false;
        const raw = JSON.stringify({ version: 1, engine, view });
        if (raw.length > MAX_BYTES) return false;
        storage.setItem(key, raw);
        return true;
      } catch { report(); return false; }
    },
  };
}
