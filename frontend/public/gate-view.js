/* What the gate page shows. Pure data: no DOM. */
(function () {
  function mismatch(system, gate) {
    var both = gate.type === 'both';
    if (system === 'gate1' && !(both && gate.mode === 'antenna')) return 'ระบบนี้ต้องตั้งประตูเป็น “เข้า-ออกร่วมกัน” และใช้ 2 เสาอากาศระบุทิศทาง';
    if (system === 'gate2' && !(both && gate.mode === 'screen')) return 'ระบบนี้ต้องตั้งประตูเป็น “เข้า-ออกร่วมกัน” และให้เลือกขาเข้า/ออกที่หน้าจอ';
    if (system === 'gate3' && both) return 'ระบบนี้ต้องตั้งประตูเป็นทิศเดียว คือขาเข้า หรือขาออก';
    return '';
  }

  /** Why a gate cannot take work yet: '' when it can, otherwise 'unbound' or 'offline'. */
  function lockReason(bound, online) {
    if (!bound) return 'unbound';
    return online ? '' : 'offline';
  }

  /** The gate's readiness as three steps, and the one card that says where it stands. */
  function readiness(system, info, bound, online) {
    var problem = mismatch(system, info);
    var lock = lockReason(bound, online);
    var linked = !lock;
    var ready = linked && !problem;
    var reason = lock === 'unbound' ? 'ผูกเครื่อง FX9600 กับประตูนี้ก่อน'
      : lock === 'offline' ? 'เครื่อง FX9600 ไม่ตอบสนอง ตรวจเครื่องอ่านก่อน'
      : problem;
    return {
      ready: ready,
      reason: ready ? '' : reason,
      action: ready ? '' : lock === 'unbound' ? 'ผูกเครื่อง' : lock === 'offline' ? 'ตรวจเครื่อง' : 'แก้การตั้งค่า',
      steps: [
        { label: 'ผูกเครื่อง FX9600', state: linked ? 'done' : 'now' },
        { label: 'ตั้งประตูให้ตรงระบบ', state: !linked ? 'todo' : problem ? 'now' : 'done' },
        { label: 'พร้อมใช้งาน', state: ready ? 'done' : 'todo' },
      ],
    };
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

  /** Warehouse names often start with the word already. */
  function warehouseLabel(name) { return String(name).indexOf('คลัง') === 0 ? String(name) : 'คลัง ' + name; }

  function two(n) { return (n < 10 ? '0' : '') + n; }
  /** What the "customer set at this gate" card shows at server time `now`. */
  function presetView(data, now) {
    var s = data && data.session && data.session.preset ? data.session : null;
    var old = data && data.expired;
    if (!s) return old ? { state: 'expired', customer: old.customer, ttlSeconds: old.ttlSeconds } : { state: 'none' };
    var started = Date.parse(s.startedAt);
    if (s.permanent) {
      var secs = Math.max(0, Math.floor((now - started) / 1000));
      var used = secs >= 86400 ? Math.floor(secs / 86400) + ' วัน' : secs >= 3600 ? Math.floor(secs / 3600) + ' ชั่วโมง' : Math.floor(secs / 60) + ' นาที';
      return { state: 'permanent', customer: s.customer, used: 'ใช้มาแล้ว ' + used };
    }
    var left = Math.ceil((Date.parse(s.expiresAt) - now) / 1000);
    if (left <= 0) return { state: 'expired', customer: s.customer, ttlSeconds: s.ttlSeconds };
    var total = (Date.parse(s.expiresAt) - started) / 1000;
    return {
      state: left < 900 ? 'soon' : 'active', customer: s.customer, ttlSeconds: s.ttlSeconds,
      remaining: two(Math.floor(left / 3600)) + ':' + two(Math.floor(left / 60) % 60) + ':' + two(left % 60),
      fraction: total > 0 ? Math.min(1, left / total) : 0,
    };
  }

  /* English for the page translator: whole texts of the gate page. */
  var en = [
    [/^ประตู (.+) พร้อมใช้งาน$/, 'Gate $1 ready'],
    [/^ประตู (.+) ยังไม่พร้อม$/, 'Gate $1 not ready'],
    [/^ผูกเครื่อง FX9600 กับประตูนี้ก่อน$/, 'Bind an FX9600 to this gate first'],
    [/^เครื่อง FX9600 ไม่ตอบสนอง ตรวจเครื่องอ่านก่อน$/, 'FX9600 is not responding; check the reader first'],
    [/^ผูกเครื่อง FX9600$/, 'Bind FX9600'],
    [/^ตั้งประตูให้ตรงระบบ$/, 'Set the gate to match the system'],
    [/^พร้อมใช้งาน$/, 'Ready'],
    [/^ผูกเครื่อง$/, 'Bind'],
    [/^รับสัญญาณจากเครื่อง$/, 'Receive signal from the reader'],
    [/^ตรวจเครื่อง$/, 'Check reader'],
    [/^แก้การตั้งค่า$/, 'Fix settings'],
    [/^ยังไม่ผูก FX9600 กับประตูใดเลย · มี (\d+) ประตู$/, 'No FX9600 bound yet · gates: $1'],
    [/^ผูกเครื่อง FX9600 ›$/, 'Bind an FX9600 ›'],
    [/^ดูประตูที่ยังไม่ผูก \((\d+)\)$/, 'Show unbound gates ($1)'],
    [/^ใช้นานแค่ไหน$/, 'For how long'],
    [/^2 ชม\.$/, '2 h'],
    [/^8 ชม\.$/, '8 h'],
    [/^ถาวร$/, 'Permanent'],
    [/^ใช้ลูกค้านี้$/, 'Use this customer'],
    [/^● กำลังใช้$/, '● In use'],
    [/^● ใกล้หมดเวลา$/, '● Ending soon'],
    [/^● ใช้ตลอดจนกว่าจะหยุด$/, '● Used until you stop it'],
    [/^หมดเวลาแล้ว$/, 'Time is up'],
    [/^เหลือ$/, 'left'],
    [/^ต่อเวลา$/, 'Restart the time'],
    [/^เปลี่ยนลูกค้า$/, 'Change customer'],
    [/^หยุดใช้$/, 'Stop using'],
    [/^ใช้ลูกค้าเดิมอีกครั้ง$/, 'Use the same customer again'],
    [/^เลือกลูกค้าอื่น$/, 'Choose another customer'],
    [/^ใช้มาแล้ว (\d+) วัน$/, 'In use for $1 days'],
    [/^ใช้มาแล้ว (\d+) ชั่วโมง$/, 'In use for $1 hours'],
    [/^ใช้มาแล้ว (\d+) นาที$/, 'In use for $1 minutes'],
    [/^ตั้งเมื่อ (.+) โดย (.+) · หมด (.+)$/, 'Set $1 by $2 · ends $3'],
    [/^ตั้งเมื่อ (.+) โดย (.+)$/, 'Set $1 by $2'],
    [/^ใช้ลูกค้านี้ตลอด\?$/, 'Use this customer permanently?'],
    [/^ใช้ตลอด$/, 'Use permanently'],
    [/^รถที่ป้ายไม่อยู่ในรายการ Excel จะส่งให้ (.+) จนกว่าจะกดหยุดใช้$/, 'Trucks not on the Excel list will ship to $1 until you stop it'],
    [/^หยุดใช้ลูกค้าของประตูแล้ว$/, 'Stopped using the gate customer'],
    [/^ประตูสแกน$/, 'Scan gate'],
    [/^ขาออก: ส่งให้ใคร$/, 'Outbound: ship to whom'],
    [/^1 · รายการจาก Excel \(จับคู่ด้วยทะเบียนรถ\)$/, '1 · Jobs from Excel (matched by plate)'],
    [/^นำเข้า Excel$/, 'Import Excel'],
    [/^ไฟล์ตัวอย่าง$/, 'Sample file'],
    [/^2 · ลูกค้าที่ตั้งไว้ที่ประตูนี้ \(ใช้เมื่อป้ายรถไม่อยู่ในรายการ\)$/, '2 · Customer set at this gate (used when the plate is not listed)'],
    [/^ตั้งไว้ 8 ชั่วโมง$/, 'Set for 8 hours'],
    [/^ยกเลิก$/, 'Cancel'],
    [/^ผ่านประตูล่าสุด$/, 'Latest through the gate'],
    [/^ลูกค้าของประตูนี้$/, 'Customer of this gate'],
    [/^ยังไม่มีประตูในระบบ$/, 'No gate set up yet'],
    [/^เพิ่มประตู$/, 'Add a gate'],
    [/^แก้การตั้งค่า ›$/, 'Fix the settings ›'],
    [/^ระบบนี้ต้องตั้งประตูเป็น “เข้า-ออกร่วมกัน” และใช้ 2 เสาอากาศระบุทิศทาง$/, 'This system needs a two-way gate with 2 antennas to detect direction'],
    [/^ระบบนี้ต้องตั้งประตูเป็น “เข้า-ออกร่วมกัน” และให้เลือกขาเข้า\/ออกที่หน้าจอ$/, 'This system needs a two-way gate with direction chosen on screen'],
    [/^ระบบนี้ต้องตั้งประตูเป็นทิศเดียว คือขาเข้า หรือขาออก$/, 'This system needs a one-way gate: in or out'],
    [/^ขาเข้าอย่างเดียว$/, 'Inbound only'],
    [/^ขาออกอย่างเดียว$/, 'Outbound only'],
    [/^เข้า-ออก · เสาอากาศบอกทิศ$/, 'Two-way · antennas detect'],
    [/^เข้า-ออก · เจ้าหน้าที่เลือก$/, 'Two-way · staff choose'],
    [/^ทำงานเองโดยไม่ต้องมีคนเฝ้า$/, 'Runs unattended'],
    [/^เจ้าหน้าที่กดเลือกทิศก่อนรถผ่าน$/, 'Staff pick the direction before the truck passes'],
    [/^เครื่องอ่าน FX9600$/, 'FX9600 reader'],
    [/^● พร้อมใช้งาน$/, '● Ready'],
    [/^● ไม่ตอบสนอง$/, '● Not responding'],
    [/^● ยังไม่ผูก$/, '● Not bound'],
    [/^ตรวจเครื่อง ›$/, 'Check reader ›'],
    [/^ผูกเครื่อง ›$/, 'Bind reader ›'],
    [/^กล้องป้ายทะเบียน \(LPR\)$/, 'Plate camera (LPR)'],
    [/^ยังไม่เคยอ่านป้ายคู่กับกล่องที่ประตูนี้$/, 'No plate has been read with a box at this gate'],
    [/^⬇ ขาเข้า$/, '⬇ Inbound'],
    [/^⬆ ขาออก$/, '⬆ Outbound'],
    [/^ออก$/, 'Out'],
    [/^เข้า$/, 'In'],
    [/^ยังไม่มีกล่องผ่านประตูนี้$/, 'No box has passed this gate'],
    [/^— เลือกลูกค้า —$/, '— Choose a customer —'],
    [/^ต้องตรวจ$/, 'To review'],
    [/^เครื่องอ่านเจอกล่อง แต่ระบบไม่บันทึกเอง เพราะไม่รู้ทิศทางหรือลูกค้า หรือรออ่านป้ายรถ \(รายการหายเองใน 10 นาที\)$/, 'Boxes were read but not recorded: direction or customer unknown, or waiting for a plate (cleared after 10 minutes)'],
    [/^ไม่มีรายการค้าง$/, 'Nothing waiting'],
    [/^นำออก$/, 'Remove'],
    [/^รอรถ$/, 'Waiting for truck'],
    [/^เลยวันแล้ว$/, 'Date passed'],
    [/^รอถึงวัน$/, 'Waiting for date'],
    [/^ลบ$/, 'Delete'],
    [/^ยังไม่มีรายการรอรถ$/, 'No job waiting'],
    [/^ยังไม่ได้ตั้งลูกค้าไว้$/, 'No customer set'],
    [/^ไฟล์ต้องมีหัวคอลัมน์ “ทะเบียนรถ” และ “ลูกค้า”$/, 'The file needs the plate and customer columns'],
    [/^ไฟล์ไม่มีรายการ$/, 'The file has no rows'],
    [/^อ่านไฟล์ไม่ได้$/, 'Could not read the file'],
    [/^เลือกลูกค้าก่อน$/, 'Choose a customer first'],
    [/^ตั้งลูกค้าของประตูแล้ว$/, 'Gate customer set'],
    [/^ทำรายการไม่สำเร็จ$/, 'The action failed'],
    [/^ประตู (\d+) ยังตั้งค่าไม่ตรงกับระบบนี้$/, 'Gate $1 is not set up for this system'],
    [/^อ่านล่าสุด (.+)$/, 'Last read $1'],
    [/^ต้องตรวจ · (\d+) ใบ$/, 'To review · $1'],
    [/^ส่งแล้ว (\d+) ใบ$/, 'Shipped $1'],
    [/^ตอนนี้ตั้งไว้: (.+) \(ถึง (.+)\)$/, 'Set now: $1 (until $2)'],
    [/^นำเข้าแล้ว (\d+) รายการ$/, 'Imported: $1'],
    [/^ข้าม (\d+) แถว$/, 'Skipped rows: $1'],
    [/^แถว (\d+): ไม่พบลูกค้า (.*)$/, 'Row $1: customer not found $2'],
    [/^แถว (\d+): ไม่มีทะเบียนรถ$/, 'Row $1: no license plate'],
    [/^แถว (\d+): วันที่ไม่ถูกต้อง (.*)$/, 'Row $1: invalid date $2'],
  ];
  window.GateView = { mismatch: mismatch, lockReason: lockReason, readiness: readiness, passages: passages, planRows: planRows, presetView: presetView, warehouseLabel: warehouseLabel, en: en };
})();
