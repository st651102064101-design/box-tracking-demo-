// Defers login navigation only while the local simulation owns fullscreen.
// Server authorization and JWT expiration remain enforced by the API.
export function hasFullscreenSimulation(win) {
  try {
    if (win.__warehouseSimulationActive && win.document.fullscreenElement?.classList.contains('warehouse-simulation-host')) return true;
    return Array.from(win.document.querySelectorAll('iframe')).some(frame => {
      const child = frame.contentWindow;
      return child && child !== win && child.__warehouseSimulationActive
        && child.document.fullscreenElement?.classList.contains('warehouse-simulation-host');
    });
  } catch { return false; }
}

export function createSessionExpiryGuard({ window: win, getToken, onExpire }) {
  let timer = null, deniedToken = null, hasDeniedToken = false, disposed = false, expired = false;
  let hadToken = Boolean(getToken());
  const clear = () => { if (timer !== null) win.clearTimeout(timer); timer = null; };
  function expire() {
    if (disposed || expired) return;
    deniedToken = getToken();
    hasDeniedToken = true;
    clear();
    if (hasFullscreenSimulation(win)) return;
    expired = true;
    onExpire();
  }
  function check() {
    if (disposed || expired) return;
    clear();
    const token = getToken();
    if (hasDeniedToken && token === deniedToken) { expire(); return; }
    deniedToken = null; hasDeniedToken = false;
    if (!token) { if (hadToken) expire(); return; }
    hadToken = true;
    try {
      const payload = JSON.parse(win.atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (!Number.isFinite(payload.exp)) return;
      const remaining = payload.exp * 1000 - Date.now();
      if (remaining <= 0) {
        if (!hasFullscreenSimulation(win)) expire();
        return;
      }
      timer = win.setTimeout(check, Math.min(remaining, 2147483647));
    } catch { expire(); }
  }
  win.addEventListener('warehouse-simulation-change', check);
  win.addEventListener('storage', check);
  win.addEventListener('focus', check);
  check();
  return {
    expire,
    dispose() {
      disposed = true; clear();
      win.removeEventListener('warehouse-simulation-change', check);
      win.removeEventListener('storage', check);
      win.removeEventListener('focus', check);
    },
  };
}
