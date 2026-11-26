/* The systems a user can enter, and what each one offers. Pure data: no DOM.
   Hiding only: permissions are still enforced by the server. */
(function () {
  var LIST = {
    rfidgate: {
      name: 'RFID Gate', home: 'gatein',
      tabs: ['overview', 'gateout', 'gatein', 'inventory', 'setup'],
      labels: { overview: 'รายงาน' },
      /* Ways around the gates, and shelf handling. */
      without: ['manualReceive', 'stockImport', 'stockShip', 'relocate'],
      stabs: ['btype', 'box', 'wh', 'cust'],
      settings: ['data'],
      modes: { in: ['rfid'], out: ['manual', 'excel'] },
    },
    full: { name: 'ครบทุกฟีเจอร์', home: 'overview' },
  };
  function get(id) { return Object.prototype.hasOwnProperty.call(LIST, id) ? LIST[id] : LIST.full; }
  window.Systems = {
    valid: function (id) { return Object.prototype.hasOwnProperty.call(LIST, id); },
    name: function (id) { return get(id).name; },
    home: function (id) { return get(id).home; },
    allowsTab: function (id, tab) { var t = get(id).tabs; return !t || t.indexOf(tab) >= 0; },
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
