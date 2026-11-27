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

  /* English for the page translator: whole texts of the gate page. */
  var en = [
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
  window.GateView = { mismatch: mismatch, passages: passages, planRows: planRows, en: en };
})();
