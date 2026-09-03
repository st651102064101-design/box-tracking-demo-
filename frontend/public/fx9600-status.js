/* ============================================================================
 * BoxTrace — FX9600 reader online/offline status widget
 * ----------------------------------------------------------------------------
 * Injects a small status strip into the ภาพรวม (overview), Gate ขาเข้า
 * (gatein) and ตั้งค่า (setup) tabs, driven by the backend's derived
 * online/offline state (see backend/src/services/fx9600.ts) — a reader is
 * "online" purely by having sent a webhook (tag read or empty heartbeat)
 * within the last few seconds, never by whether it's currently seeing tags.
 *
 * Realtime: reuses the same /api/stream SSE connection the rest of the app
 * already opens, listening for its own 'readers' event; falls back to a
 * plain GET on /api/fx9600/status for the very first paint and if SSE never
 * connects (e.g. old browser).
 * ========================================================================== */
(function () {
  'use strict';
  var TOKEN_KEY = 'boxtrace_jwt';
  var MOUNTS = [
    { tab: 'tab-overview', title: 'สถานะเครื่องอ่าน FX9600' },
    { tab: 'tab-gatein', title: 'สถานะเครื่องอ่าน FX9600 ที่ประตูนี้' },
    { tab: 'tab-setup', title: 'สถานะเครื่องอ่าน FX9600' },
  ];
  var STALE_POLL_MS = 4000; // fallback only; SSE carries the realtime path

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensureStyle() {
    if (document.getElementById('fx9600-status-style')) return;
    var s = document.createElement('style');
    s.id = 'fx9600-status-style';
    s.textContent =
      '.fx9600-panel{margin:0 0 16px;padding:10px 14px;border:1px solid var(--line,#e3e3e8);' +
      'border-radius:12px;background:var(--card,#fff);}' +
      '.fx9600-panel .fx9600-title{font-size:12px;font-weight:600;color:var(--ink-2,#666);margin:0 0 8px;}' +
      '.fx9600-rows{display:flex;flex-wrap:wrap;gap:8px;}' +
      '.fx9600-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;' +
      'font-size:12px;font-weight:600;border:1px solid transparent;}' +
      '.fx9600-chip .dot{width:8px;height:8px;border-radius:50%;flex:none;}' +
      '.fx9600-chip.online{background:rgba(34,197,94,.12);color:#15803d;}' +
      '.fx9600-chip.online .dot{background:#22c55e;}' +
      '.fx9600-chip.offline{background:rgba(239,68,68,.12);color:#b91c1c;}' +
      '.fx9600-chip.offline .dot{background:#ef4444;}' +
      '.fx9600-empty{font-size:12px;color:var(--ink-3,#999);}';
    document.head.appendChild(s);
  }

  function mountPanel(tabId) {
    var host = document.getElementById(tabId);
    if (!host || host.querySelector('.fx9600-panel')) return null;
    var panel = el('div', 'fx9600-panel');
    var title = el('p', 'fx9600-title');
    var meta = MOUNTS.filter(function (m) { return m.tab === tabId; })[0];
    title.textContent = meta ? meta.title : 'สถานะเครื่องอ่าน FX9600';
    var rows = el('div', 'fx9600-rows');
    panel.appendChild(title);
    panel.appendChild(rows);
    host.insertBefore(panel, host.firstChild);
    return rows;
  }

  var rowsByTab = {};
  function mountAll() {
    MOUNTS.forEach(function (m) {
      var rows = mountPanel(m.tab);
      if (rows) rowsByTab[m.tab] = rows;
    });
  }

  function render(readers) {
    mountAll(); // tabs can render lazily; keep trying until each container exists
    var list = Array.isArray(readers) ? readers.slice() : [];
    list.sort(function (a, b) { return (a.id || '').localeCompare(b.id || '', 'th'); });
    Object.keys(rowsByTab).forEach(function (tabId) {
      var rows = rowsByTab[tabId];
      if (!rows) return;
      rows.innerHTML = '';
      if (!list.length) {
        rows.appendChild(el('span', 'fx9600-empty', 'ยังไม่มีเครื่องอ่าน FX9600 ส่งข้อมูลเข้ามา'));
        return;
      }
      list.forEach(function (r) {
        var chip = el('span', 'fx9600-chip ' + (r.online ? 'online' : 'offline'));
        chip.appendChild(el('span', 'dot'));
        var label = r.id + (r.gateNo != null ? ' · เกท ' + r.gateNo : '');
        chip.appendChild(el('span', null, label + ' — ' + (r.online ? 'ออนไลน์' : 'ออฟไลน์')));
        chip.title = r.lastWebhookAt ? 'ล่าสุด: ' + new Date(r.lastWebhookAt).toLocaleTimeString('th-TH') : 'ยังไม่เคยส่งข้อมูล';
        rows.appendChild(chip);
      });
    });
  }

  function fetchStatus() {
    var t = token();
    if (!t) return;
    fetch('/api/fx9600/status', { headers: { Authorization: 'Bearer ' + t } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.readers) render(d.readers); })
      .catch(function () {});
  }

  /* Piggyback on the same SSE stream legacy.html itself opens for state
     updates — one extra 'readers' event listener, not a second connection. */
  var es = null;
  function connectStream() {
    var t = token();
    if (!window.EventSource || es || !t) return;
    try { es = new EventSource('/api/stream?token=' + encodeURIComponent(t)); }
    catch (e) { es = null; return; }
    es.addEventListener('readers', function (ev) {
      try {
        var d = JSON.parse(ev.data);
        if (d && d.readers) render(d.readers);
      } catch (e) {}
    });
    es.onerror = function () { /* EventSource retries itself; the poll below covers the gap */ };
  }

  ensureStyle();
  fetchStatus();
  connectStream();
  if (!es) setTimeout(connectStream, 3000);

  /* Tabs are shown/hidden, not re-created, so a MutationObserver on class
     changes is what catches "user just switched to a tab we haven't
     mounted into yet" without hooking the app's own tab-switch code. */
  new MutationObserver(mountAll).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
  setInterval(fetchStatus, STALE_POLL_MS * 5); // safety net if SSE is ever down for a while
})();
