/* ============================================================================
 * BoxTrace — persistence bridge (the ONLY code added to the original app)
 * ----------------------------------------------------------------------------
 * The legacy single-page app is byte-for-byte identical to rfid-gate_v17-3d.html
 * except for the single <script src="/legacy-sync.js"> tag in <head>.
 *
 * It used to keep its whole state object `S` in localStorage under key
 * 'boxtrace_p1'. This shim transparently mirrors that to PostgreSQL via the
 * backend API — without touching a single line of the app's own logic:
 *
 *   • it INTERCEPTS localStorage.setItem('boxtrace_p1', …) → debounced PUT /api/state
 *   • on boot it FETCHES GET /api/state and, if the server has data, loads it
 *     into the running app via the app's own global load()+renderAll().
 *
 * Auth: reads the JWT the login page stored in localStorage 'boxtrace_jwt'.
 * A 401 bounces the top window to /login.
 * ========================================================================== */
(function () {
  'use strict';
  var KEY = 'boxtrace_p1';
  var TOKEN_KEY = 'boxtrace_jwt';
  var API = '/api/state';
  var DEBOUNCE_MS = 600;

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function gotoLogin() {
    try { (window.top || window).location.href = '/login'; } catch (e) { location.href = '/login'; }
  }

  // Hide the page until server state is primed, to avoid a flash of local/demo
  // data. Revealed again in finishPriming(). (Pure load behaviour — the final
  // rendered UI is unchanged.)
  var priming = true;
  var lastSynced = null;          // last JSON string we know the server has
  var putTimer = null;
  var pendingValue = null;

  try {
    var de = document.documentElement;
    de.style.visibility = 'hidden';
    // safety: never keep the page hidden for more than 4s
    setTimeout(function () { de.style.visibility = ''; }, 4000);
  } catch (e) {}

  /* ── persistence OUT: intercept the app's own save() ─────────────────────*/
  var realSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    realSetItem.apply(this, arguments);
    if (k === KEY) scheduleSync(v);
  };

  function scheduleSync(value) {
    pendingValue = value;
    if (priming) return;                 // buffer until initial prime resolves
    if (value === lastSynced) return;    // nothing changed
    if (putTimer) clearTimeout(putTimer);
    putTimer = setTimeout(flushSync, DEBOUNCE_MS);
  }

  function flushSync() {
    putTimer = null;
    var value = pendingValue;
    if (value == null || value === lastSynced) return;
    var body = value;
    fetch(API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: body,
    })
      .then(function (r) {
        if (r.status === 401) { gotoLogin(); return; }
        if (r.ok) lastSynced = value;
      })
      .catch(function () { /* offline: keep localStorage; retry on next save */ });
  }

  /* ── persistence IN: prime from server on boot ───────────────────────────*/
  function prime() {
    if (!token()) { gotoLogin(); return; }
    fetch(API, { headers: { Authorization: 'Bearer ' + token() } })
      .then(function (r) {
        if (r.status === 401) { gotoLogin(); return null; }
        if (!r.ok) throw new Error('state fetch failed: ' + r.status);
        return r.json();
      })
      .then(function (serverState) {
        if (!serverState) return;
        var hasData = serverState.boxes && Object.keys(serverState.boxes).length > 0;
        if (hasData) {
          // Server is the source of truth → load it into the running app.
          var json = JSON.stringify(serverState);
          realSetItem.call(localStorage, KEY, json);
          lastSynced = json;
          applyToRunningApp();
        } else {
          // First run: keep whatever the app seeded locally and push it up.
          try { lastSynced = null; pendingValue = localStorage.getItem(KEY); } catch (e) {}
        }
      })
      .catch(function (err) { console.warn('[boxtrace-sync] prime failed, using local state:', err); })
      .then(finishPriming);
  }

  function applyToRunningApp() {
    // The app declares load()/renderAll() as globals in a classic script.
    try {
      if (typeof window.load === 'function') window.load();
      if (typeof window.renderAll === 'function') window.renderAll();
    } catch (e) { console.warn('[boxtrace-sync] re-render failed:', e); }
  }

  function finishPriming() {
    priming = false;
    try { document.documentElement.style.visibility = ''; } catch (e) {}
    // flush any state the app produced while we were priming (e.g. first-run demo seed)
    if (pendingValue != null && pendingValue !== lastSynced) scheduleSync(pendingValue);
  }

  /* ── logout: reuse the app's existing account chip (no new visible UI) ────*/
  function wireLogout() {
    var who = document.querySelector('.who');
    if (!who || who.getAttribute('data-logout-wired')) return;
    who.setAttribute('data-logout-wired', '1');
    who.style.cursor = 'pointer';
    who.title = 'คลิกเพื่อออกจากระบบ';
    who.addEventListener('click', function () {
      if (window.confirm('ออกจากระบบ?')) {
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        gotoLogin();
      }
    });
  }

  // Kick off priming once the DOM (and the app's boot) has run.
  function boot() { setTimeout(function () { prime(); wireLogout(); }, 0); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
