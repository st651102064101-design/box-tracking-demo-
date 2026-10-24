/** Owns only the temporary simulation session; live data never enters its frame. */
export function createSimulationSession({ window: win, getController, onError = () => {} }) {
  const doc = win.document;
  let current = null;
  let disposed = false;

  const announce = active => {
    win.__warehouseSimulationActive = active;
    win.dispatchEvent(new win.CustomEvent('warehouse-simulation-change', { detail: { active } }));
  };

  const startWhenReady = session => {
    if (current !== session || session.started || !session.ready || !session.fullscreen) return;
    session.started = true;
    win.clearTimeout(session.timeout);
    session.frame.contentWindow?.postMessage({ type: 'warehouse-simulation-start' }, win.location.origin);
    session.frame.focus();
  };

  const exit = async () => {
    const session = current;
    if (!session) return;
    current = null; // fullscreenchange/message/keydown may all report the same exit.
    win.clearTimeout(session.timeout);
    const ownedFullscreen = doc.fullscreenElement === session.host;
    try { session.frame.contentDocument?.exitPointerLock?.(); } catch { /* frame may already be gone */ }
    // Pop our fullscreen layer before removing it. Removing it first already
    // pops the layer, so exitFullscreen would then exit the original 3D stage.
    if (ownedFullscreen) {
      try { await doc.exitFullscreen(); } catch { /* browser Escape already exited */ }
    }
    session.host.remove();
    win.fetch = session.originalFetch;
    announce(false);
    session.controller.resumeFromSimulation();
    if (session.focus?.isConnected) session.focus.focus({ preventScroll: true });
  };

  const enter = async () => {
    if (disposed || current || win.__warehouseSimulationActive) return false;
    const controller = getController();
    if (!controller?.suspendForSimulation?.()) {
      onError('กรุณารอให้งานรถจริงเสร็จ และยกเลิกการเลือกรถก่อนเปิดโหมดจำลอง');
      return false;
    }
    const host = doc.createElement('div');
    host.className = 'warehouse-simulation-host';
    host.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:2147483647;background:#111820;';
    const frame = doc.createElement('iframe');
    frame.title = 'Warehouse putaway simulation';
    frame.setAttribute('allow', 'fullscreen');
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0;';
    host.appendChild(frame);
    const session = { host, frame, controller, originalFetch: win.fetch, focus: doc.activeElement, ready: false, fullscreen: false, started: false, timeout: null };
    current = session;
    // Safety net for background app timers: keep all API traffic paused while
    // the memory-only scene is active. Static module/model files remain usable.
    win.fetch = function (input, init) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, win.location.href);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return Promise.reject(new win.DOMException('Live API is paused during warehouse simulation', 'AbortError'));
      }
      return session.originalFetch.call(win, input, init);
    };
    announce(true);
    (doc.fullscreenElement || doc.body).appendChild(host);
    frame.src = '/warehouse-simulation.html';
    session.timeout = win.setTimeout(() => {
      if (current !== session) return;
      void exit();
      onError('เปิดฉากจำลองไม่สำเร็จ กรุณาลองใหม่');
    }, 20000);
    try {
      // Call directly in the click/key event: awaiting asset loading first
      // loses transient user activation and browsers refuse fullscreen.
      if (!host.requestFullscreen) throw new Error('Fullscreen unavailable');
      await host.requestFullscreen();
      if (current !== session) {
        if (doc.fullscreenElement === host) await doc.exitFullscreen().catch(() => {});
        return false;
      }
      if (doc.fullscreenElement !== host) throw new Error('Fullscreen was not entered');
      session.fullscreen = true;
      startWhenReady(session);
      return true;
    } catch (error) {
      if (current === session) {
        await exit();
        onError('เปิดโหมดจำลองไม่ได้: กรุณาอนุญาต Fullscreen แล้วลองใหม่');
      }
      return false;
    }
  };

  const onMessage = event => {
    const session = current;
    if (!session || event.origin !== win.location.origin || event.source !== session.frame.contentWindow) return;
    if (event.data?.type === 'warehouse-simulation-ready') { session.ready = true; startWhenReady(session); }
    if (event.data?.type === 'warehouse-simulation-exit') void exit();
    if (event.data?.type === 'warehouse-simulation-error') {
      void exit();
      onError(String(event.data.message || 'เปิดฉากจำลองไม่สำเร็จ'));
    }
  };
  const onKey = event => {
    if (!current || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void exit();
  };
  const onFullscreen = () => {
    if (current?.fullscreen && doc.fullscreenElement !== current.host) void exit();
  };
  win.addEventListener('message', onMessage);
  win.addEventListener('keydown', onKey, true);
  doc.addEventListener('fullscreenchange', onFullscreen);
  return {
    enter, exit,
    isActive: () => Boolean(current),
    dispose() {
      disposed = true;
      void exit();
      win.removeEventListener('message', onMessage);
      win.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('fullscreenchange', onFullscreen);
    },
  };
}

export function installSimulationEntry(win) {
  const session = createSimulationSession({
    window: win,
    getController: () => win.LocationWarehouse3D?.active?.(),
    onError: message => win.toast?.('โหมดจำลอง', message, 'warn'),
  });
  const visible3D = () => {
    const root = win.document.getElementById('loc3dView');
    return Boolean(root?.querySelector('canvas') && root.getClientRects().length && win.getComputedStyle(root).visibility !== 'hidden');
  };
  win.WarehouseSimulation = { enter: () => visible3D() ? session.enter() : Promise.resolve(false), exit: session.exit, isActive: session.isActive };
  const onShortcut = event => {
    if (event.code !== 'KeyS' || !event.shiftKey || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])') || !visible3D()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void session.enter();
  };
  win.addEventListener('keydown', onShortcut, true);
  win.addEventListener('pagehide', () => { win.removeEventListener('keydown', onShortcut, true); session.dispose(); }, { once: true });
  return session;
}

if (typeof window !== 'undefined') installSimulationEntry(window);
