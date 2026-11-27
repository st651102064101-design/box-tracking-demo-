/* Can the warehouse work right now, and what is in the way. Pure data: no DOM.
   null = not known yet, 'error' = the check failed: neither may read as ready. */
(function () {
  var RANK = { ok: 0, wait: 1, warn: 2, bad: 3 };
  function item(level, text, go, arg) { return { level: level, text: text, go: go || '', arg: arg === undefined ? '' : arg }; }

  function devices(s) {
    var out = [], readers = s.readers;
    if (!readers) out.push(item('wait', 'กำลังตรวจเครื่องอ่าน FX9600'));
    else if (!readers.length) out.push(item('bad', 'ยังไม่ผูก FX9600 กับประตูใดเลย', 'bind'));
    else {
      var silent = readers.filter(function (r) { return !r.online; });
      silent.forEach(function (r) { out.push(item('bad', 'FX9600 ประตู ' + r.gate + ' ไม่ตอบสนอง', 'bind', r.gate)); });
      if (!silent.length) out.push(item('ok', 'FX9600 พร้อม ' + readers.length + ' ประตู'));
    }
    if (s.needsLpr && readers) {
      var mute = readers.filter(function (r) { return s.lprGates.indexOf(r.gate) < 0; });
      mute.forEach(function (r) { out.push(item('warn', 'LPR ประตู ' + r.gate + ' ยังไม่เคยส่งข้อมูล', 'lpr', r.gate)); });
      if (!readers.length && !s.lprGates.length) out.push(item('warn', 'ยังไม่เคยได้รับข้อมูลจากกล้อง LPR', 'lpr'));
      else if (!mute.length) out.push(item('ok', 'LPR เคยส่งข้อมูลแล้ว', 'lpr'));
    }
    if (s.needsPda) {
      if (!s.pda) out.push(item('wait', 'กำลังตรวจเครื่อง PDA'));
      else if (!s.pda.length) out.push(item('warn', 'ยังไม่มีเครื่อง PDA เชื่อมต่อ', 'pda'));
      else {
        var off = s.pda.filter(function (d) { return !d.online; });
        out.push(off.length
          ? item('warn', 'PDA ออฟไลน์: ' + off.map(function (d) { return d.name; }).join(', '), 'pda')
          : item('ok', 'PDA ออนไลน์ ' + s.pda.length + ' เครื่อง', 'pda'));
      }
    }
    return out;
  }

  function boxes(s) {
    var b = s.boxes, out = [];
    out.push(b.ready ? item('ok', 'พร้อมส่ง ' + b.ready + ' ใบ', 'inventory', 'warehouse') : item('bad', 'ไม่มีกล่องพร้อมส่ง', 'inventory', ''));
    if (s.unattended) {
      if (s.review === null) out.push(item('wait', 'กำลังตรวจรายการต้องตรวจ'));
      else if (s.review === 'error') out.push(item('warn', 'ตรวจรายการต้องตรวจไม่ได้', 'gate'));
      else if (s.review) out.push(item('warn', 'ต้องตรวจที่ประตู ' + s.review + ' ใบ', 'gate'));
    }
    if (b.overdue) out.push(item('warn', 'ค้างคืนเกินกำหนด ' + b.overdue + ' ใบ', 'overdue'));
    if (b.lost) out.push(item('warn', 'สูญหาย ' + b.lost + ' ใบ', 'inventory', 'lost'));
    if (b.hold + b.damage) out.push(item('warn', 'พักใช้งาน/ชำรุด ' + (b.hold + b.damage) + ' ใบ', 'inventory', b.damage ? 'damage' : 'hold'));
    return out;
  }

  function shipping(s) {
    if (!s.customers) return [item('bad', 'ยังไม่มีลูกค้า', 'cust')];
    var out = [item('ok', 'ลูกค้าพร้อมเลือก ' + s.customers + ' ราย', 'cust')];
    if (!s.unattended) return out;
    if (s.plans === 'error') out.push(item('warn', 'ตรวจรายการส่งของไม่ได้', 'gate'));
    else if (s.plans === null) out.push(item('wait', 'กำลังตรวจรายการส่งของ'));
    else if (s.plans > 0) out.push(item('ok', 'รายการรอรถวันนี้ ' + s.plans + ' รายการ', 'gate'));
    else if (s.preset === null) out.push(item('wait', 'กำลังตรวจลูกค้าที่ตั้งไว้ที่ประตู'));
    else if (s.preset === true) out.push(item('ok', 'ตั้งลูกค้าไว้ที่ประตูแล้ว', 'gate'));
    else out.push(item('warn', 'ขาออกอัตโนมัติยังไม่รู้ว่าส่งให้ใคร', 'gate'));
    return out;
  }

  function worst(items) {
    return items.reduce(function (w, i) { return RANK[i.level] > RANK[w] ? i.level : w; }, 'ok');
  }
  function assess(s) {
    var groups = [
      { id: 'devices', title: 'อุปกรณ์', items: devices(s) },
      { id: 'boxes', title: 'กล่อง', items: boxes(s) },
      { id: 'shipping', title: 'การส่งออก', items: shipping(s) },
    ];
    var all = [];
    groups.forEach(function (g) {
      g.level = worst(g.items);
      g.items.sort(function (a, b) { return RANK[b.level] - RANK[a.level]; }); /* problems first */
      all = all.concat(g.items);
    });
    var problems = all.filter(function (i) { return i.level === 'warn' || i.level === 'bad'; }).length;
    var level = worst(all);
    var title = level === 'ok' ? 'พร้อมทำงาน' : level === 'wait' ? 'กำลังตรวจความพร้อม…'
      : level === 'warn' ? 'ทำงานได้ · มี ' + problems + ' เรื่องต้องดู' : 'ยังไม่พร้อม · มี ' + problems + ' เรื่องต้องแก้';
    return { level: level, title: title, problems: problems, groups: groups };
  }
  window.Readiness = { assess: assess };
})();
