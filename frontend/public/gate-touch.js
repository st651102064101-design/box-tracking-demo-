(function () {
  'use strict';
  var key = 'boxtrace-gate-touch', home, toolbar, readinessTimer;
  function save(on) { try { localStorage.setItem(key, on ? '1' : '0'); } catch (_) {} }
  function openWorkflow(dir) {
    switchTab(dir);
    if (!document.getElementById('tab-' + dir).classList.contains('active')) return;
    document.body.dataset.gateTouchPage = dir;
    toolbar.querySelector('strong').textContent = dir === 'gatein' ? 'รับเข้า / Receive' : 'ส่งออก / Dispatch';
    /* A terminal always starts with its gate readers.  The operator can
       deliberately switch to the large manual-scanning option afterwards. */
    setTimeout(function () {
      if (!document.body.classList.contains('gate-touch')) return;
      if (dir === 'gatein') window.chooseGateInEntryMode('rfid');
      else window.chooseGateOutEntryMode('rfid');
      refreshManualFallback(dir);
    }, 360);
    window.scrollTo(0, 0);
  }
  function refreshManualFallback(dir) {
    if (!document.body.classList.contains('gate-touch')) return;
    var isIn = dir === 'gatein', bar = document.getElementById(isIn ? 'gateInModeBar' : 'gateOutModeBar');
    var manual = bar && bar.querySelector(isIn ? '[data-gatein-mode="manual"]' : '[data-gateout-mode="manual"]');
    if (!bar || !manual) return;
    var gate = (typeof fixedGatesRef === 'function' ? fixedGatesRef() : {})[isIn ? 'in' : 'out'];
    var ready = !!(gate && typeof rfidGateIsReady === 'function' && rfidGateIsReady(gate));
    var manualActive = isIn ? window.gateInEntryMode === 'manual' : window.gateOutEntryMode === 'manual';
    var allowManual = !ready || manualActive;
    bar.classList.toggle('terminal-manual-available', allowManual);
    manual.style.setProperty('display', allowManual ? 'flex' : 'none', 'important');
    manual.setAttribute('aria-hidden', String(!allowManual));
    manual.title = 'ใช้ได้เมื่อ RFID Gate / LPR ไม่พร้อมเท่านั้น';
    manual.onclick = function (event) {
      event.preventDefault();
      if (!allowManual) return;
      var proceed = function (ok) {
        if (!ok) return;
        if (isIn) window.chooseGateInEntryMode('manual');
        else window.chooseGateOutEntryMode('manual');
        refreshManualFallback(dir);
      };
      if (typeof confirmA === 'function') {
        confirmA('เปลี่ยนเป็นยิงมือ?', 'RFID Gate / LPR ไม่พร้อมใช้งาน จึงจะเปลี่ยนเป็นการยิงบาร์โค้ดด้วยมือ', 'ยืนยันใช้ยิงมือ', true).then(proceed);
      } else proceed(window.confirm('RFID Gate / LPR ไม่พร้อมใช้งาน ต้องการใช้ยิงมือแทนหรือไม่?'));
    };
    var copy = manual.querySelector('small');
    if (copy) copy.textContent = allowManual ? 'ใช้เมื่อ RFID/LPR ไม่พร้อมเท่านั้น' : 'ใช้เมื่อ RFID/LPR ไม่พร้อมเท่านั้น';
  }
  function refreshTouchReadiness() {
    var page = document.body.dataset.gateTouchPage;
    if (page === 'gatein' || page === 'gateout') refreshManualFallback(page);
  }
  function init() {
    if (home) return;
    home = document.createElement('div');
    home.id = 'gate-touch-home';
    home.innerHTML = '<header><small>WAREHOUSE TERMINAL</small><h1>เลือกทำรายการ</h1><p>แตะปุ่มเพื่อเริ่มรับหรือส่งกล่อง</p></header><div class="gate-touch-choices"><button data-dir="gatein"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v18h-7M3 12h13M10 6l6 6-6 6"/></svg><strong>รับเข้า</strong><span>RECEIVE · รับกล่องเข้าคลัง</span></button><button data-dir="gateout"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3H3v18h7M8 12h13M15 6l6 6-6 6"/></svg><strong>ส่งออก</strong><span>DISPATCH · ส่งกล่องออกจากคลัง</span></button></div><p class="gate-touch-note">ออกจากโหมดจอสัมผัส: กด Esc หรือปุ่มกลับของเบราว์เซอร์</p>';
    home.querySelectorAll('button').forEach(function (button) { button.onclick = function () { openWorkflow(button.dataset.dir); }; });
    toolbar = document.createElement('div');
    toolbar.id = 'gate-touch-toolbar';
    toolbar.innerHTML = '<button type="button" class="gate-touch-back">← ย้อนกลับ</button><strong>เลือกทำรายการ</strong><button type="button" aria-expanded="false" aria-controls="gate-touch-menu">☰ หน้าอื่น ๆ</button><div id="gate-touch-menu" hidden></div>';
    var menu = toolbar.lastElementChild, menuButton = toolbar.children[2];
    function closeMenu() { menu.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); }
    toolbar.firstElementChild.onclick = function () {
      closeMenu();
      if (document.body.dataset.gateTouchPage === 'home') { disable(); return; }
      document.body.dataset.gateTouchPage = 'home';
      toolbar.querySelector('strong').textContent = 'เลือกทำรายการ';
      window.scrollTo(0, 0);
    };
    menuButton.onclick = function () { menu.hidden = !menu.hidden; menuButton.setAttribute('aria-expanded', String(!menu.hidden)); };
    document.querySelectorAll('#nav button[data-tab]').forEach(function (source) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = source.querySelector('.navlbl')?.textContent || source.title;
      button.onclick = function () {
        var dir = source.dataset.tab;
        if (dir === 'gatein' || dir === 'gateout') { closeMenu(); openWorkflow(dir); return; }
        switchTab(dir);
        if (!document.getElementById('tab-' + dir)?.classList.contains('active')) return;
        document.body.dataset.gateTouchPage = dir;
        toolbar.querySelector('strong').textContent = button.textContent;
        closeMenu(); window.scrollTo(0, 0);
      };
      menu.appendChild(button);
    });
    var exit = document.createElement('button');
    exit.type = 'button'; exit.textContent = 'ออกจากโหมดจอสัมผัส'; exit.onclick = function () { closeMenu(); disable(); };
    menu.appendChild(exit);
    document.body.append(home, toolbar);
  }
  function enable() {
    init(); save(true);
    document.body.classList.add('gate-touch');
    document.body.dataset.gateTouchPage = 'home';
    toolbar.querySelector('strong').textContent = 'เลือกทำรายการ';
    clearInterval(readinessTimer);
    readinessTimer = setInterval(refreshTouchReadiness, 3000);
    history.pushState({gateTouch:true}, '', location.href);
  }
  function disable() { save(false); clearInterval(readinessTimer); readinessTimer = null; document.body.classList.remove('gate-touch'); delete document.body.dataset.gateTouchPage; }
  window.gateTouch = {enable:enable, disable:disable};
  window.addEventListener('keydown', function (e) { if(e.key === 'Escape' && document.body.classList.contains('gate-touch')) disable(); });
  window.addEventListener('popstate', disable);
  try { if(localStorage.getItem(key) === '1') enable(); } catch (_) {}
})();
