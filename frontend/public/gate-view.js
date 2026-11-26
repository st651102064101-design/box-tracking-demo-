/* What the gate page shows. Pure data: no DOM. */
(function () {
  function mismatch(system, gate) {
    var both = gate.type === 'both';
    if (system === 'gate1' && !(both && gate.mode === 'antenna')) return 'ระบบนี้ต้องตั้งประตูเป็น “เข้า-ออกร่วมกัน” และใช้ 2 เสาอากาศระบุทิศทาง';
    if (system === 'gate2' && !(both && gate.mode === 'screen')) return 'ระบบนี้ต้องตั้งประตูเป็น “เข้า-ออกร่วมกัน” และให้เลือกขาเข้า/ออกที่หน้าจอ';
    if (system === 'gate3' && both) return 'ระบบนี้ต้องตั้งประตูเป็นทิศเดียว คือขาเข้า หรือขาออก';
    return '';
  }

  /** The latest movements through a gate, newest first. */
  function passages(events, gate, limit) {
    return (events || []).filter(function (e) {
      return Number(e.gate) === Number(gate) && /^(in|out|in-new)$/.test(e.dir);
    }).sort(function (a, b) { return Date.parse(b.ts) - Date.parse(a.ts); }).slice(0, limit || 10);
  }

  var COLUMNS = {
    plate: /^(ทะเบียนรถ|ทะเบียน|ป้ายทะเบียน|plate|license ?plate)$/i,
    customer: /^(ลูกค้า|รหัสลูกค้า|ชื่อลูกค้า|customer)$/i,
    doNo: /^(do|เลข ?do|do ?no\.?)$/i,
    po: /^(po|เลข ?po|po ?no\.?)$/i,
    date: /^(วันที่|date)$/i,
  };
  /** Sheet rows (first row = headings) → plan rows, or null without plate and customer columns. */
  function planRows(sheet) {
    var head = (sheet && sheet[0]) || [];
    var at = {};
    Object.keys(COLUMNS).forEach(function (key) {
      for (var i = 0; i < head.length; i++) if (COLUMNS[key].test(String(head[i]).trim())) { at[key] = i; return; }
    });
    if (at.plate === undefined || at.customer === undefined) return null;
    return sheet.slice(1).map(function (row) {
      var out = {};
      Object.keys(COLUMNS).forEach(function (key) {
        var v = at[key] === undefined ? '' : row[at[key]];
        out[key] = v === undefined || v === null ? '' : String(v).trim();
      });
      return out;
    }).filter(function (r) { return r.plate || r.customer; });
  }

  window.GateView = { mismatch: mismatch, passages: passages, planRows: planRows };
})();
