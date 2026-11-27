/* The systems a user can enter, and what each one offers. Pure data: no DOM.
   Hiding only: permissions are still enforced by the server. */
(function () {
  /* The three gate installations differ only in who decides the direction. */
  function gateSystem(name, extra) {
    var system = {
      name: name, home: 'gate',
      tabs: ['overview', 'gate', 'inventory', 'setup'],
      labels: { overview: 'รายงาน' },
      stabs: ['btype', 'box', 'wh', 'cust'],
      settings: ['data'],
      without: ['manualReceive', 'stockImport', 'stockShip', 'relocate', 'pda'],
    };
    Object.keys(extra).forEach(function (key) { system[key] = extra[key]; });
    return system;
  }
  var LIST = {
    gate1: gateSystem('ประตูเดียว อัตโนมัติ', { unattended: true }),
    /* The attended gate confirms on the existing in/out screens (not in the menu). */
    gate2: gateSystem('ประตูมีเจ้าหน้าที่', {
      tabs: ['overview', 'gate', 'gatein', 'gateout', 'inventory', 'setup'],
      hidden: ['gatein', 'gateout'],
      modes: { in: ['rfid'], out: ['rfid'] },
    }),
    gate3: gateSystem('ประตูทิศเดียว', { unattended: true }),
    rfidgate: {
      name: 'RFID Gate', home: 'gatein',
      tabs: ['overview', 'gateout', 'gatein', 'inventory', 'setup'],
      labels: { overview: 'รายงาน' },
      /* Ways around the gates, and shelf handling. */
      without: ['manualReceive', 'stockImport', 'stockShip', 'relocate', 'pda', 'plateReport'],
      stabs: ['btype', 'box', 'wh', 'cust'],
      settings: ['data'],
      modes: { in: ['rfid'], out: ['manual', 'excel'] },
    },
    full: { name: 'ครบทุกฟีเจอร์', home: 'overview' },
  };
  function get(id) { return Object.prototype.hasOwnProperty.call(LIST, id) ? LIST[id] : LIST.full; }
  /* English for the page translator: whole texts of the names and the picker. */
  var en = [
    [/^ประตูเดียว อัตโนมัติ$/, 'Single gate, automatic'],
    [/^ประตูมีเจ้าหน้าที่$/, 'Attended gate'],
    [/^ประตูทิศเดียว$/, 'One-way gate'],
    [/^ครบทุกฟีเจอร์$/, 'All features'],
    [/^เลือกระบบ$/, 'Choose a system'],
    [/^เปลี่ยนระบบ$/, 'Switch system'],
    [/^กดการ์ดเพื่อเริ่ม · หรือกดเลข 1–5 บนแป้นพิมพ์$/, 'Click a card to start · or press 1–5'],
    [/^แฮนออน$/, 'Hanon'],
    [/^รับเข้า$/, 'Receive'],
    [/^FX9600 อัตโนมัติ$/, 'FX9600, automatic'],
    [/^Import Excel · ยิงมือ$/, 'Import Excel · Hand scan'],
    [/^เริ่มใช้ ›$/, 'Start ›'],
    [/^คนเฝ้า$/, 'Staff'],
    [/^ไม่มี$/, 'None'],
    [/^มีเจ้าหน้าที่$/, 'On duty'],
    [/^ทิศทาง$/, 'Direction'],
    [/^เสาอากาศบอกเข้า\/ออก$/, 'Antennas detect in/out'],
    [/^กดเลือกเข้า\/ออก$/, 'Staff choose in/out'],
    [/^ตั้งประจำประตู$/, 'Fixed per gate'],
    [/^ใช้ได้$/, 'Includes'],
    [/^ภาพรวม คลังกล่อง ติดตาม ตั้งค่า$/, 'Overview, inventory, tracking, setup'],
    [/^ทุกวิธีรับและส่ง$/, 'Every way to receive and ship'],
    [/^ประตู$/, 'Gate'],
    [/^รายงาน$/, 'Reports'],
  ];
  window.Systems = {
    /** Features with something on the page to hide (html.no-<feature>). */
    features: ['stockImport', 'stockShip', 'relocate', 'pda', 'plateReport'],
    en: en,
    valid: function (id) { return Object.prototype.hasOwnProperty.call(LIST, id); },
    name: function (id) { return get(id).name; },
    home: function (id) { return get(id).home; },
    /** The "gate" page exists only in the systems that list it. */
    allowsTab: function (id, tab) { var t = get(id).tabs; return t ? t.indexOf(tab) >= 0 : tab !== 'gate'; },
    inMenu: function (id, tab) { return this.allowsTab(id, tab) && (get(id).hidden || []).indexOf(tab) < 0; },
    unattended: function (id) { return !!get(id).unattended; },
    allowsStab: function (id, stab) { var t = get(id).stabs; return !t || t.indexOf(stab) >= 0; },
    label: function (id, tab) { return (get(id).labels || {})[tab] || (tab === 'overview' ? 'ภาพรวม' : ''); },
    can: function (id, feature) { return (get(id).without || []).indexOf(feature) < 0; },
    allowsSetting: function (id, section) { var s = get(id).settings; return !s || s.indexOf(section) >= 0; },
    /** The entry mode to use at a gate: the wanted one if offered, else the first offered. */
    mode: function (id, direction, wanted) {
      var m = get(id).modes;
      if (!m) return wanted;
      return m[direction].indexOf(wanted) >= 0 ? wanted : m[direction][0];
    },
  };
})();
